// Interview Integrity Agent — single-binary build.
//
// Why this exists: a browser cannot enumerate processes or windows, so the only
// way to see a tool like Cluely is native code on the candidate's machine. This
// is that code, with no installer, no runtime and no third-party dependencies:
// one executable the candidate downloads and double-clicks.
//
// It is deliberately NOT stealthy. It shows a consent page before doing
// anything, reports metadata only, and stops when the interview ends.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

//go:embed detectors/*
var detectorFS embed.FS

//go:embed consent.html
var consentHTML []byte

const (
	scanInterval   = 20 * time.Second
	heartbeatEvery = 10 * time.Second
	scanTimeout    = 90 * time.Second
	httpTimeout    = 15 * time.Second
)

// Baked in at build time with -ldflags. A candidate double-clicking the
// downloaded binary has no environment variables, so a build that relies on
// BACKEND_URL being set would quietly talk to localhost, deliver nothing, and
// leave the dashboard reading exactly like a clean machine. Build with:
//
//	go build -ldflags="-X main.defaultBackendURL=https://api.example.com //	                   -X main.defaultSecret=<webhook secret>" .
//
// Environment variables still override, for local development.
var (
	defaultBackendURL = "http://localhost:4000"
	defaultSecret     = "change-me-webhook"
)

type config struct {
	backendURL string
	secret     string
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// warnIfUnconfigured makes a misbuilt binary say so on startup instead of
// failing silently in front of a candidate.
func (c config) warnIfUnconfigured() {
	if strings.Contains(c.backendURL, "localhost") || strings.Contains(c.backendURL, "127.0.0.1") {
		log.Printf("WARNING: talking to %s — this build was not configured for a deployed server", c.backendURL)
	}
	if c.secret == "change-me-webhook" {
		log.Printf("WARNING: using the placeholder webhook secret — the server will reject everything")
	}
}

// ── signed transport ────────────────────────────────────────────────────────

func (c config) post(path string, payload any) (int, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	mac := hmac.New(sha256.New, []byte(c.secret))
	mac.Write(body)

	req, err := http.NewRequest("POST", c.backendURL+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-detection-signature", hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("x-detection-provider", "first-party")

	res, err := (&http.Client{Timeout: httpTimeout}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, out, nil
}

// loadSignatures pulls the live list. Falling back silently would mean most
// known tools go unchecked, so the fallback is always logged.
func (c config) loadSignatures() []Signature {
	req, err := http.NewRequest("GET", c.backendURL+"/api/detection/signatures", nil)
	if err == nil {
		req.Header.Set("x-detection-secret", c.secret)
		res, err := (&http.Client{Timeout: httpTimeout}).Do(req)
		if err == nil {
			defer res.Body.Close()
			if res.StatusCode == 200 {
				var sigs []Signature
				if json.NewDecoder(res.Body).Decode(&sigs) == nil && len(sigs) > 0 {
					log.Printf("loaded %d detection signatures", len(sigs))
					return sigs
				}
			} else {
				log.Printf("signature fetch returned %d — using built-in defaults", res.StatusCode)
				return DefaultSignatures
			}
		}
	}
	log.Printf("signature fetch failed — using %d built-in defaults", len(DefaultSignatures))
	return DefaultSignatures
}

// ── OS scan ─────────────────────────────────────────────────────────────────

// extractDetector writes the embedded platform script to a temp file. Embedding
// keeps the whole agent a single downloadable file.
func extractDetector() (string, error) {
	name := "win-detect.ps1"
	if runtime.GOOS == "darwin" {
		name = "mac-detect.sh"
	}
	data, err := detectorFS.ReadFile("detectors/" + name)
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "iia-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o700); err != nil {
		return "", err
	}
	return path, nil
}

func runScan(scriptPath string) (RawScan, error) {
	var scan RawScan
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	case "darwin":
		cmd = exec.Command("bash", scriptPath)
	default:
		return scan, fmt.Errorf("unsupported platform %s", runtime.GOOS)
	}

	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Start(); err != nil {
		return scan, err
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return scan, err
		}
	case <-time.After(scanTimeout):
		_ = cmd.Process.Kill()
		return scan, fmt.Errorf("scan timed out after %s", scanTimeout)
	}

	if err := json.Unmarshal(stdout.Bytes(), &scan); err != nil {
		return scan, fmt.Errorf("unparseable scan output: %w", err)
	}
	return scan, nil
}

// ── monitoring ──────────────────────────────────────────────────────────────

type agent struct {
	cfg        config
	sessionID  string
	signatures []Signature
	script     string
}

func (a *agent) reportDetection(sig Signal) {
	sig.SessionID = a.sessionID
	status, body, err := a.cfg.post("/api/webhook/detection", sig)
	if err != nil {
		log.Printf("detection not delivered: %v", err)
		return
	}
	if status != 200 {
		log.Printf("detection rejected (%d): %s", status, body)
	}
}

// joinSession doubles as the session-id validator: the backend answers 404 for
// an id that does not exist, which is how a mistyped id gets caught at the
// consent screen instead of leaving the agent monitoring nothing all interview.
func (c config) joinSession(sessionID string) (string, error) {
	status, body, err := c.post("/api/webhook/agent/join", map[string]any{
		"sessionId": sessionID,
		"meta":      map[string]any{"platform": runtime.GOOS, "agent": "go"},
	})
	if err != nil {
		return "", fmt.Errorf("cannot reach the interview server: %w", err)
	}
	switch status {
	case 200:
		var out struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal(body, &out)
		return out.Status, nil
	case 404:
		return "", fmt.Errorf("no interview session with that ID — check it and try again")
	case 401:
		return "", fmt.Errorf("this agent build is not accepted by the server")
	default:
		return "", fmt.Errorf("server refused the session (%d)", status)
	}
}

// The agent lifecycle endpoints return the session status, so the heartbeat
// doubles as the shutdown signal — no second channel needed.
func (a *agent) ping(path string) string {
	status, body, err := a.cfg.post(path, map[string]any{
		"sessionId": a.sessionID,
		"meta":      map[string]any{"platform": runtime.GOOS, "agent": "go"},
	})
	if err != nil {
		log.Printf("%s failed: %v", path, err)
		return ""
	}
	if status != 200 {
		log.Printf("%s returned %d: %s", path, status, body)
		return ""
	}
	var out struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(body, &out)
	return out.Status
}

func finished(status string) bool {
	return status == "TERMINATED" || status == "COMPLETED"
}

func (a *agent) run(stop <-chan os.Signal) {
	log.Printf("monitoring session %s", a.sessionID)

	scanTick := time.NewTicker(scanInterval)
	beatTick := time.NewTicker(heartbeatEvery)
	defer scanTick.Stop()
	defer beatTick.Stop()

	scanning := make(chan struct{}, 1)
	doScan := func() {
		// A scan can outlast the interval; overlapping them would stack
		// PowerShell processes until the machine crawls.
		select {
		case scanning <- struct{}{}:
			defer func() { <-scanning }()
		default:
			return
		}

		scan, err := runScan(a.script)
		if err != nil {
			log.Printf("scan failed: %v", err)
			return
		}
		signals := MatchScan(scan, a.signatures)
		log.Printf("scan: %d processes, %d capture-excluded — %s",
			len(scan.Processes), len(scan.CaptureExcludedWindows), summarize(signals))
		for _, s := range signals {
			a.reportDetection(s)
		}
	}

	go doScan()
	for {
		select {
		case <-stop:
			log.Println("stopping — leaving session")
			a.ping("/api/webhook/agent/leave")
			return
		case <-scanTick.C:
			go doScan()
		case <-beatTick.C:
			if status := a.ping("/api/webhook/agent/heartbeat"); finished(status) {
				log.Printf("session %s — stopping", status)
				a.ping("/api/webhook/agent/leave")
				return
			}
		}
	}
}

// ── consent UI ──────────────────────────────────────────────────────────────

// The consent page is served on loopback and opened in the candidate's own
// browser, so the agent needs no bundled UI toolkit at all.
func askConsent(cfg config) (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer listener.Close()

	type result struct {
		sessionID string
		err       error
	}
	done := make(chan result, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Write(consentHTML)
	})
	mux.HandleFunc("/consent", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SessionID string `json:"sessionId"`
			Consented bool   `json:"consented"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionID == "" || !body.Consented {
			http.Error(w, "session id and consent are both required", http.StatusBadRequest)
			return
		}
		// Validate here so a typo surfaces in the page the candidate is looking
		// at, and let them correct it rather than closing the form.
		status, err := cfg.joinSession(body.SessionID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if finished(status) {
			http.Error(w, "that interview has already ended", http.StatusBadRequest)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
		done <- result{sessionID: body.SessionID}
	})
	mux.HandleFunc("/decline", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
		done <- result{err: fmt.Errorf("consent declined")}
	})

	server := &http.Server{Handler: mux}
	go server.Serve(listener)
	defer server.Close()

	url := fmt.Sprintf("http://%s/", listener.Addr().String())
	fmt.Printf("\n  Consent page: %s\n  (opening in your browser)\n\n", url)
	openBrowser(url)

	r := <-done
	time.Sleep(300 * time.Millisecond) // let the response flush before shutdown
	return r.sessionID, r.err
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("could not open a browser automatically — open the link above manually")
	}
}

// ── entrypoint ──────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.Ltime)
	cfg := config{
		backendURL: strings.TrimRight(env("BACKEND_URL", defaultBackendURL), "/"),
		secret:     env("DETECTION_WEBHOOK_SECRET", defaultSecret),
	}
	cfg.warnIfUnconfigured()

	fmt.Println("Interview Integrity Agent")
	fmt.Println("This agent is visible by design. It reports metadata only, starts")
	fmt.Println("only after you consent, and stops when the interview ends.")

	sessionID := os.Getenv("SESSION_ID")
	if sessionID == "" {
		var err error
		sessionID, err = askConsent(cfg)
		if err != nil {
			fmt.Println("\nConsent declined — exiting without monitoring.")
			return
		}
	} else if _, err := cfg.joinSession(sessionID); err != nil {
		log.Fatalf("cannot monitor SESSION_ID=%s: %v", sessionID, err)
	}

	script, err := extractDetector()
	if err != nil {
		log.Fatalf("could not prepare the detector for this platform: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(script))

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	a := &agent{cfg: cfg, sessionID: sessionID, signatures: cfg.loadSignatures(), script: script}
	a.run(stop)
	fmt.Println("Monitoring stopped.")
}

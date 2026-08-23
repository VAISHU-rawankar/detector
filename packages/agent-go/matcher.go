package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Port of packages/agent/src/detectors/matcher.ts. Turns a raw OS scan into
// normalized signals the backend webhook understands. Kept behaviourally
// identical so both agents produce the same evidence for the same machine.

type Signature struct {
	ID            string `json:"id"`
	ToolName      string `json:"toolName"`
	SignatureType string `json:"signatureType"`
	SignatureData string `json:"signatureData"`
	Confidence    int    `json:"confidence"`
}

type ExcludedWindow struct {
	Title       string `json:"title"`
	PID         int    `json:"pid"`
	Affinity    string `json:"affinity"`
	ProcessName string `json:"processName"`
	Path        string `json:"path"`
}

type ProcessInfo struct {
	Name        string `json:"name"`
	PID         int    `json:"pid"`
	WindowTitle string `json:"windowTitle"`
	Path        string `json:"path"`
	Signer      string `json:"signer"`
}

type AudioDevice struct {
	Name         string `json:"name"`
	Manufacturer string `json:"manufacturer"`
}

// MacWindow is the macOS fallback shape (no display-affinity flag available).
type MacWindow struct {
	Owner string `json:"owner"`
	Title string `json:"title"`
}

type RawScan struct {
	CaptureExcludedWindows []ExcludedWindow `json:"captureExcludedWindows"`
	Processes              []ProcessInfo    `json:"processes"`
	AudioDevices           []AudioDevice    `json:"audioDevices"`
	Windows                []MacWindow      `json:"windows"`
}

type Signal struct {
	SessionID   string         `json:"sessionId"`
	Method      string         `json:"method"`
	ToolName    *string        `json:"toolName"`
	Confidence  int            `json:"confidence"`
	Evidence    map[string]any `json:"evidence"`
	SignatureID *string        `json:"signatureId"`
}

// compile mirrors the TS helper: patterns carry an inline (?i) flag, which Go's
// regexp understands natively, so it only needs to survive a bad pattern.
func compile(pattern string) *regexp.Regexp {
	rx, err := regexp.Compile(pattern)
	if err != nil {
		return nil
	}
	return rx
}

func matches(pattern, value string) bool {
	if value == "" {
		return false
	}
	rx := compile(pattern)
	return rx != nil && rx.MatchString(value)
}

func strPtr(s string) *string { return &s }

func MatchScan(scan RawScan, signatures []Signature) []Signal {
	var signals []Signal

	// 1. Capture-excluded windows — strongest signal, fires with or without a
	// name match. Hiding from screen capture mid-interview has no innocent use.
	for _, w := range scan.CaptureExcludedWindows {
		var toolName *string
		confidence := 85
		for _, s := range signatures {
			hit := (s.SignatureType == "WINDOW_TITLE" && matches(s.SignatureData, w.Title)) ||
				(s.SignatureType == "PROCESS_NAME" && matches(s.SignatureData, w.ProcessName))
			if hit {
				toolName = strPtr(s.ToolName)
				if s.Confidence+10 > confidence {
					confidence = s.Confidence + 10
				}
			}
		}
		if confidence > 98 {
			confidence = 98
		}
		signals = append(signals, Signal{
			Method:     "CAPTURE_EXCLUDED_WINDOW",
			ToolName:   toolName,
			Confidence: confidence,
			Evidence: map[string]any{
				"windowTitle": w.Title,
				"processName": w.ProcessName,
				"path":        w.Path,
				"note":        "Window excluded from screen capture",
			},
		})
	}

	// 2. Process signatures — name, window title, or Authenticode signer.
	for _, p := range scan.Processes {
		for _, s := range signatures {
			hit := (s.SignatureType == "PROCESS_NAME" && matches(s.SignatureData, p.Name)) ||
				(s.SignatureType == "WINDOW_TITLE" && matches(s.SignatureData, p.WindowTitle)) ||
				(s.SignatureType == "CODE_SIGNER" && matches(s.SignatureData, p.Signer))
			if !hit {
				continue
			}
			sigID := s.ID
			signals = append(signals, Signal{
				Method:     "PROCESS_SIGNATURE",
				ToolName:   strPtr(s.ToolName),
				Confidence: s.Confidence,
				Evidence: map[string]any{
					"processName": p.Name,
					"windowTitle": p.WindowTitle,
					"signer":      p.Signer,
					"matchedOn":   s.SignatureType,
				},
				SignatureID: &sigID,
			})
		}
	}

	// macOS window fallback.
	for _, w := range scan.Windows {
		for _, s := range signatures {
			if s.SignatureType != "WINDOW_TITLE" && s.SignatureType != "PROCESS_NAME" {
				continue
			}
			if !matches(s.SignatureData, w.Title) && !matches(s.SignatureData, w.Owner) {
				continue
			}
			sigID := s.ID
			signals = append(signals, Signal{
				Method:     "PROCESS_SIGNATURE",
				ToolName:   strPtr(s.ToolName),
				Confidence: s.Confidence,
				Evidence: map[string]any{
					"owner":       w.Owner,
					"windowTitle": w.Title,
					"matchedOn":   s.SignatureType,
				},
				SignatureID: &sigID,
			})
		}
	}

	// 3. Virtual / loopback audio devices.
	for _, d := range scan.AudioDevices {
		for _, s := range signatures {
			if s.SignatureType == "AUDIO_DEVICE" && matches(s.SignatureData, d.Name) {
				sigID := s.ID
				signals = append(signals, Signal{
					Method:      "AUDIO_LOOPBACK",
					ToolName:    strPtr(s.ToolName),
					Confidence:  s.Confidence,
					Evidence:    map[string]any{"audioDevice": d.Name},
					SignatureID: &sigID,
				})
			}
		}
	}

	return dedupe(signals)
}

// dedupe drops identical signals produced within a single scan.
func dedupe(signals []Signal) []Signal {
	seen := make(map[string]bool, len(signals))
	out := make([]Signal, 0, len(signals))
	for _, s := range signals {
		evidence, _ := json.Marshal(s.Evidence)
		tool := ""
		if s.ToolName != nil {
			tool = *s.ToolName
		}
		key := fmt.Sprintf("%s|%s|%s", s.Method, tool, string(evidence))
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, s)
	}
	return out
}

// DefaultSignatures is the offline fallback when the backend is unreachable.
// The real list lives server-side so it can be updated without a new release.
var DefaultSignatures = []Signature{
	{ToolName: "Cluely", SignatureType: "PROCESS_NAME", SignatureData: "(?i)cluely", Confidence: 60},
	{ToolName: "Cluely", SignatureType: "WINDOW_TITLE", SignatureData: "(?i)cluely", Confidence: 65},
	{ToolName: "Cluely", SignatureType: "CODE_SIGNER", SignatureData: "(?i)cluely", Confidence: 80},
	{ToolName: "Parakeet", SignatureType: "PROCESS_NAME", SignatureData: "(?i)parakeet", Confidence: 60},
	{ToolName: "Final Round", SignatureType: "PROCESS_NAME", SignatureData: "(?i)final ?round", Confidence: 60},
	{ToolName: "Interview Coder", SignatureType: "PROCESS_NAME", SignatureData: "(?i)interview ?coder", Confidence: 60},
	{ToolName: "LockedIn AI", SignatureType: "PROCESS_NAME", SignatureData: "(?i)lockedin", Confidence: 60},
}

func summarize(signals []Signal) string {
	if len(signals) == 0 {
		return "no AI-tool signals"
	}
	parts := make([]string, 0, len(signals))
	for _, s := range signals {
		tool := "unattributed"
		if s.ToolName != nil {
			tool = *s.ToolName
		}
		parts = append(parts, fmt.Sprintf("%s %d%%", tool, s.Confidence))
	}
	return strings.Join(parts, ", ")
}

# Interview Integrity Agent (Go)

Single-binary replacement for `packages/agent` (Electron). Same detectors, same
signature matching, same signed webhook — but ~7 MB instead of ~200 MB, with no
installer and no runtime to install.

## Why an agent is needed at all

A browser cannot enumerate processes or windows. That is a security boundary,
not a missing feature. Worse, the strongest signal — a window using
`WDA_EXCLUDEFROMCAPTURE` to hide itself from screen capture — is *by definition*
invisible to `getDisplayMedia`, so no amount of screen-share analysis can find
it. Only native code on the candidate's machine can.

## What it reports

| Signal | Source |
|---|---|
| Windows hidden from screen capture | `GetWindowDisplayAffinity` |
| Process name / window title / Authenticode signer | `Get-Process`, `Get-AuthenticodeSignature` |
| Virtual & loopback audio devices | `Win32_SoundDevice` |

Metadata only. No screen recording, no keystrokes, no file or browsing access.

## What it does NOT do

It is not stealthy, and that is deliberate: it prints what it is doing, requires
consent before its first scan, and stops when the interview ends.

## Build

```bash
cd packages/agent-go
go build -ldflags="-s -w" -o interview-integrity-agent.exe .     # Windows
GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o agent-mac .  # macOS
```

No `go get` step — the module has zero third-party dependencies, so the whole
build is the Go standard library. The detector scripts are embedded with
`//go:embed`, which is what keeps the result a single downloadable file.

## Run

```bash
BACKEND_URL=http://localhost:4000 \
DETECTION_WEBHOOK_SECRET=<same secret as the backend> \
./interview-integrity-agent.exe
```

A consent page opens in the candidate's own browser (served on `127.0.0.1` on a
random port) — that is why no UI toolkit is bundled. They paste the session ID,
tick consent, and monitoring starts. The ID is validated against the backend
before the form is accepted, so a typo is caught immediately.

Set `SESSION_ID` to skip the consent page. That is for automated testing only —
never for a real interview, where consent must be recorded.

## How it talks to the backend

Everything is HMAC-SHA256 signed with `DETECTION_WEBHOOK_SECRET`:

| Endpoint | Purpose |
|---|---|
| `GET /api/detection/signatures` | Live signature list (`x-detection-secret` header) |
| `POST /api/webhook/agent/join` | Register, and validate the session ID |
| `POST /api/webhook/agent/heartbeat` | Liveness; the response carries session status |
| `POST /api/webhook/agent/leave` | Clean shutdown |
| `POST /api/webhook/detection` | One signed detection |

The Electron agent uses Socket.IO for the lifecycle calls; this one uses signed
HTTP so it needs no Socket.IO client. Both land on the same `agentPresence`
service, so the dashboard cannot tell which agent is connected.

The heartbeat response doubles as the shutdown signal — when the session becomes
`TERMINATED` or `COMPLETED`, the agent leaves and exits on its own.

Signatures live server-side and are fetched at start, so the list can be updated
without shipping a new agent. If the fetch fails the agent falls back to a small
built-in set and **logs that it did** — silently running on defaults would mean
most known tools go unchecked while everything still looked healthy.

## Known limitations

- **The shared secret ships inside the binary.** Anyone who has the agent can
  extract it, forge detections, or download the signature list. Production needs
  a short-lived per-candidate token instead.
- **Unsigned builds trigger SmartScreen.** Code signing is required before real
  candidates will be able (or willing) to run this.
- **A renamed binary signed with a different certificate defeats signature
  matching.** Only the capture-excluded-window check survives that, and only if
  the tool uses that technique — some builds do not.
- **Linux is not implemented.** `runScan` returns an error there.

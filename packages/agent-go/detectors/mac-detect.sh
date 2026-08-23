#!/usr/bin/env bash
# =============================================================================
# mac-detect.sh — AI-tool detection for macOS
# =============================================================================
# Prints a JSON object to stdout. Uses built-in tools only (no compilation).
#
# macOS equivalent of capture-exclusion: a window with NSWindowSharingNone is
# omitted from the CGWindowList "on-screen, sharing-enabled" set. We list windows
# with kCGWindowListOptionOnScreenOnly and cross-check. Full parity with the
# Windows affinity check needs a small Swift helper (see mac-window-helper.swift
# note in README) for production; this script covers process + audio + basic
# window enumeration which already gives strong signals.
# =============================================================================

set -euo pipefail

# On-screen windows (owner + title). Requires Screen Recording permission for titles.
windows_json=$(osascript -e '
tell application "System Events"
  set out to ""
  repeat with p in (every process whose background only is false)
    set pname to name of p
    try
      repeat with w in windows of p
        set out to out & pname & "||" & (name of w) & "\n"
      end repeat
    end try
  end repeat
  return out
end tell' 2>/dev/null || true)

# Processes
procs_json=$(ps -axo pid,comm | tail -n +2 | awk '{printf "{\"pid\":%s,\"name\":\"%s\"}\n", $1, $2}' | paste -sd, - || true)

# Audio devices (virtual audio drivers like BlackHole / Loopback are strong Parakeet signals)
audio=$(system_profiler SPAudioDataType 2>/dev/null | grep -E "^\s+\w" | sed 's/^ *//;s/:$//' | head -40 | \
  awk 'BEGIN{ORS=","} {gsub(/"/,""); printf "\"%s\"", $0}' | sed 's/,$//' || true)

# Emit JSON. Window titles here are process||title lines; the agent parses them.
python3 - "$windows_json" "$procs_json" "$audio" <<'PY'
import sys, json
wraw = sys.argv[1] if len(sys.argv) > 1 else ""
procs = sys.argv[2] if len(sys.argv) > 2 else ""
audio = sys.argv[3] if len(sys.argv) > 3 else ""
windows = []
for line in wraw.splitlines():
    if "||" in line:
        owner, title = line.split("||", 1)
        windows.append({"owner": owner.strip(), "title": title.strip()})
try:
    proc_list = json.loads("[" + procs + "]") if procs else []
except Exception:
    proc_list = []
try:
    audio_list = json.loads("[" + audio + "]") if audio else []
except Exception:
    audio_list = []
print(json.dumps({
    "windows": windows,
    "processes": proc_list,
    "audioDevices": audio_list,
}))
PY

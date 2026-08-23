#!/usr/bin/env bash
# Build distributable agents with the deployed backend baked in.
#
# The candidate double-clicks this binary with no environment set, so the URL
# and secret MUST be compiled in — otherwise the agent talks to localhost,
# delivers nothing, and the dashboard looks identical to a clean machine.
set -euo pipefail

: "${BACKEND_URL:?set BACKEND_URL, e.g. https://interview-api.onrender.com}"
: "${DETECTION_WEBHOOK_SECRET:?set DETECTION_WEBHOOK_SECRET (must match the backend)}"

LDFLAGS="-s -w -X main.defaultBackendURL=${BACKEND_URL} -X main.defaultSecret=${DETECTION_WEBHOOK_SECRET}"
OUT=${OUT:-dist}
mkdir -p "$OUT"

echo "baking backend: ${BACKEND_URL}"
GOOS=windows GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$OUT/interview-integrity-agent.exe" .
GOOS=darwin  GOARCH=arm64 go build -ldflags="$LDFLAGS" -o "$OUT/interview-integrity-agent-mac-arm64" .
GOOS=darwin  GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$OUT/interview-integrity-agent-mac-intel" .

echo
ls -lh "$OUT"
echo
echo "NOT SIGNED. Windows SmartScreen will warn, and macOS will refuse to open"
echo "these until they are signed and notarised."

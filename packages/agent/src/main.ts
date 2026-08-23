// Electron agent — consent-based interview integrity monitor.
// Design principles (non-negotiable):
//   • Runs ONLY after explicit candidate consent (agentConsent).
//   • Visible tray icon while running — NO stealth.
//   • Reports metadata only (window titles, process names, signers, audio devices).
//   • Stops completely when the interview ends (stop-monitoring / window close).
//
// It scans on an interval, matches against signatures, and POSTs any detections
// to the backend webhook (HMAC-signed), which the interviewer dashboard sees live.

import { app, BrowserWindow, Tray, Menu, ipcMain } from 'electron';
import { execFile } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { io as ioClient, Socket } from 'socket.io-client';
import { matchScan, RawScan, Signature } from './detectors/matcher';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const WEBHOOK_SECRET = process.env.DETECTION_WEBHOOK_SECRET || 'change-me-webhook';
// A full Windows scan (window enumeration + Authenticode over every distinct
// binary) takes roughly 15-20s on a normal machine. Polling faster than that
// just queues scans on top of each other.
const SCAN_INTERVAL_MS = 20000;
const SCAN_TIMEOUT_MS = 60000;

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let socket: Socket | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let sessionId: string | null = null;
let signatures: Signature[] | undefined;

// ── Run the platform-specific detector script and parse JSON ────────────────
function runScan(): Promise<RawScan> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script = path.join(__dirname, 'detectors', 'win-detect.ps1');
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { timeout: SCAN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          // Silently resolving {} here hides a broken detector as "nothing found",
          // which is indistinguishable from a clean machine. Say so instead.
          if (err) console.error('[agent] windows scan failed:', err.message);
          try { resolve(JSON.parse(stdout || '{}')); }
          catch (e) { console.error('[agent] windows scan returned unparseable output'); resolve({}); }
        }
      );
    } else if (process.platform === 'darwin') {
      const script = path.join(__dirname, 'detectors', 'mac-detect.sh');
      execFile('bash', [script], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) console.error('[agent] macos scan failed:', err.message);
        try { resolve(JSON.parse(stdout || '{}')); }
        catch { console.error('[agent] macos scan returned unparseable output'); resolve({}); }
      });
    } else {
      resolve({}); // Linux: process/window enumeration path can be added similarly.
    }
  });
}

// ── Fetch the live signature list from the backend ──────────────────────────
// Kept server-side so the list can be updated without shipping a new agent.
// On failure we fall back to matcher.ts's small inlined default set, but say so —
// silently running on the defaults means most known tools go unchecked.
async function loadSignatures(): Promise<Signature[] | undefined> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/detection/signatures`, {
      headers: { 'x-detection-secret': WEBHOOK_SECRET },
    });
    if (!res.ok) {
      console.error(`[agent] could not load signatures (${res.status}) — using built-in defaults`);
      return undefined;
    }
    const list = (await res.json()) as Signature[];
    console.log(`[agent] loaded ${list.length} detection signatures`);
    return list;
  } catch (e: any) {
    console.error('[agent] could not load signatures:', e?.message, '— using built-in defaults');
    return undefined;
  }
}

// ── POST a signed detection to the backend webhook ──────────────────────────
async function reportDetection(signal: any) {
  const body = JSON.stringify({ sessionId, ...signal });
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  try {
    const res = await fetch(`${BACKEND_URL}/api/webhook/detection`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-detection-signature': signature,
        'x-detection-provider': 'first-party',
      },
      body,
    });
    if (!res.ok) {
      console.error(`[agent] detection rejected (${res.status}):`, await res.text().catch(() => ''));
    }
  } catch (e: any) {
    console.error('[agent] detection not delivered:', e?.message);
    /* offline: could queue and retry */
  }
}

let scanInFlight = false;

async function scanLoop() {
  if (!sessionId) return;
  // A scan can outlast the interval; overlapping them would stack PowerShell
  // processes until the machine crawls.
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const raw = await runScan();
    const signals = matchScan(raw, signatures);
    for (const s of signals) await reportDetection(s);
  } finally {
    scanInFlight = false;
  }
}

// ── Start monitoring after consent ──────────────────────────────────────────
function startMonitoring(sid: string) {
  sessionId = sid;
  socket = ioClient(BACKEND_URL);
  socket.on('connect', () => socket?.emit('agent-join', { sessionId: sid }));
  socket.on('stop-monitoring', stopMonitoring);

  scanTimer = setInterval(scanLoop, SCAN_INTERVAL_MS);
  heartbeatTimer = setInterval(() => socket?.emit('agent-heartbeat', { sessionId: sid }), 8000);
  updateTray('Monitoring active');
}

function stopMonitoring() {
  if (scanTimer) clearInterval(scanTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  socket?.disconnect();
  sessionId = null;
  updateTray('Idle — not monitoring');
}

function updateTray(status: string) {
  if (!tray) return;
  tray.setToolTip(`Interview Integrity Agent — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Stop monitoring & quit', click: () => { stopMonitoring(); app.quit(); } },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 560, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'consent.html'));
}

app.whenReady().then(() => {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  updateTray('Idle — not monitoring');
  createWindow();

  // Consent screen calls this once the candidate ticks the box and enters session id.
  ipcMain.handle('give-consent', async (_e, sid: string) => {
    signatures = await loadSignatures();
    startMonitoring(sid);
    win?.hide();
    return { ok: true, platform: os.platform() };
  });
  ipcMain.handle('decline-consent', async () => { app.quit(); });
});

app.on('before-quit', stopMonitoring);
app.on('window-all-closed', () => { /* keep alive in tray */ });

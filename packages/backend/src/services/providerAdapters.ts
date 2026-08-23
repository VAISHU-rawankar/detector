// Adapters translate each provider's raw payload into a NormalizedSignal.
// This is the layer that makes the platform provider-agnostic: swap or add a
// vendor here without touching the risk engine, DB, or dashboard.

import type { NormalizedSignal } from './detectionService';

// ── Provider 1: OUR OWN Electron agent (packages/agent) ───────────────────
// Our agent already speaks the normalized contract, so this is nearly pass-through.
export function fromFirstPartyAgent(sessionId: string, raw: any): NormalizedSignal {
  return {
    sessionId,
    method: raw.method,
    toolName: raw.toolName ?? null,
    confidence: raw.confidence ?? 70,
    evidence: raw.evidence ?? {},
    signatureId: raw.signatureId ?? null,
  };
}

// ── Provider 2: third-party vendor webhook (InterviewGuard / Zero Assist style) ──
//
// IMPORTANT / HONEST NOTE:
//   The exact field names below are PLACEHOLDERS modelled on the generic
//   "AI_TOOL_DETECTED" webhook pattern those vendors describe publicly.
//   Their real enterprise API contract (auth header, field names, signature
//   scheme) is provided in their docs after you sign an enterprise agreement.
//   When you get those docs, adjust ONLY the mapping in this function.
//
// Typical vendor payload shape (assumed):
//   {
//     "event": "AI_TOOL_DETECTED",
//     "session_id": "...",
//     "tool": "Cluely",
//     "detection_type": "process_signature" | "overlay" | "audio",
//     "confidence": 0.91,                // 0..1
//     "details": { "process_name": "...", "window_title": "...", "signer": "..." }
//   }
export function fromVendorWebhook(raw: any): NormalizedSignal | null {
  if (raw?.event !== 'AI_TOOL_DETECTED') return null;

  const methodMap: Record<string, NormalizedSignal['method']> = {
    process_signature: 'PROCESS_SIGNATURE',
    overlay: 'CAPTURE_EXCLUDED_WINDOW',
    capture_excluded: 'CAPTURE_EXCLUDED_WINDOW',
    audio: 'AUDIO_LOOPBACK',
    hotkey: 'GLOBAL_HOTKEY',
    screen_ui: 'SCREEN_UI',
  };

  return {
    sessionId: raw.session_id,
    method: methodMap[raw.detection_type] ?? 'PROCESS_SIGNATURE',
    toolName: raw.tool ?? null,
    // vendor confidence is usually 0..1 → scale to 0..100
    confidence: Math.round((raw.confidence ?? 0.7) * 100),
    evidence: raw.details ?? {},
  };
}

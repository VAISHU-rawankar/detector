// Risk engine: converts accumulated events into a score + level.
// Weights are configurable (could be loaded from SystemSetting per company).

export const DEFAULT_WEIGHTS: Record<string, number> = {
  TAB_SWITCH: 10,
  WINDOW_BLUR: 3,
  COPY: 5,
  PASTE: 10,
  CUT: 5,
  FULLSCREEN_EXIT: 15,
  SCREEN_SHARE_STOPPED: 30,
  CAMERA_OFF: 15,
  MIC_OFF: 10,
  PASTE_BURST: 20,
  ANSWER_LATENCY_ANOMALY: 15,
  // A low-confidence tool match (e.g. a browser tab merely titled "Gemini").
  // Corroborating evidence only — deliberately NOT a strong AI signal, so it can
  // never on its own produce an "AI assistance" verdict.
  WEAK_AI_TOOL_HINT: 8,
  AGENT_DISCONNECTED: 25,
  AGENT_HEARTBEAT_MISSED: 15,
  // Another person visible in the candidate's camera. Serious, but a different
  // category from AI tooling — it must not unlock the "AI assistance" wording,
  // so it is weighted at the ceiling for a non-AI signal instead.
  MULTIPLE_FACES: 35,
  NO_FACE_DETECTED: 10,

  // AI-assistance detections (the important ones)
  SUSPICIOUS_AI_UI: 30,        // SCREEN_UI method
  KNOWN_AI_TOOL_SIGNAL: 40,    // PROCESS_SIGNATURE / AUDIO_LOOPBACK match
  CAPTURE_EXCLUDED_WINDOW: 45, // strongest single signal
};

export type RiskLevel = 'NORMAL' | 'SUSPICIOUS' | 'HIGH_RISK' | 'CRITICAL';

export function levelForScore(score: number): RiskLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH_RISK';
  if (score >= 30) return 'SUSPICIOUS';
  return 'NORMAL';
}

// Human-facing status label. Never say "confirmed cheating" from score alone —
// only a human evaluation (InterviewEvaluation) can assert a policy violation.
export function statusLabel(level: RiskLevel, hasStrongAiSignal: boolean): string {
  if (level === 'CRITICAL' && hasStrongAiSignal) return 'POSSIBLE AI ASSISTANCE — HIGH RISK';
  if (level === 'CRITICAL') return 'HIGH RISK';
  if (level === 'HIGH_RISK' && hasStrongAiSignal) return 'POSSIBLE AI ASSISTANCE';
  if (level === 'HIGH_RISK') return 'HIGH RISK';
  if (level === 'SUSPICIOUS') return 'SUSPICIOUS ACTIVITY';
  return 'NORMAL';
}

export interface WeightedItem {
  key: string;   // maps to a weight
  count: number;
}

// Diminishing returns so a spammy-but-harmless signal can't alone reach CRITICAL.
// First occurrence full weight; each subsequent occurrence decays.
function cappedContribution(weight: number, count: number, cap: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += weight * Math.pow(0.6, i);
  return Math.min(Math.round(total), cap);
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  breakdown: Record<string, number>;
  hasStrongAiSignal: boolean;
}

// perKeyCap prevents any single signal type from dominating unless it's a strong AI signal.
export function computeRisk(
  items: WeightedItem[],
  weights: Record<string, number> = DEFAULT_WEIGHTS
): RiskResult {
  const breakdown: Record<string, number> = {};
  const strongKeys = new Set(['KNOWN_AI_TOOL_SIGNAL', 'CAPTURE_EXCLUDED_WINDOW', 'SUSPICIOUS_AI_UI']);
  let hasStrongAiSignal = false;

  for (const { key, count } of items) {
    if (count <= 0) continue;
    const weight = weights[key] ?? 0;
    if (weight === 0) continue;
    const cap = strongKeys.has(key) ? 100 : 35; // weak signals capped at 35 total
    const contribution = cappedContribution(weight, count, cap);
    breakdown[key] = contribution;
    if (strongKeys.has(key)) hasStrongAiSignal = true;
  }

  const score = Math.min(
    Object.values(breakdown).reduce((a, b) => a + b, 0),
    100
  );

  return { score, level: levelForScore(score), breakdown, hasStrongAiSignal };
}

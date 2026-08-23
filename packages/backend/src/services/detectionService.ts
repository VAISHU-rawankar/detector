import crypto from 'crypto';
import { InterviewSession, DetectionEvent, InterviewEvent, RiskScore } from '../models';
import { computeRisk, statusLabel, WeightedItem, DEFAULT_WEIGHTS } from './riskEngine';
import type { Server } from 'socket.io';

// A normalized detection signal. Every provider (our agent, a 3rd-party vendor
// webhook, or the AI frame service) is adapted into THIS shape before ingest.
export interface NormalizedSignal {
  sessionId: string;
  method:
    | 'CAPTURE_EXCLUDED_WINDOW'
    | 'PROCESS_SIGNATURE'
    | 'AUDIO_LOOPBACK'
    | 'GLOBAL_HOTKEY'
    | 'SCREEN_UI'
    | 'BEHAVIORAL_CORRELATION';
  toolName?: string | null;
  confidence: number;
  evidence: Record<string, unknown>;
  signatureId?: string | null;
}

// Below this, a signature match is treated as a hint rather than proof.
// The seeded signature list separates cleanly at this line: a process actually
// named after a tool, or a matching code signer, sits at 55-80; a guess made
// purely from a browser tab title ("ChatGPT" 40, "Gemini" 35, "Claude" 35) sits
// below it. Without this split every match — however weak — unlocked the
// "POSSIBLE AI ASSISTANCE" label, so an open documentation tab read the same as
// a caught tool.
export const STRONG_SIGNAL_MIN_CONFIDENCE = 50;

function weightKeyForMethod(method: NormalizedSignal['method'], strong: boolean): string {
  switch (method) {
    // Hiding a window from screen capture has no innocent explanation
    // mid-interview, so it stands on its own regardless of attribution.
    case 'CAPTURE_EXCLUDED_WINDOW': return 'CAPTURE_EXCLUDED_WINDOW';
    case 'PROCESS_SIGNATURE':
    case 'AUDIO_LOOPBACK':
    case 'GLOBAL_HOTKEY':           return strong ? 'KNOWN_AI_TOOL_SIGNAL' : 'WEAK_AI_TOOL_HINT';
    case 'SCREEN_UI':               return strong ? 'SUSPICIOUS_AI_UI' : 'WEAK_AI_TOOL_HINT';
    case 'BEHAVIORAL_CORRELATION':  return 'ANSWER_LATENCY_ANOMALY';
  }
}

// Compute the current risk for a session from ALL its events + detections,
// WITHOUT persisting a snapshot. Use this for read-only queries (e.g. dashboard
// hydration) so that merely looking at a session does not write history.
export async function evaluateRisk(sessionId: string) {
  const [events, detections] = await Promise.all([
    InterviewEvent.aggregate([
      { $match: { session: toId(sessionId) } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]),
    // Group by method AND confidence tier — collapsing on method alone threw the
    // confidence away, so a 35% guess scored exactly like an 80% signer match.
    DetectionEvent.aggregate([
      { $match: { session: toId(sessionId) } },
      {
        $group: {
          _id: {
            method: '$method',
            strong: { $gte: ['$confidence', STRONG_SIGNAL_MIN_CONFIDENCE] },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const items: WeightedItem[] = [];
  for (const e of events) items.push({ key: e._id, count: e.count });
  for (const d of detections) {
    items.push({ key: weightKeyForMethod(d._id.method, d._id.strong), count: d.count });
  }

  return computeRisk(items, DEFAULT_WEIGHTS);
}

// Recompute the full risk score for a session and persist a snapshot.
export async function recomputeRisk(sessionId: string) {
  const result = await evaluateRisk(sessionId);
  const snapshot = await RiskScore.create({
    session: sessionId, score: result.score, level: result.level, breakdown: result.breakdown,
  });
  return { snapshot, result };
}

import { Types } from 'mongoose';
function toId(id: string) { return new Types.ObjectId(id); }

// Order-independent serialisation so the same evidence always hashes the same.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function dedupeKeyFor(signal: NormalizedSignal): string {
  return crypto
    .createHash('sha1')
    .update(`${signal.method}|${signal.toolName ?? ''}|${stableStringify(signal.evidence)}`)
    .digest('hex');
}

export async function ingestDetection(io: Server, signal: NormalizedSignal) {
  const session = await InterviewSession.findById(signal.sessionId);
  if (!session) throw new Error('Unknown session');
  if (!['ACTIVE', 'PAUSED', 'CONSENTED'].includes(session.status as string)) return null;

  // Every provider rescans on a timer and re-reports whatever is still running.
  // Record each distinct finding once per session: re-broadcasting it would also
  // keep re-triggering auto-pause on evidence the interviewer already reviewed.
  const dedupeKey = dedupeKeyFor(signal);
  const existing = await DetectionEvent.findOne({ session: signal.sessionId, dedupeKey });
  if (existing) return existing;

  const detection = await DetectionEvent.create({
    session: signal.sessionId,
    method: signal.method,
    toolName: signal.toolName ?? null,
    confidence: Math.max(0, Math.min(100, signal.confidence)),
    evidence: signal.evidence,
    signature: signal.signatureId ?? null,
    dedupeKey,
  });

  const { snapshot, result } = await recomputeRisk(signal.sessionId);
  const room = `session:${signal.sessionId}`;
  io.to(room).emit('detection', {
    id: detection.id, method: detection.method, toolName: detection.toolName,
    confidence: detection.confidence, evidence: detection.evidence, occurredAt: detection.occurredAt,
  });
  io.to(room).emit('risk', {
    score: result.score, level: result.level,
    status: statusLabel(result.level, result.hasStrongAiSignal),
    breakdown: result.breakdown, hasStrongAiSignal: result.hasStrongAiSignal, at: (snapshot as any).createdAt,
  });

  if (result.level === 'CRITICAL' && result.hasStrongAiSignal && session.status === 'ACTIVE') {
    session.status = 'PAUSED';
    await session.save();
    io.to(room).emit('auto-pause', {
      reason: 'Strong AI-assistance signal reached CRITICAL. Interviewer confirmation required.',
    });
  }
  return detection;
}

import type { Server } from 'socket.io';
import { InterviewSession, InterviewEvent } from '../models';
import { recomputeRisk } from './detectionService';
import { statusLabel } from './riskEngine';

// Shared ingest path for behavioural events. Both the socket handler (browser
// events) and the signed event webhook (ai-service) funnel through here so a
// signal is scored and broadcast identically no matter which side reported it.
export async function persistAndBroadcast(
  io: Server,
  sessionId: string,
  type: string,
  source: string,
  payload: any,
) {
  const session = await InterviewSession.findById(sessionId);
  if (!session || !['ACTIVE', 'PAUSED', 'CONSENTED'].includes(session.status as string)) return null;

  const event = await InterviewEvent.create({ session: sessionId, type, source, payload });
  const { snapshot, result } = await recomputeRisk(sessionId);
  const room = `session:${sessionId}`;
  io.to(room).emit('event', { id: event.id, type, source, payload, occurredAt: event.occurredAt });
  io.to(room).emit('risk', {
    score: result.score,
    level: result.level,
    status: statusLabel(result.level, result.hasStrongAiSignal),
    breakdown: result.breakdown,
    hasStrongAiSignal: result.hasStrongAiSignal,
    at: (snapshot as any).createdAt,
  });
  return event;
}

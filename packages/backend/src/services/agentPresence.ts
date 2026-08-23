import type { Server } from 'socket.io';
import { InterviewSession } from '../models';
import { persistAndBroadcast } from './eventService';

// Agent liveness, shared by the Socket.IO path (Electron agent) and the signed
// HTTP path (the dependency-free Go agent). Both mark the same session field and
// emit the same events, so the dashboard cannot tell which agent is connected.
//
// A missed heartbeat matters: an agent that dies — or is killed by the candidate
// — must not look the same as a clean machine.
const HEARTBEAT_TIMEOUT_MS = 25000;
const timers = new Map<string, NodeJS.Timeout>();

export function resetHeartbeat(io: Server, sessionId: string) {
  const existing = timers.get(sessionId);
  if (existing) clearTimeout(existing);
  timers.set(
    sessionId,
    setTimeout(async () => {
      timers.delete(sessionId);
      const session = await InterviewSession.findById(sessionId);
      if (session && session.status === 'ACTIVE') {
        await InterviewSession.findByIdAndUpdate(sessionId, { agentConnected: false }).catch(() => {});
        await persistAndBroadcast(io, sessionId, 'AGENT_HEARTBEAT_MISSED', 'SYSTEM', {});
      }
    }, HEARTBEAT_TIMEOUT_MS),
  );
}

export function clearHeartbeat(sessionId: string) {
  const existing = timers.get(sessionId);
  if (existing) clearTimeout(existing);
  timers.delete(sessionId);
}

export async function agentJoined(io: Server, sessionId: string, meta: Record<string, unknown> = {}) {
  await InterviewSession.findByIdAndUpdate(sessionId, { agentConnected: true }).catch(() => {});
  const event = await persistAndBroadcast(io, sessionId, 'AGENT_CONNECTED', 'AGENT', meta);
  resetHeartbeat(io, sessionId);
  return event;
}

export async function agentLeft(io: Server, sessionId: string) {
  clearHeartbeat(sessionId);
  await InterviewSession.findByIdAndUpdate(sessionId, { agentConnected: false }).catch(() => {});
  return persistAndBroadcast(io, sessionId, 'AGENT_DISCONNECTED', 'AGENT', {});
}

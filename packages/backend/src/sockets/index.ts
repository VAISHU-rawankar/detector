import type { Server, Socket } from 'socket.io';
import { persistAndBroadcast } from '../services/eventService';
import { agentJoined, agentLeft, resetHeartbeat } from '../services/agentPresence';

const BROWSER_EVENTS = new Set([
  'TAB_SWITCH', 'WINDOW_BLUR', 'WINDOW_FOCUS', 'COPY', 'PASTE', 'CUT',
  'FULLSCREEN_EXIT', 'SCREEN_SHARE_STOPPED', 'CAMERA_OFF', 'MIC_OFF',
  'PASTE_BURST', 'ANSWER_LATENCY_ANOMALY',
]);

export function registerSockets(io: Server) {
  io.on('connection', (socket: Socket) => {
    socket.on('join-session', ({ sessionId, role }: { sessionId: string; role: string }) => {
      socket.join(`session:${sessionId}`);
      socket.data.sessionId = sessionId;
      socket.data.role = role;
    });

    socket.on('browser-event', async ({ sessionId, type, payload }) => {
      if (!BROWSER_EVENTS.has(type)) return;
      await persistAndBroadcast(io, sessionId, type, 'BROWSER', payload ?? {});
    });

    socket.on('agent-join', async ({ sessionId }) => {
      socket.join(`agent:${sessionId}`);
      socket.data.agentSessionId = sessionId;
      await agentJoined(io, sessionId);
    });

    socket.on('agent-heartbeat', ({ sessionId }) => resetHeartbeat(io, sessionId));

    socket.on('disconnect', async () => {
      const sid = socket.data.agentSessionId;
      if (sid) await agentLeft(io, sid);
    });
  });
}

import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../lib/api';

export interface Risk {
  score: number;
  level: string;
  status: string;
  breakdown: Record<string, number>;
  hasStrongAiSignal: boolean;
}
export interface Detection {
  id: string;
  method: string;
  toolName?: string;
  confidence: number;
  evidence: any;
  occurredAt: string;
}
export interface Evt {
  id: string;
  type: string;
  source: string;
  occurredAt: string;
}

const levelColour: Record<string, string> = {
  NORMAL: '#16a34a', SUSPICIOUS: '#ca8a04', HIGH_RISK: '#ea580c', CRITICAL: '#dc2626',
};

// Compact live view of what monitoring is picking up, for use next to the
// interview itself. It hydrates from history first, then follows the socket —
// without the initial fetch it would sit empty until the next event, which
// looks broken rather than quiet.
export function LiveMonitorPanel({ socket, sessionId }: { socket: Socket | null; sessionId: string }) {
  const [risk, setRisk] = useState<Risk>({
    score: 0, level: 'NORMAL', status: 'NORMAL', breakdown: {}, hasStrongAiSignal: false,
  });
  const [detections, setDetections] = useState<Detection[]>([]);
  const [events, setEvents] = useState<Evt[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<any>(`/api/sessions/${sessionId}/state`)
      .then((d) => {
        if (cancelled) return;
        setRisk(d.risk);
        setDetections(d.detections);
        setEvents(d.events);
      })
      .catch(() => { /* the panel is informational; a failed load must not block the interview */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (!socket) return;
    const onRisk = (r: Risk) => setRisk(r);
    const onDetection = (d: Detection) =>
      setDetections((prev) => [d, ...prev.filter((p) => p.id !== d.id)].slice(0, 20));
    const onEvent = (e: Evt) =>
      setEvents((prev) => [e, ...prev.filter((p) => p.id !== e.id)].slice(0, 20));

    socket.on('risk', onRisk);
    socket.on('detection', onDetection);
    socket.on('event', onEvent);
    return () => {
      socket.off('risk', onRisk);
      socket.off('detection', onDetection);
      socket.off('event', onEvent);
    };
  }, [socket]);

  const colour = levelColour[risk.level] ?? '#6b7280';
  const faces = events.filter((e) => e.type === 'MULTIPLE_FACES').length;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, background: '#fafafa' }}>
      <div style={{ fontSize: 12, color: '#6b7280', letterSpacing: 0.4 }}>LIVE MONITORING</div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
        <div style={{ fontSize: 40, fontWeight: 700, color: colour, lineHeight: 1 }}>{risk.score}</div>
        <div style={{ fontSize: 14, color: '#9ca3af' }}>/100</div>
      </div>
      <div style={{
        display: 'inline-block', marginTop: 8, padding: '3px 10px', borderRadius: 999,
        background: colour, color: '#fff', fontWeight: 600, fontSize: 12,
      }}>
        {risk.status}
      </div>

      {Object.keys(risk.breakdown).length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          {Object.entries(risk.breakdown).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', color: '#4b5563' }}>
              <span>{k}</span><b>+{v}</b>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600 }}>AI tools</div>
      {detections.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6b7280' }}>None detected.</div>
      ) : (
        detections.map((d) => (
          <div key={d.id} style={{ fontSize: 12, color: '#b91c1c' }}>
            <b>{d.toolName ?? 'Unknown tool'}</b> — {d.confidence}% · {d.method}
          </div>
        ))
      )}

      <div style={{ marginTop: 12, fontSize: 12, fontWeight: 600 }}>Camera</div>
      <div style={{ fontSize: 12, color: faces > 0 ? '#b91c1c' : '#6b7280' }}>
        {faces > 0 ? `Another person seen — ${faces}x` : 'Only you in frame.'}
      </div>

      <div style={{ marginTop: 12, fontSize: 12, fontWeight: 600 }}>Recent activity</div>
      <div style={{ maxHeight: 150, overflow: 'auto', fontSize: 12 }}>
        {events.length === 0 && <div style={{ color: '#6b7280' }}>Nothing recorded yet.</div>}
        {events.map((e) => (
          <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', color: '#4b5563', padding: '2px 0' }}>
            <span>{e.type}</span>
            <span style={{ color: '#9ca3af' }}>{new Date(e.occurredAt).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

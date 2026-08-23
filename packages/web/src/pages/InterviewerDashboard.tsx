import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Link } from 'react-router-dom';
import { api, BACKEND } from '../lib/api';


interface Risk { score: number; level: string; status: string; breakdown: Record<string, number>; hasStrongAiSignal: boolean; }
interface Detection { id: string; method: string; toolName?: string; confidence: number; evidence: any; occurredAt: string; }
interface Evt { id: string; type: string; source: string; occurredAt: string; }

const levelColor: Record<string, string> = {
  NORMAL: '#16a34a', SUSPICIOUS: '#ca8a04', HIGH_RISK: '#ea580c', CRITICAL: '#dc2626',
};

export default function InterviewerDashboard({ sessionId }: { sessionId: string }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [risk, setRisk] = useState<Risk>({ score: 0, level: 'NORMAL', status: 'NORMAL', breakdown: {}, hasStrongAiSignal: false });
  const [detections, setDetections] = useState<Detection[]>([]);
  const [events, setEvents] = useState<Evt[]>([]);
  const [autoPause, setAutoPause] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>('');
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [endedAt, setEndedAt] = useState<string | null>(null);

  // Hydrate from history first. The socket only delivers events that happen while
  // this tab is mounted, so without this the dashboard shows score 0 and an empty
  // feed after every reload — even mid-session.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api<any>(`/api/sessions/${sessionId}/state`)
      .then((data) => {
        if (cancelled) return;
        setRisk(data.risk);
        setDetections(data.detections);
        setEvents(data.events);
        setSessionStatus(data.status);
        setStartedAt(data.startedAt ?? null);
        setEndedAt(data.endedAt ?? null);
      })
      .catch((err) => console.error('Failed to load session state:', err));
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    const s = io(BACKEND);
    s.on('connect', () => s.emit('join-session', { sessionId, role: 'INTERVIEWER' }));
    s.on('risk', (r: Risk) => setRisk(r));
    // Live events can overlap what hydration already loaded — key on id so a
    // replayed event replaces rather than duplicates.
    s.on('detection', (d: Detection) => setDetections((prev) => [d, ...prev.filter((p) => p.id !== d.id)].slice(0, 50)));
    s.on('event', (e: Evt) => setEvents((prev) => [e, ...prev.filter((p) => p.id !== e.id)].slice(0, 50)));
    s.on('session-status', (p: { status: string }) => setSessionStatus(p.status));
    s.on('auto-pause', (p: { reason: string }) => setAutoPause(p.reason));
    setSocket(s);
    return () => { s.disconnect(); };
  }, [sessionId]);

  const control = async (action: string) => {
    try {
      await api(`/api/sessions/${sessionId}/control`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      if (action === 'resume') setAutoPause(null);
    } catch (err: any) {
      console.error('Control action failed:', err);
    }
  };

  // ── Report derivation ──────────────────────────────────────────────────────
  // A detection below this confidence is a hint, not proof. Mirrors
  // STRONG_SIGNAL_MIN_CONFIDENCE in the backend risk engine.
  const STRONG_MIN = 50;

  const toolSummary = Object.values(
    detections.reduce<Record<string, { tool: string; maxConfidence: number; count: number; methods: string[]; strong: boolean }>>(
      (acc, d) => {
        const tool = d.toolName ?? 'Unattributed';
        const entry = acc[tool] ?? { tool, maxConfidence: 0, count: 0, methods: [], strong: false };
        entry.count += 1;
        entry.maxConfidence = Math.max(entry.maxConfidence, d.confidence);
        entry.strong = entry.strong || d.confidence >= STRONG_MIN;
        if (!entry.methods.includes(d.method)) entry.methods.push(d.method);
        acc[tool] = entry;
        return acc;
      },
      {},
    ),
  ).sort((a, b) => b.maxConfidence - a.maxConfidence);

  const eventSummary = Object.entries(
    events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  const multipleFaces = events.filter((e) => e.type === 'MULTIPLE_FACES').length;
  const noFace = events.filter((e) => e.type === 'NO_FACE_DETECTED').length;

  const verdict = (() => {
    if (risk.hasStrongAiSignal) {
      return {
        headline: 'AI-assistance tool signals present',
        detail:
          'One or more known tools were positively identified while this session was being monitored. Review the evidence below before acting.',
      };
    }
    if (toolSummary.length > 0) {
      return {
        headline: 'Weak hints only — no tool confirmed',
        detail:
          'Something matched the signature list, but only at low confidence (for example a browser tab title). This is not evidence of tool use on its own.',
      };
    }
    if (multipleFaces > 0) {
      return {
        headline: 'Another person seen in the candidate camera',
        detail:
          'The frame analyser saw more than one face. This is human assistance, not an AI tool, so the AI-assistance wording above does not apply. Review the recording before acting.',
      };
    }
    if (risk.score >= 30) {
      return {
        headline: 'Suspicious behaviour, no tool detected',
        detail:
          'Behavioural signals such as tab switching or pasting were recorded, but no AI-assistance tool was identified. These have ordinary explanations too.',
      };
    }
    return {
      headline: 'Nothing of concern recorded',
      detail: 'No AI-assistance tool matched, and behavioural signals stayed within normal range.',
    };
  })();

  const durationLabel = (() => {
    if (!startedAt) return 'not started';
    const end = endedAt ? new Date(endedAt) : new Date();
    const mins = Math.max(0, Math.round((end.getTime() - new Date(startedAt).getTime()) / 60000));
    return `${mins} min${endedAt ? '' : ' so far'}`;
  })();

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 980, margin: '0 auto', padding: 20 }}>
      <Link to="/" style={{ fontSize: 13, color: '#2563eb' }}>&larr; All interviews</Link>
      <h1 style={{ marginTop: 8 }}>Live Interview Monitor</h1>
      {sessionStatus && (
        <div style={{ marginTop: -12, marginBottom: 16, fontSize: 13, color: '#6b7280' }}>
          Session status: <b style={{ color: '#111827' }}>{sessionStatus}</b>
        </div>
      )}

      {autoPause && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <b>Auto-paused:</b> {autoPause} — review evidence, then Resume or Terminate.
        </div>
      )}

      <div style={{ display: 'flex', gap: 20 }}>
        {/* Risk panel */}
        <div style={{ flex: '0 0 300px', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, color: '#6b7280' }}>RISK SCORE</div>
          <div style={{ fontSize: 56, fontWeight: 700, color: levelColor[risk.level] }}>
            {risk.score}<span style={{ fontSize: 20, color: '#9ca3af' }}>/100</span>
          </div>
          <div style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 999, background: levelColor[risk.level], color: '#fff', fontWeight: 600 }}>
            {risk.status}
          </div>
          <div style={{ marginTop: 16, fontSize: 13 }}>
            {Object.entries(risk.breakdown).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{k}</span><b>+{v}</b>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 20, display: 'grid', gap: 8 }}>
            <button onClick={() => control('pause')} style={btn}>Pause</button>
            <button onClick={() => control('resume')} style={btn}>Resume</button>
            <button onClick={() => control('terminate')} style={{ ...btn, background: '#dc2626', color: '#fff' }}>Terminate</button>
          </div>
        </div>

        {/* Detection + event feed */}
        <div style={{ flex: 1 }}>
          <h3>AI-Assistance Detections</h3>
          {detections.length === 0 && <p style={{ color: '#6b7280' }}>No tool detections yet.</p>}
          {detections.map((d) => (
            <div key={d.id} style={{ border: '1px solid #fecaca', background: '#fff7f7', borderRadius: 8, padding: 12, marginBottom: 8 }}>
              <b>{d.toolName ?? 'Unknown tool'}</b> — {d.confidence}% confidence
              <div style={{ fontSize: 12, color: '#6b7280' }}>Method: {d.method}</div>
              <pre style={{ fontSize: 11, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(d.evidence)}</pre>
            </div>
          ))}

          <h3>Integrity Report</h3>
          <div style={reportBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <b style={{ fontSize: 15 }}>{verdict.headline}</b>
              <span style={{ fontSize: 12, color: '#6b7280' }}>{durationLabel}</span>
            </div>
            <div style={{ fontSize: 13, color: '#4b5563', lineHeight: 1.5, marginBottom: 12 }}>{verdict.detail}</div>

            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Camera</div>
            <div style={{ fontSize: 13, marginBottom: 12 }}>
              {multipleFaces > 0 ? (
                <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                  Another person visible in frame — {multipleFaces} time{multipleFaces === 1 ? '' : 's'}
                </span>
              ) : (
                <span style={{ color: '#6b7280' }}>Only the candidate seen in frame.</span>
              )}
              {noFace > 0 && (
                <div style={{ color: '#a16207' }}>
                  Candidate absent from frame — {noFace} time{noFace === 1 ? '' : 's'}
                </div>
              )}
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Tools identified</div>
            {toolSummary.length === 0 ? (
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                None. No known AI-assistance tool matched during this session.
              </div>
            ) : (
              <div style={{ marginBottom: 12 }}>
                {toolSummary.map((t) => (
                  <div key={t.tool} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
                    <span>
                      {t.tool}{' '}
                      <span style={{ color: t.strong ? '#b91c1c' : '#a16207', fontWeight: 600 }}>
                        {t.strong ? 'confirmed signal' : 'weak hint'}
                      </span>
                    </span>
                    <span style={{ color: '#6b7280' }}>{t.maxConfidence}% · {t.count}x · {t.methods.join(', ')}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Behavioural signal counts</div>
            {eventSummary.length === 0 ? (
              <div style={{ fontSize: 13, color: '#6b7280' }}>No behavioural events recorded.</div>
            ) : (
              eventSummary.map(([type, count]) => (
                <div key={type} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
                  <span>{type}</span><span style={{ color: '#6b7280' }}>{count}x</span>
                </div>
              ))
            )}

            <div style={{ marginTop: 12, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
              A risk score is evidence, not a verdict. Only a human reviewer can declare a
              policy violation. Weak hints (a browser tab title, a virtual audio device) can
              have innocent explanations and never drive this result on their own.
            </div>
          </div>

          <h3>Behavioral Events</h3>
          <div style={{ maxHeight: 260, overflow: 'auto', fontSize: 13 }}>
            {events.map((e) => (
              <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f3f4f6' }}>
                <span>{e.type} <span style={{ color: '#9ca3af' }}>({e.source})</span></span>
                <span style={{ color: '#9ca3af' }}>{new Date(e.occurredAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const reportBox: React.CSSProperties = {
  border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 20, background: '#fafafa',
};
const btn: React.CSSProperties = { padding: '10px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', cursor: 'pointer' };

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';
import { switchDemoRole } from '../lib/demoAuth';
import { card, errorBox, field, ghost, input, page, primary } from '../ui';

interface Interview {
  id: string;
  title: string;
  requireAgent: boolean;
  createdAt: string;
  sessionCount: number;
}

interface SessionRow {
  id: string;
  status: string;
  agentConnected: boolean;
  startedAt: string | null;
  candidate: { fullName: string; email: string } | null;
}

const statusColour: Record<string, string> = {
  PENDING: '#6b7280', CONSENTED: '#2563eb', ACTIVE: '#16a34a',
  PAUSED: '#ca8a04', TERMINATED: '#dc2626', COMPLETED: '#6b7280',
};

export default function InterviewerHome() {
  const user = useAuth((s) => s.user);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [title, setTitle] = useState('');
  const [requireAgent, setRequireAgent] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionRow[]>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = () =>
    api<Interview[]>('/api/interviews').then(setInterviews).catch((e) => setError(e.message));

  useEffect(() => { void load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/api/interviews', {
        method: 'POST',
        body: JSON.stringify({ title, requireAgent }),
      });
      setTitle('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string) => {
    if (openId === id) return setOpenId(null);
    setOpenId(id);
    if (!sessions[id]) {
      try {
        const rows = await api<SessionRow[]>(`/api/interviews/${id}/sessions`);
        setSessions((prev) => ({ ...prev, [id]: rows }));
      } catch (err: any) {
        setError(err.message);
      }
    }
  };

  const inviteLink = (id: string) => `${location.origin}/join/${id}`;

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(id));
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard is blocked outside a secure context — the link is on screen
      // anyway, so the user can select it manually.
      setError('Could not copy automatically — select the link and copy it.');
    }
  };

  return (
    <div style={page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>My interviews</h1>
          <p style={{ color: '#6b7280', marginTop: 0, fontSize: 14 }}>
            Signed in as {user?.fullName} ({user?.email})
          </p>
        </div>
        {/* One browser holds one token, so seeing the candidate's side means
            swapping accounts rather than opening a second session. */}
        <button style={ghost} onClick={() => switchDemoRole('CANDIDATE')}>
          View as candidate
        </button>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      <form style={{ ...card, marginBottom: 24 }} onSubmit={create}>
        <label style={field}>
          New interview
          <input
            style={input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Backend Round 1"
            required
          />
        </label>
        <label style={{ display: 'block', marginBottom: 14, fontSize: 14 }}>
          <input type="checkbox" checked={requireAgent} onChange={(e) => setRequireAgent(e.target.checked)} />{' '}
          Require the desktop integrity agent
          <div style={{ fontSize: 12, color: '#9ca3af', marginLeft: 22 }}>
            Without it only browser-level signals are collected — no AI tool detection.
          </div>
        </label>
        <button style={primary} disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create interview'}
        </button>
      </form>

      {interviews.length === 0 && (
        <p style={{ color: '#6b7280' }}>No interviews yet. Create one above to get an invite link.</p>
      )}

      {interviews.map((iv) => (
        <div key={iv.id} style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <b style={{ fontSize: 16 }}>{iv.title}</b>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                {iv.sessionCount} candidate{iv.sessionCount === 1 ? '' : 's'}
                {iv.requireAgent ? ' · agent required' : ' · browser signals only'}
              </div>
            </div>
            <button style={ghost} onClick={() => toggle(iv.id)}>
              {openId === iv.id ? 'Hide' : 'Candidates'}
            </button>
          </div>

          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div style={{ color: '#6b7280', marginBottom: 4 }}>Invite link — send this to the candidate:</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={inviteLink(iv.id)} style={{ ...input, marginTop: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
              <button style={ghost} onClick={() => copy(iv.id)}>{copied === iv.id ? 'Copied' : 'Copy'}</button>
            </div>
          </div>

          {openId === iv.id && (
            <div style={{ marginTop: 14, borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
              {!sessions[iv.id] && <div style={{ fontSize: 13, color: '#6b7280' }}>Loading…</div>}
              {sessions[iv.id]?.length === 0 && (
                <div style={{ fontSize: 13, color: '#6b7280' }}>Nobody has opened the link yet.</div>
              )}
              {sessions[iv.id]?.map((s) => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                  <span style={{ fontSize: 14 }}>
                    {s.candidate?.fullName ?? 'Unknown'}{' '}
                    <span style={{ color: '#9ca3af' }}>{s.candidate?.email}</span>
                    <span style={{ color: statusColour[s.status] ?? '#6b7280', fontWeight: 600, marginLeft: 8 }}>
                      {s.status}
                    </span>
                    {s.agentConnected && <span style={{ color: '#16a34a', marginLeft: 8 }}>agent on</span>}
                  </span>
                  <Link to={`/monitor/${s.id}`} style={{ ...ghost, textDecoration: 'none', color: '#111827' }}>
                    Monitor
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

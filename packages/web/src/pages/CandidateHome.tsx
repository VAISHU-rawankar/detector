import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';
import { card, errorBox, ghost, input, page, primary } from '../ui';

interface MySession {
  id: string;
  status: string;
  startedAt: string | null;
  title: string;
  requireAgent: boolean;
}

const statusColour: Record<string, string> = {
  PENDING: '#6b7280', CONSENTED: '#2563eb', ACTIVE: '#16a34a',
  PAUSED: '#ca8a04', TERMINATED: '#dc2626', COMPLETED: '#6b7280',
};

const OPEN = ['PENDING', 'CONSENTED', 'ACTIVE', 'PAUSED'];

export default function CandidateHome() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<MySession[] | null>(null);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MySession[]>('/api/my/sessions')
      .then(setSessions)
      .catch((e) => { setError(e.message); setSessions([]); });
  }, []);

  // Accept either the full invite URL or just the id pasted out of it.
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const id = invite.trim().replace(/\/+$/, '').split('/').pop() ?? '';
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return setError('That does not look like an invite link. Paste the whole link your interviewer sent.');
    }
    navigate(`/join/${id}`);
  };

  const open = sessions?.filter((s) => OPEN.includes(s.status)) ?? [];
  const past = sessions?.filter((s) => !OPEN.includes(s.status)) ?? [];

  return (
    <div style={page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>Your interviews</h1>
          <p style={{ color: '#6b7280', marginTop: 0, fontSize: 14 }}>
            Signed in as {user?.fullName} ({user?.email})
          </p>
        </div>
        <button style={ghost} onClick={logout}>Sign out</button>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      <form style={{ ...card, marginBottom: 24 }} onSubmit={go}>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Have an invite link?</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...input, marginTop: 0 }}
            value={invite}
            onChange={(e) => { setInvite(e.target.value); setError(null); }}
            placeholder="Paste the link your interviewer sent"
          />
          <button style={primary} disabled={!invite.trim()}>Join</button>
        </div>
      </form>

      {sessions === null && <p style={{ color: '#6b7280' }}>Loading…</p>}

      {sessions !== null && open.length === 0 && past.length === 0 && (
        <p style={{ color: '#6b7280' }}>
          Nothing yet. Paste an invite link above to start your first interview.
        </p>
      )}

      {open.length > 0 && (
        <>
          <h3>In progress</h3>
          {open.map((s) => (
            <div key={s.id} style={{ ...card, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                <b>{s.title}</b>
                <span style={{ color: statusColour[s.status] ?? '#6b7280', fontWeight: 600, marginLeft: 10, fontSize: 13 }}>
                  {s.status}
                </span>
                {s.requireAgent && (
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>Desktop agent required</div>
                )}
              </span>
              <Link to={`/session/${s.id}`} style={{ ...primary, textDecoration: 'none' }}>
                {s.status === 'ACTIVE' ? 'Rejoin' : 'Open'}
              </Link>
            </div>
          ))}
        </>
      )}

      {past.length > 0 && (
        <>
          <h3 style={{ marginTop: 24 }}>Finished</h3>
          {past.map((s) => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 14, borderBottom: '1px solid #f3f4f6' }}>
              <span>{s.title}</span>
              <span style={{ color: statusColour[s.status] ?? '#6b7280' }}>{s.status}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

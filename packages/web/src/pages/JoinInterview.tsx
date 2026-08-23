import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';
import { errorBox, wrap } from '../ui';
import Login from './Login';

interface InterviewInfo { id: string; title: string; requireAgent: boolean }
interface Session { _id: string }

// Landing page for an invite link. Signs the candidate in if needed, then
// creates (or re-opens) their session and forwards them into the room — so the
// link is the only thing anyone has to share.
export default function JoinInterview() {
  const { interviewId } = useParams<{ interviewId: string }>();
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const [interview, setInterview] = useState<InterviewInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !interviewId) return;
    let cancelled = false;

    (async () => {
      try {
        const info = await api<InterviewInfo>(`/api/interviews/${interviewId}`);
        if (cancelled) return;
        setInterview(info);

        // An interviewer following their own link should land on the dashboard
        // list, not be enrolled as a candidate in their own interview.
        if (user?.role !== 'CANDIDATE') {
          navigate('/', { replace: true });
          return;
        }

        const session = await api<Session>('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ interviewId }),
        });
        if (!cancelled) navigate(`/session/${session._id}`, { replace: true });
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      }
    })();

    return () => { cancelled = true; };
  }, [token, interviewId, user?.role, navigate]);

  if (!token) {
    return <Login intro="Sign in or register to join this interview." />;
  }

  return (
    <div style={wrap}>
      <h1>{interview?.title ?? 'Joining interview…'}</h1>
      {error ? (
        <div style={errorBox}>{error}</div>
      ) : (
        <p style={{ color: '#6b7280' }}>Setting up your session…</p>
      )}
    </div>
  );
}

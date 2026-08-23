import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter, Navigate, Route, Routes, useParams,
} from 'react-router-dom';
import CandidateHome from './pages/CandidateHome';
import CandidateRoom from './pages/CandidateRoom';
import InterviewerDashboard from './pages/InterviewerDashboard';
import InterviewerHome from './pages/InterviewerHome';
import JoinInterview from './pages/JoinInterview';
import Login from './pages/Login';
import { api } from './lib/api';
import { signInAsDemo, type DemoRole } from './lib/demoAuth';
import { useAuth } from './store/auth';
import { errorBox, wrap } from './ui';

// Signs the visitor in automatically as the role this route implies, so the app
// opens straight into the demo with no sign-in step. The role comes from the
// route because a browser holds one token at a time: an invite link means you
// are the candidate, everything else means you are running the interview.
//
// If the server has demo mode off, this falls back to the real login form —
// the same build works either way.
function AutoAuth({ as, children }: { as: DemoRole; children: React.ReactNode }) {
  const { token, user } = useAuth();
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (token) return;
    let cancelled = false;
    signInAsDemo(as).finally(() => { if (!cancelled) setTried(true); });
    return () => { cancelled = true; };
  }, [token, as]);

  if (!token) {
    if (!tried) return <div style={wrap}><p style={{ color: '#6b7280' }}>Starting…</p></div>;
    return <Login intro="Sign in to continue." />;
  }
  // A stored token for the other role would send the candidate to the
  // interviewer's screen, so swap it for the one this route needs.
  if (user && user.role !== as && user.role !== 'ADMIN') {
    return <RoleSwap to={as} />;
  }
  return <>{children}</>;
}

function RoleSwap({ to }: { to: DemoRole }) {
  useEffect(() => {
    useAuth.getState().logout();
    void signInAsDemo(to);
  }, [to]);
  return <div style={wrap}><p style={{ color: '#6b7280' }}>Switching…</p></div>;
}

// The candidate room needs to know whether this interview requires the desktop
// agent, which lives on the interview rather than the session.
function CandidateRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [state, setState] = useState<{ requireAgent: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    api<{ requireAgent: boolean }>(`/api/sessions/${sessionId}/state`)
      .then(setState)
      .catch((e) => setError(e.message));
  }, [sessionId]);

  if (error) return <div style={wrap}><div style={errorBox}>{error}</div></div>;
  if (!sessionId || !state) return <div style={wrap}><p>Loading…</p></div>;
  return <CandidateRoom sessionId={sessionId} requireAgent={state.requireAgent} />;
}

function MonitorRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  if (!sessionId) return <Navigate to="/" replace />;
  return <InterviewerDashboard sessionId={sessionId} />;
}

function Home() {
  const user = useAuth((s) => s.user);
  return user?.role === 'CANDIDATE' ? <CandidateHome /> : <InterviewerHome />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AutoAuth as="INTERVIEWER"><Home /></AutoAuth>} />
        {/* Invite links are the only thing an interviewer has to share. */}
        <Route path="/join/:interviewId" element={<AutoAuth as="CANDIDATE"><JoinInterview /></AutoAuth>} />
        <Route path="/session/:sessionId" element={<AutoAuth as="CANDIDATE"><CandidateRoute /></AutoAuth>} />
        <Route path="/monitor/:sessionId" element={<AutoAuth as="INTERVIEWER"><MonitorRoute /></AutoAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

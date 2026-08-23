import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter, Navigate, Route, Routes, useParams,
} from 'react-router-dom';
import CandidateRoom from './pages/CandidateRoom';
import InterviewerDashboard from './pages/InterviewerDashboard';
import InterviewerHome from './pages/InterviewerHome';
import JoinInterview from './pages/JoinInterview';
import Login from './pages/Login';
import { api } from './lib/api';
import { useAuth } from './store/auth';
import { errorBox, wrap } from './ui';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Login intro="Sign in to continue." />;
  return <>{children}</>;
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
  if (user?.role === 'CANDIDATE') {
    return (
      <div style={wrap}>
        <h1>Nothing to join yet</h1>
        <p style={{ color: '#6b7280' }}>
          Open the invite link your interviewer sent you to start a session.
        </p>
      </div>
    );
  }
  return <InterviewerHome />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
        {/* Invite links are the only thing an interviewer has to share; the
            join page signs the candidate in and creates their session. */}
        <Route path="/join/:interviewId" element={<JoinInterview />} />
        <Route path="/session/:sessionId" element={<RequireAuth><CandidateRoute /></RequireAuth>} />
        <Route path="/monitor/:sessionId" element={<RequireAuth><MonitorRoute /></RequireAuth>} />
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

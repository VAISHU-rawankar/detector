import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth, type User } from '../store/auth';
import { card, field, input, primary, errorBox, wrap } from '../ui';

interface AuthResponse {
  token: string;
  user: User;
}

export default function Login({ intro }: { intro?: string }) {
  const setAuth = useAuth((s) => s.setAuth);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<'INTERVIEWER' | 'CANDIDATE'>('CANDIDATE');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body =
        mode === 'login' ? { email, password } : { email, password, fullName, role };
      const res = await api<AuthResponse>(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setAuth(res.token, res.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={wrap}>
      <h1 style={{ marginBottom: 4 }}>Interview Integrity</h1>
      <p style={{ color: '#6b7280', marginTop: 0 }}>
        {intro ?? (mode === 'login' ? 'Sign in to continue.' : 'Create an account to continue.')}
      </p>

      <form style={card} onSubmit={submit}>
        {mode === 'register' && (
          <>
            <label style={field}>
              Full name
              <input style={input} value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </label>
            <label style={field}>
              I am a
              <select style={input} value={role} onChange={(e) => setRole(e.target.value as any)}>
                <option value="CANDIDATE">Candidate</option>
                <option value="INTERVIEWER">Interviewer</option>
              </select>
            </label>
          </>
        )}

        <label style={field}>
          Email
          <input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label style={field}>
          Password
          <input
            style={input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'register' ? 8 : undefined}
            required
          />
          {mode === 'register' && (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>At least 8 characters.</span>
          )}
        </label>

        {error && <div style={errorBox}>{error}</div>}

        <button style={primary} disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <div style={{ marginTop: 14, fontSize: 14, color: '#6b7280' }}>
          {mode === 'login' ? "Don't have an account? " : 'Already have one? '}
          <button
            type="button"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
            style={{ background: 'none', border: 0, color: '#2563eb', cursor: 'pointer', padding: 0, font: 'inherit' }}
          >
            {mode === 'login' ? 'Register' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

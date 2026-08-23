import { api } from './api';
import { useAuth, type User } from '../store/auth';

export type DemoRole = 'INTERVIEWER' | 'CANDIDATE';

interface AuthResponse {
  token: string;
  user: User;
}

// Signs in as a shared demo account so nobody has to type credentials. The
// server decides whether this is allowed (DEMO_MODE); if it says no, callers
// fall back to the normal login form.
export async function signInAsDemo(role: DemoRole): Promise<boolean> {
  try {
    const res = await api<AuthResponse>('/api/auth/demo', {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    useAuth.getState().setAuth(res.token, res.user);
    return true;
  } catch {
    return false;
  }
}

// A browser holds one token at a time, so viewing the other side of an
// interview means swapping accounts rather than opening a second one.
export async function switchDemoRole(role: DemoRole) {
  useAuth.getState().logout();
  await signInAsDemo(role);
}

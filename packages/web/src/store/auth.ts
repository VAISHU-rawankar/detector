import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: 'ADMIN' | 'INTERVIEWER' | 'CANDIDATE';
}

interface AuthState {
  token: string | null;
  user: User | null;
  // True when this session was started by demo auto-login rather than a real
  // sign-in. The candidate room uses it to decide whether showing live
  // detection results on the candidate's own screen is acceptable.
  demo: boolean;
  setAuth: (token: string, user: User, demo?: boolean) => void;
  logout: () => void;
}

// Persisted to localStorage rather than carried in the URL: a token in a query
// string ends up in browser history, server logs and referrer headers, and gets
// copy-pasted around by whoever is sharing the link.
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      demo: false,
      setAuth: (token, user, demo = false) => set({ token, user, demo }),
      logout: () => set({ token: null, user: null, demo: false }),
    }),
    { name: 'iip-auth' },
  ),
);

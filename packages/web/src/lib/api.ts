import { useAuth } from '../store/auth';

export const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === 'string') return err;
    // zod's flatten() shape — surface the first real complaint rather than [object Object]
    if (err && typeof err === 'object') {
      const field = Object.values((err as any).fieldErrors ?? {}).flat()[0];
      if (typeof field === 'string') return field;
      const form = (err as any).formErrors?.[0];
      if (typeof form === 'string') return form;
    }
  }
  return `Request failed (${status})`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token, logout } = useAuth.getState();
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Tokens last 8 hours; when one expires every call would otherwise fail with
    // a confusing error while the app still looked signed in.
    if (res.status === 401) logout();
    throw new ApiError(res.status, messageFrom(body, res.status));
  }
  return body as T;
}

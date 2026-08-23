// Shared inline styles. The app has no CSS build step, so the handful of styles
// used on more than one screen live here instead of being copied around.
import type { CSSProperties } from 'react';

export const wrap: CSSProperties = {
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  maxWidth: 560,
  margin: '48px auto',
  padding: '0 20px',
  lineHeight: 1.55,
};

export const page: CSSProperties = {
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  maxWidth: 900,
  margin: '32px auto',
  padding: '0 20px',
  lineHeight: 1.55,
};

export const card: CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 20,
  background: '#fff',
};

export const field: CSSProperties = {
  display: 'block',
  marginBottom: 14,
  fontSize: 14,
  fontWeight: 500,
};

export const input: CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 6,
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  fontWeight: 400,
};

export const primary: CSSProperties = {
  padding: '11px 20px',
  background: '#2563eb',
  color: '#fff',
  border: 0,
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 15,
};

export const ghost: CSSProperties = {
  padding: '9px 16px',
  background: '#fff',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 14,
};

export const errorBox: CSSProperties = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  color: '#991b1b',
  borderRadius: 8,
  padding: 12,
  marginBottom: 14,
  fontSize: 14,
};

export const infoBox: CSSProperties = {
  background: '#f5f5f5',
  borderRadius: 8,
  padding: 16,
  margin: '16px 0',
};

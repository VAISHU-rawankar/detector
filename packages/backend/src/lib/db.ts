import 'dotenv/config';
import mongoose from 'mongoose';

export const ENV = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/interview',
  JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-prod',
  DETECTION_WEBHOOK_SECRET: process.env.DETECTION_WEBHOOK_SECRET || 'change-me-webhook',
  // Comma-separated: production needs at least the web app's own origin, and
  // usually a Vercel preview domain alongside it.
  CORS_ORIGIN: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Behind Render/Vercel/any reverse proxy this must be on, or req.ip is the
  // proxy's address — which would put the wrong IP on every consent record and
  // make the rate limiter treat all traffic as one client.
  // Turns on POST /api/auth/demo, which hands out a token for a shared demo
  // account with no password. That is an authentication bypass, so it is off
  // unless explicitly switched on.
  DEMO_MODE: process.env.DEMO_MODE === 'true',
  TRUST_PROXY: process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? '1' : ''),
};

export async function connectDB() {
  await mongoose.connect(ENV.MONGODB_URI);
  // eslint-disable-next-line no-console
  console.log('MongoDB connected');
}

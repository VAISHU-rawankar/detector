import express from 'express';
import http from 'http';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { ENV, connectDB } from './lib/db';
import { authRouter } from './routes/auth';
import { interviewRouter } from './routes/interviews';
import { detectionWebhookRouter } from './routes/detectionWebhook';
import { registerSockets } from './sockets';

async function main() {
  await connectDB();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: ENV.CORS_ORIGIN } });

  // Consent records store req.ip and the rate limiter keys on it, so the proxy
  // hop count has to be declared before either runs.
  if (ENV.TRUST_PROXY) app.set('trust proxy', Number(ENV.TRUST_PROXY) || 1);

  app.use(helmet());
  app.use(cors({ origin: ENV.CORS_ORIGIN }));

  // Webhook mounts BEFORE express.json() (needs raw body for HMAC).
  app.use('/api', detectionWebhookRouter(io));

  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api', interviewRouter(io));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Request error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
  });

  registerSockets(io);
  server.listen(ENV.PORT, () => console.log(`Backend listening on :${ENV.PORT}`));
}

// Express 4 does not forward rejections from async route handlers to the error
// middleware above, so one of them becomes an unhandledRejection — which, by
// default, kills the process and every live interview session with it. Log and
// stay up instead; the offending request just never gets a response.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept alive):', reason);
});

main().catch((e) => { console.error(e); process.exit(1); });

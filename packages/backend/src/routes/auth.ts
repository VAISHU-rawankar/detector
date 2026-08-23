import { asyncRouter } from '../lib/asyncRouter';
import { z } from 'zod';
import { User } from '../models';
import { hashPassword, verifyPassword, signToken } from '../lib/auth';
import { ENV } from '../lib/db';
import crypto from 'crypto';

export const authRouter = asyncRouter();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  role: z.enum(['ADMIN', 'INTERVIEWER', 'CANDIDATE']).default('CANDIDATE'),
  companyId: z.string().optional(),
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, fullName, role, companyId } = parsed.data;

  const existing = await User.findOne({ email });
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const user = await User.create({
    email, passwordHash: await hashPassword(password), fullName, role, company: companyId,
  });
  const token = signToken({ userId: user.id, role: user.role as any, companyId: companyId ?? null });
  res.json({ token, user: { id: user.id, email, fullName, role: user.role } });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password } = parsed.data;

  const user = await User.findOne({ email });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken({ userId: user.id, role: user.role as any, companyId: (user.company as any)?.toString() ?? null });
  res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } });
});

// ── Demo mode ───────────────────────────────────────────────────────────────
// Signs the visitor straight in as a shared demo account so the app can be
// walked through without anyone typing credentials.
//
// This is deliberately an authentication bypass, and everyone who opens the
// link shares these two accounts: whatever one visitor creates, the next one
// sees. Fine for a demo, wrong for real interviews — hence the env switch.
const DEMO_ACCOUNTS = {
  INTERVIEWER: { email: 'demo-interviewer@example.com', fullName: 'Demo Interviewer' },
  CANDIDATE: { email: 'demo-candidate@example.com', fullName: 'Demo Candidate' },
} as const;

const demoSchema = z.object({ role: z.enum(['INTERVIEWER', 'CANDIDATE']) });

authRouter.post('/demo', async (req, res) => {
  if (!ENV.DEMO_MODE) {
    return res.status(403).json({ error: 'Demo mode is off. Set DEMO_MODE=true on the server to enable it.' });
  }
  const parsed = demoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Unknown role' });

  const spec = DEMO_ACCOUNTS[parsed.data.role];
  let user = await User.findOne({ email: spec.email });
  if (!user) {
    // Random unusable password: the account is only ever reachable through this
    // endpoint, so it must not also be guessable through /login.
    user = await User.create({
      email: spec.email,
      passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')),
      fullName: spec.fullName,
      role: parsed.data.role,
    });
  }

  const token = signToken({ userId: user.id, role: user.role as any, companyId: null });
  res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } });
});

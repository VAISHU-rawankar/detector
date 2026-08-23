import { asyncRouter } from '../lib/asyncRouter';
import { z } from 'zod';
import { User } from '../models';
import { hashPassword, verifyPassword, signToken } from '../lib/auth';

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

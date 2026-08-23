import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import { ENV } from './db';

export interface JwtPayload {
  userId: string;
  role: 'ADMIN' | 'INTERVIEWER' | 'CANDIDATE';
  companyId?: string | null;
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export const signToken = (payload: JwtPayload) =>
  jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: '8h' });

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), ENV.JWT_SECRET) as JwtPayload;
    (req as any).user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(...roles: JwtPayload['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as JwtPayload | undefined;
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

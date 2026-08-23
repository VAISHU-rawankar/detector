import type { RequestHandler } from 'express';
import { Interview, InterviewSession } from '../models';
import type { JwtPayload } from './auth';

// Only the candidate sitting the session and the interviewer who owns it may
// touch it. Without this, any authenticated account could read another
// candidate's risk report — or terminate their interview — just by knowing an id.
export const requireSessionAccess: RequestHandler = async (req, res, next) => {
  const user = (req as any).user as JwtPayload | undefined;
  if (!user) return res.status(401).json({ error: 'Missing token' });

  const session = await InterviewSession.findById(req.params.id).lean();
  if (!session) return res.status(404).json({ error: 'Not found' });

  const isCandidate = String(session.candidate) === user.userId;
  let isOwner = user.role === 'ADMIN';
  if (!isOwner && !isCandidate) {
    const interview = await Interview.findById(session.interview).lean();
    isOwner = !!interview && String(interview.interviewer) === user.userId;
  }

  if (!isCandidate && !isOwner) return res.status(403).json({ error: 'Forbidden' });

  (req as any).session = session;
  (req as any).isInterviewer = isOwner;
  next();
};

// Pause / resume / terminate are interviewer actions. A candidate must not be
// able to end their own session to stop it recording evidence.
export const requireSessionOwner: RequestHandler = (req, res, next) => {
  if (!(req as any).isInterviewer) return res.status(403).json({ error: 'Interviewer only' });
  next();
};

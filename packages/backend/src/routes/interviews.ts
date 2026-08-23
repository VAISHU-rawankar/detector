import { asyncRouter, requireObjectIdParam, isObjectId } from '../lib/asyncRouter';
import { z } from 'zod';
import { Interview, InterviewSession, ConsentRecord, AuditLog, InterviewEvent, DetectionEvent, Question, CandidateAnswer } from '../models';
import { authMiddleware, requireRole } from '../lib/auth';
import { requireSessionAccess, requireSessionOwner } from '../lib/sessionAccess';
import { DEFAULT_WEIGHTS, statusLabel } from '../services/riskEngine';
import { evaluateRisk } from '../services/detectionService';
import type { Server } from 'socket.io';

// Asked in order by the candidate room when an interview has no custom set.
// Deliberately open-ended: a pasted LLM answer looks very different from a typed one.
const DEFAULT_QUESTIONS = [
  'Tell me about yourself and the work you are most proud of.',
  'Explain the difference between authentication and authorization, with an example.',
  'What happens, step by step, when you type a URL into a browser and press Enter?',
  'Describe a bug you found that turned out to have a completely different root cause than you first thought.',
  'How would you design a rate limiter for a public API? Walk me through your reasoning.',
  'What is the difference between a process and a thread?',
  'You are given a slow database query in production. How do you diagnose it?',
  'Why do you want this role, and what would make you leave it?',
];

export function interviewRouter(io: Server) {
  const router = asyncRouter();
  // Every /sessions/:id route needs the same three checks, so they are applied
  // once here rather than repeated (and eventually forgotten) on each handler.
  router.use('/sessions/:id', requireObjectIdParam('id'), authMiddleware, requireSessionAccess);

  router.post('/interviews', authMiddleware, requireRole('INTERVIEWER', 'ADMIN'), async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      requireAgent: z.boolean().default(false),
      scheduledAt: z.string().datetime().optional(),
      questions: z.array(z.string().min(1)).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const user = (req as any).user;

    const interview = await Interview.create({
      title: parsed.data.title,
      requireAgent: parsed.data.requireAgent,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : undefined,
      company: user.companyId ?? undefined,
      interviewer: user.userId,
    });

    const prompts = parsed.data.questions?.length ? parsed.data.questions : DEFAULT_QUESTIONS;
    await Question.insertMany(
      prompts.map((prompt, order) => ({ interview: interview._id, prompt, order })),
    );

    res.json(interview);
  });

  // A candidate's own sessions, so landing on the app without an invite link in
  // hand is not a dead end — they can resume whatever is already in progress.
  router.get('/my/sessions', authMiddleware, async (req, res) => {
    const user = (req as any).user;
    const sessions = await InterviewSession.find({ candidate: user.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('interview', 'title requireAgent')
      .lean();

    res.json(
      sessions.map((s) => ({
        id: String(s._id),
        status: s.status,
        startedAt: s.startedAt ?? null,
        title: (s.interview as any)?.title ?? 'Interview',
        requireAgent: (s.interview as any)?.requireAgent ?? false,
      })),
    );
  });

  // Interviewer's own interviews, newest first, with how many candidates have
  // joined each one.
  router.get('/interviews', authMiddleware, requireRole('INTERVIEWER', 'ADMIN'), async (req, res) => {
    const user = (req as any).user;
    const interviews = await Interview.find({ interviewer: user.userId }).sort({ createdAt: -1 }).lean();
    const counts = await InterviewSession.aggregate([
      { $match: { interview: { $in: interviews.map((i) => i._id) } } },
      { $group: { _id: '$interview', count: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c.count]));
    res.json(
      interviews.map((i) => ({
        id: String(i._id),
        title: i.title,
        requireAgent: i.requireAgent,
        createdAt: i.createdAt,
        sessionCount: byId.get(String(i._id)) ?? 0,
      })),
    );
  });

  // Read by a candidate opening an invite link, so it exposes only what the
  // join screen needs to show — never the interviewer or company.
  router.get('/interviews/:id', requireObjectIdParam('id'), authMiddleware, async (req, res) => {
    const interview = await Interview.findById(req.params.id).lean();
    if (!interview) return res.status(404).json({ error: 'Not found' });
    res.json({ id: String(interview._id), title: interview.title, requireAgent: interview.requireAgent });
  });

  router.get('/interviews/:id/sessions', requireObjectIdParam('id'), authMiddleware,
    requireRole('INTERVIEWER', 'ADMIN'), async (req, res) => {
      const user = (req as any).user;
      const interview = await Interview.findById(req.params.id).lean();
      if (!interview) return res.status(404).json({ error: 'Not found' });
      if (user.role !== 'ADMIN' && String(interview.interviewer) !== user.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const sessions = await InterviewSession.find({ interview: req.params.id })
        .sort({ createdAt: -1 })
        .populate('candidate', 'fullName email')
        .lean();

      res.json(
        sessions.map((s) => ({
          id: String(s._id),
          status: s.status,
          agentConnected: s.agentConnected,
          startedAt: s.startedAt ?? null,
          candidate: s.candidate
            ? { fullName: (s.candidate as any).fullName, email: (s.candidate as any).email }
            : null,
        })),
      );
    });

  router.post('/sessions', authMiddleware, async (req, res) => {
    const schema = z.object({ interviewId: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (!isObjectId(parsed.data.interviewId)) return res.status(404).json({ error: 'Unknown interview' });
    const user = (req as any).user;

    const interview = await Interview.findById(parsed.data.interviewId).lean();
    if (!interview) return res.status(404).json({ error: 'Unknown interview' });

    // Reopening the invite link must return the session already in progress —
    // creating a second one would strand the consent record, the events and the
    // agent's detections on a session nobody is looking at.
    const existing = await InterviewSession.findOne({
      interview: parsed.data.interviewId,
      candidate: user.userId,
      status: { $in: ['PENDING', 'CONSENTED', 'ACTIVE', 'PAUSED'] },
    });
    if (existing) return res.json(existing);

    const session = await InterviewSession.create({
      interview: parsed.data.interviewId, candidate: user.userId, status: 'PENDING',
    });
    res.json(session);
  });

  router.post('/sessions/:id/consent', async (req, res) => {
    const schema = z.object({ consentText: z.string().min(1), agentConsent: z.boolean().default(false) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    // `session` is uniquely indexed, so a re-submit (page reload, double click)
    // would throw E11000. Upsert instead — consent is idempotent per session.
    const record = await ConsentRecord.findOneAndUpdate(
      { session: req.params.id },
      {
        $setOnInsert: {
          session: req.params.id,
          consentText: parsed.data.consentText,
          agentConsent: parsed.data.agentConsent,
          ipAddress: req.ip,
          userAgent: req.header('user-agent') ?? undefined,
          consentedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    // Only PENDING advances to CONSENTED — never drag an ACTIVE session backwards.
    await InterviewSession.updateOne(
      { _id: req.params.id, status: 'PENDING' },
      { status: 'CONSENTED' },
    );
    res.json(record);
  });

  // The candidate starts their own session; pause / resume / terminate stay with
  // the interviewer so a candidate cannot end a session to stop it recording.
  router.post('/sessions/:id/start', async (req, res) => {
    const session = await InterviewSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (session.status === 'PENDING') {
      return res.status(400).json({ error: 'Consent required before starting' });
    }
    // Already running: a reload, or a candidate coming back after their browser
    // crashed, must be able to re-enter rather than being locked out mid-interview.
    if (session.status === 'ACTIVE') return res.json(session);
    if (session.status !== 'CONSENTED') {
      return res.status(409).json({ error: `Session is ${session.status}` });
    }

    session.status = 'ACTIVE';
    session.startedAt = new Date();
    await session.save();

    io.to(`session:${req.params.id}`).emit('session-status', { status: session.status });
    await AuditLog.create({ action: 'SESSION_START', meta: { sessionId: req.params.id } });
    res.json(session);
  });

  const controlSchema = z.object({ action: z.enum(['pause', 'resume', 'terminate', 'complete']) });
  router.post('/sessions/:id/control', requireSessionOwner, async (req, res) => {
    const parsed = controlSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const session = await InterviewSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });

    const statusMap: Record<string, string> = {
      pause: 'PAUSED', resume: 'ACTIVE', terminate: 'TERMINATED', complete: 'COMPLETED',
    };
    session.status = statusMap[parsed.data.action] as any;
    if (['terminate', 'complete'].includes(parsed.data.action)) session.endedAt = new Date();
    await session.save();

    io.to(`session:${req.params.id}`).emit('session-status', { status: session.status });
    if (['terminate', 'complete'].includes(parsed.data.action)) {
      io.to(`agent:${req.params.id}`).emit('stop-monitoring', {});
    }
    await AuditLog.create({ action: `SESSION_${parsed.data.action.toUpperCase()}`, meta: { sessionId: req.params.id } });
    res.json(session);
  });

  router.get('/sessions/:id', async (req, res) => {
    const session = await InterviewSession.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json(session);
  });

  // Full current state of a session. The dashboard is otherwise live-only: without
  // this it renders an empty feed and score 0 after any reload, even when the
  // session already has history.
  router.get('/sessions/:id/state', async (req, res) => {
    const id = req.params.id;
    const session = await InterviewSession.findById(id).lean();
    if (!session) return res.status(404).json({ error: 'Not found' });

    const [events, detections, result, interview] = await Promise.all([
      InterviewEvent.find({ session: id }).sort({ occurredAt: -1 }).limit(50).lean(),
      DetectionEvent.find({ session: id }).sort({ occurredAt: -1 }).limit(50).lean(),
      evaluateRisk(id),
      Interview.findById(session.interview).lean(),
    ]);

    res.json({
      status: session.status,
      agentConnected: session.agentConnected,
      title: interview?.title ?? '',
      requireAgent: interview?.requireAgent ?? false,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      events: events.map((e) => ({
        id: String(e._id), type: e.type, source: e.source, payload: e.payload, occurredAt: e.occurredAt,
      })),
      detections: detections.map((d) => ({
        id: String(d._id), method: d.method, toolName: d.toolName,
        confidence: d.confidence, evidence: d.evidence, occurredAt: d.occurredAt,
      })),
      risk: {
        score: result.score, level: result.level,
        status: statusLabel(result.level, result.hasStrongAiSignal),
        breakdown: result.breakdown, hasStrongAiSignal: result.hasStrongAiSignal,
      },
    });
  });

  // Candidate-facing: resolve questions through the session so the client never
  // needs to know (or be trusted with) the interview id.
  router.get('/sessions/:id/questions', async (req, res) => {
    const session = await InterviewSession.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Not found' });

    const questions = await Question.find({ interview: session.interview })
      .sort({ order: 1 })
      .lean();

    res.json(questions.map((q) => ({ id: String(q._id), prompt: q.prompt, order: q.order })));
  });

  const answerSchema = z.object({ questionId: z.string(), answerText: z.string() });
  router.post('/sessions/:id/answers', async (req, res) => {
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const session = await InterviewSession.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (!['ACTIVE', 'PAUSED'].includes(session.status as string)) {
      return res.status(409).json({ error: `Session is ${session.status}` });
    }

    const answer = await CandidateAnswer.create({
      session: req.params.id,
      question: parsed.data.questionId,
      answerText: parsed.data.answerText,
    });
    res.json({ id: String(answer._id) });
  });

  router.get('/config/weights', authMiddleware, (_req, res) => res.json(DEFAULT_WEIGHTS));

  return router;
}

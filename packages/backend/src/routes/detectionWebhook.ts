import { raw } from 'express';
import { asyncRouter, isObjectId } from '../lib/asyncRouter';
import crypto from 'crypto';
import { ENV } from '../lib/db';
import { DetectionSignature, InterviewSession } from '../models';
import { ingestDetection } from '../services/detectionService';
import { persistAndBroadcast } from '../services/eventService';
import { agentJoined, agentLeft, resetHeartbeat } from '../services/agentPresence';
import { fromFirstPartyAgent, fromVendorWebhook } from '../services/providerAdapters';
import type { Server } from 'socket.io';

// Verify HMAC-SHA256 signature so only our agent / a trusted vendor can post detections.
function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', ENV.DETECTION_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function detectionWebhookRouter(io: Server) {
  const router = asyncRouter();

  // Use raw body parser so HMAC is computed over the exact bytes received.
  router.post('/webhook/detection', raw({ type: '*/*' }), async (req, res) => {
    const sig = req.header('x-detection-signature');
    if (!verifySignature(req.body as Buffer, sig)) {
      return res.status(401).json({ error: 'Bad signature' });
    }

    let payload: any;
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Route to the correct adapter based on provider header.
    const provider = req.header('x-detection-provider') || 'first-party';
    let normalized;
    try {
      if (provider === 'first-party') {
        normalized = fromFirstPartyAgent(payload.sessionId, payload);
      } else {
        normalized = fromVendorWebhook(payload);
      }
    } catch {
      return res.status(400).json({ error: 'Adapter failed' });
    }

    if (!normalized) return res.status(202).json({ ignored: true });
    if (!isObjectId(normalized.sessionId)) return res.status(404).json({ error: 'Unknown session' });

    try {
      const detection = await ingestDetection(io, normalized);
      // ingestDetection returns null when the session is not in a monitorable
      // state. Reporting that as 200/ok made a dropped detection look identical
      // to a stored one, so a provider could never tell it was being ignored.
      if (!detection) {
        return res.status(409).json({
          error: 'Session is not accepting detections (must be CONSENTED, ACTIVE or PAUSED)',
        });
      }
      return res.json({ ok: true, detectionId: detection.id });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  // Agent lifecycle over signed HTTP. The Electron agent uses Socket.IO for
  // this; an agent written without a Socket.IO client (the Go build) uses these
  // instead. Both land on the same agentPresence service.
  const agentAction = (action: 'join' | 'heartbeat' | 'leave') =>
    async (req: any, res: any) => {
      if (!verifySignature(req.body as Buffer, req.header('x-detection-signature'))) {
        return res.status(401).json({ error: 'Bad signature' });
      }
      let payload: any;
      try {
        payload = JSON.parse((req.body as Buffer).toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
      const sessionId = payload?.sessionId;
      if (!isObjectId(sessionId)) return res.status(404).json({ error: 'Unknown session' });

      const session = await InterviewSession.findById(sessionId);
      if (!session) return res.status(404).json({ error: 'Unknown session' });

      if (action === 'join') await agentJoined(io, sessionId, payload.meta ?? {});
      else if (action === 'leave') await agentLeft(io, sessionId);
      else resetHeartbeat(io, sessionId);

      // The agent polls this to know when to shut itself down.
      return res.json({ ok: true, status: session.status });
    };

  router.post('/webhook/agent/join', raw({ type: '*/*' }), agentAction('join'));
  router.post('/webhook/agent/heartbeat', raw({ type: '*/*' }), agentAction('heartbeat'));
  router.post('/webhook/agent/leave', raw({ type: '*/*' }), agentAction('leave'));

  // Behavioural events from a non-browser provider (the ai-service frame
  // analyser). Separate from /webhook/detection because a second person in
  // frame is not an AI-tool detection and must not be scored as one.
  const AI_SERVICE_EVENTS = new Set(['MULTIPLE_FACES', 'NO_FACE_DETECTED']);

  router.post('/webhook/event', raw({ type: '*/*' }), async (req, res) => {
    if (!verifySignature(req.body as Buffer, req.header('x-detection-signature'))) {
      return res.status(401).json({ error: 'Bad signature' });
    }

    let payload: any;
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { sessionId, type } = payload ?? {};
    if (!isObjectId(sessionId) || !AI_SERVICE_EVENTS.has(type)) {
      return res.status(400).json({ error: 'Unknown sessionId or event type' });
    }

    const event = await persistAndBroadcast(io, sessionId, type, 'AI_SERVICE', payload.payload ?? {});
    if (!event) {
      return res.status(409).json({
        error: 'Session is not accepting events (must be CONSENTED, ACTIVE or PAUSED)',
      });
    }
    return res.json({ ok: true, eventId: event.id });
  });

  // The agent needs the live signature list, but has no user login — it only
  // holds the shared webhook secret. Authenticate with that.
  //
  // Signatures stay server-side (never bundled into the shipped agent) so the
  // list can be updated without re-releasing it. Without this endpoint the agent
  // silently falls back to its small inlined default set, which is why only
  // Cluely was ever matched while Final Round / LockedIn / Interview Coder sat
  // unused in the database.
  router.get('/detection/signatures', async (req, res) => {
    const provided = req.header('x-detection-secret') ?? '';
    const expected = ENV.DETECTION_WEBHOOK_SECRET;
    let ok = false;
    try {
      ok = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      ok = false;
    }
    if (!ok) return res.status(401).json({ error: 'Bad secret' });

    const signatures = await DetectionSignature.find({ enabled: true }).lean();
    res.json(
      signatures.map((s) => ({
        id: String(s._id),
        toolName: s.toolName,
        signatureType: s.signatureType,
        signatureData: s.signatureData,
        confidence: s.confidence,
      })),
    );
  });

  return router;
}

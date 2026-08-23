import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useProctorMonitor } from '../hooks/useProctorMonitor';
import { api, BACKEND } from '../lib/api';

// Optional webcam frame analyser. If it is not running, monitoring continues
// without face signals rather than blocking the interview.
const AI_SERVICE = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8000';
const FRAME_INTERVAL_MS = 4000;
const FRAME_WIDTH = 480;

interface Question { id: string; prompt: string; order: number }

const CONSENT_TEXT =
  'This interview may monitor permitted signals including camera, microphone, screen sharing, ' +
  'browser activity, tab switching, copy/paste activity and AI-assistance detection signals to ' +
  'maintain interview integrity.';

export default function CandidateRoom({ sessionId, requireAgent }: { sessionId: string; requireAgent: boolean }) {
  const [consented, setConsented] = useState(false);
  const [agentConsent, setAgentConsent] = useState(false);
  const [started, setStarted] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [finished, setFinished] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const camStreamRef = useRef<MediaStream | null>(null);

  const { markAnswer, markQuestionShown, watchScreenShare } = useProctorMonitor(socket, sessionId, started);

  useEffect(() => {
    const s = io(BACKEND);
    s.on('connect', () => s.emit('join-session', { sessionId, role: 'CANDIDATE' }));
    setSocket(s);
    return () => { s.disconnect(); };
  }, [sessionId]);

  // The <video> element does not exist until `started` flips to true, so the
  // stream has to be attached here rather than inside startInterview().
  useEffect(() => {
    if (started && videoRef.current && camStreamRef.current) {
      videoRef.current.srcObject = camStreamRef.current;
    }
  }, [started]);

  // Release camera/mic when the room unmounts.
  useEffect(() => () => {
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // Sample the webcam and hand frames to the analyser, which decides whether a
  // second person (or nobody) is in shot and reports that to the backend itself.
  // Frames are analysed and discarded — nothing is stored or sent anywhere else.
  useEffect(() => {
    if (!started) return;
    const canvas = document.createElement('canvas');
    let stopped = false;

    const sample = async () => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return;
      const scale = FRAME_WIDTH / video.videoWidth;
      canvas.width = FRAME_WIDTH;
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        await fetch(`${AI_SERVICE}/analyze-frame`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            imageBase64: canvas.toDataURL('image/jpeg', 0.7),
          }),
        });
      } catch {
        // Analyser offline — the rest of the monitoring is unaffected.
      }
    };

    const timer = setInterval(() => { if (!stopped) void sample(); }, FRAME_INTERVAL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [started, sessionId]);

  // Load the question set once the interview is actually running.
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    api<Question[]>(`/api/sessions/${sessionId}/questions`)
      .then((qs) => { if (!cancelled) setQuestions(qs); })
      .catch((err) => console.error('Failed to load questions:', err));
    return () => { cancelled = true; };
  }, [started, sessionId]);

  // Reset the latency clock every time a new question comes on screen — this is
  // what makes markAnswer() able to spot a fast, fully-formed answer.
  useEffect(() => {
    if (started && questions.length > 0 && !finished) markQuestionShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, questions.length, qIndex, finished]);

  const giveConsent = async () => {
    await api(`/api/sessions/${sessionId}/consent`, {
      method: 'POST',
      body: JSON.stringify({ consentText: CONSENT_TEXT, agentConsent }),
    });
    setConsented(true);
  };

  const startInterview = async () => {
    setError(null);
    try {
      // Camera + mic. Held in a ref and attached by the effect above once the
      // <video> element is actually rendered.
      camStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      // Screen share
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      watchScreenShare(screen);
    } catch (err) {
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current = null;
      setError(
        'Camera, microphone and screen sharing are all required to start. ' +
        'Please allow them and try again.'
      );
      return;
    }
    // Fullscreen lockdown
    await document.documentElement.requestFullscreen().catch(() => {});
    document.oncontextmenu = () => false; // disable right-click

    try {
      await api(`/api/sessions/${sessionId}/start`, { method: 'POST' });
    } catch (err: any) {
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current = null;
      setError(`Could not start the session: ${err.message}`);
      return;
    }
    setStarted(true);
  };

  const submitAnswer = async () => {
    const q = questions[qIndex];
    if (!q || submitting) return;
    setSubmitting(true);
    // Fire the behavioural signal BEFORE resetting state — markAnswer compares
    // the answer length against how long the question has been on screen.
    markAnswer(answer.length);
    try {
      await api(`/api/sessions/${sessionId}/answers`, {
        method: 'POST',
        body: JSON.stringify({ questionId: q.id, answerText: answer }),
      });
    } catch (err) {
      console.error('Failed to submit answer:', err);
    }
    setAnswer('');
    setSubmitting(false);
    if (qIndex + 1 >= questions.length) setFinished(true);
    else setQIndex((i) => i + 1);
  };

  if (!consented) {
    return (
      <div style={wrap}>
        <h1>Interview Integrity Monitoring</h1>
        <div style={box}>{CONSENT_TEXT}</div>
        {requireAgent && (
          <label style={{ display: 'block', margin: '12px 0' }}>
            <input type="checkbox" checked={agentConsent} onChange={(e) => setAgentConsent(e.target.checked)} />{' '}
            I also consent to running the desktop integrity agent (required for this interview).
          </label>
        )}
        <label style={{ display: 'block', margin: '12px 0' }}>
          <input type="checkbox" id="c" /> I understand and consent to interview integrity monitoring.
        </label>
        <button
          style={primary}
          onClick={() => {
            const ok = (document.getElementById('c') as HTMLInputElement)?.checked;
            if (!ok) return alert('Please tick the consent checkbox.');
            if (requireAgent && !agentConsent) return alert('This interview requires the desktop agent.');
            giveConsent();
          }}
        >
          I Consent — Continue
        </button>
      </div>
    );
  }

  if (!started) {
    return (
      <div style={wrap}>
        <h1>Ready to begin</h1>
        {requireAgent && (
          <div style={box}>
            Please download and run the <b>Interview Integrity Agent</b>, paste this session ID into it,
            and consent there too:<br /><code>{sessionId}</code>
          </div>
        )}
        <p>Starting will request camera, microphone, and screen sharing, and enter fullscreen.</p>
        {error && <div style={errorBox}>{error}</div>}
        <button style={primary} onClick={startInterview}>Start Interview</button>
      </div>
    );
  }

  const current = questions[qIndex];

  return (
    <div style={wrap}>
      <h2>Interview in progress</h2>
      <video ref={videoRef} autoPlay muted playsInline style={{ width: 240, borderRadius: 8, background: '#000' }} />
      <p style={{ color: '#6b7280' }}>Monitoring is active. Do not exit fullscreen or switch tabs.</p>

      {finished ? (
        <div style={box}>
          <b>All questions answered.</b> Thank you — you can stop here.
        </div>
      ) : !current ? (
        <div style={box}>Loading questions…</div>
      ) : (
        <div style={{ ...box, background: '#fff', border: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
            Question {qIndex + 1} of {questions.length}
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 14 }}>{current.prompt}</div>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer…"
            rows={8}
            style={{
              width: '100%', boxSizing: 'border-box', padding: 12, fontSize: 14,
              fontFamily: 'inherit', lineHeight: 1.5, borderRadius: 8,
              border: '1px solid #d1d5db', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
            <button style={primary} onClick={submitAnswer} disabled={submitting || !answer.trim()}>
              {submitting ? 'Submitting…' : qIndex + 1 >= questions.length ? 'Submit & Finish' : 'Submit & Next'}
            </button>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>{answer.length} characters</span>
          </div>
        </div>
      )}
    </div>
  );
}

const wrap: React.CSSProperties = { fontFamily: 'system-ui', maxWidth: 640, margin: '40px auto', padding: 20 };
const box: React.CSSProperties = { background: '#f5f5f5', borderRadius: 8, padding: 16, lineHeight: 1.5 };
const errorBox: React.CSSProperties = { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: 12, marginTop: 12, lineHeight: 1.5 };
const primary: React.CSSProperties = { marginTop: 16, padding: '12px 20px', background: '#2563eb', color: '#fff', border: 0, borderRadius: 8, cursor: 'pointer', fontSize: 15 };

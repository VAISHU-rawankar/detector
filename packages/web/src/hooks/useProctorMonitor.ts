import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

// Emits normalized browser events over the socket. These are BEHAVIORAL signals
// (suspicious activity), NOT proof of an AI tool — the agent handles tool detection.
export function useProctorMonitor(socket: Socket | null, sessionId: string, active: boolean) {
  const pasteTimestamps = useRef<number[]>([]);
  const lastQuestionShownAt = useRef<number>(Date.now());

  useEffect(() => {
    if (!socket || !active) return;
    const emit = (type: string, payload: any = {}) =>
      socket.emit('browser-event', { sessionId, type, payload });

    const onVisibility = () => {
      if (document.hidden) emit('TAB_SWITCH', { at: Date.now() });
    };
    const onBlur = () => emit('WINDOW_BLUR');
    const onFocus = () => emit('WINDOW_FOCUS');

    const onCopy = () => emit('COPY');
    const onCut = () => emit('CUT');
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      emit('PASTE', { length: text.length });
      // Paste-burst: many large pastes in a short window → strong behavioral signal.
      const now = Date.now();
      pasteTimestamps.current.push(now);
      pasteTimestamps.current = pasteTimestamps.current.filter((t) => now - t < 10000);
      if (pasteTimestamps.current.length >= 3 || text.length > 400) {
        emit('PASTE_BURST', { count: pasteTimestamps.current.length, length: text.length });
      }
    };

    const onFullscreen = () => {
      if (!document.fullscreenElement) emit('FULLSCREEN_EXIT');
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    document.addEventListener('fullscreenchange', onFullscreen);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [socket, sessionId, active]);

  // Call when a new question is shown, and when the candidate submits an answer.
  const markQuestionShown = () => { lastQuestionShownAt.current = Date.now(); };
  const markAnswer = (answerLength: number) => {
    if (!socket) return;
    const elapsed = Date.now() - lastQuestionShownAt.current;
    // "Lag loop": long silence then a large, complete answer can indicate tool assistance.
    if (elapsed < 4000 && answerLength > 300) {
      socket.emit('browser-event', {
        sessionId, type: 'ANSWER_LATENCY_ANOMALY',
        payload: { elapsedMs: elapsed, answerLength, pattern: 'fast-large-answer' },
      });
    }
  };

  // Monitor screen-share track ending.
  const watchScreenShare = (stream: MediaStream) => {
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () =>
        socket?.emit('browser-event', { sessionId, type: 'SCREEN_SHARE_STOPPED', payload: {} })
      );
    });
  };

  return { markQuestionShown, markAnswer, watchScreenShare };
}

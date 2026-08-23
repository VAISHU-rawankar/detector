// Matches raw OS scan output against detection signatures and produces
// NormalizedSignal payloads to send to the backend webhook.
//
// The signature list is fetched from the backend at agent start (kept server-side,
// never bundled in the shipped agent). For offline/dev, a small default is inlined.

export interface Signature {
  id?: string;
  toolName: string;
  signatureType: string; // PROCESS_NAME | WINDOW_TITLE | CODE_SIGNER | AUDIO_DEVICE
  signatureData: string; // regex
  confidence: number;
}

export interface RawScan {
  captureExcludedWindows?: Array<{ title: string; pid: number; processName?: string; path?: string }>;
  processes?: Array<{ name?: string; pid?: number; windowTitle?: string; signer?: string; path?: string }>;
  audioDevices?: Array<{ name?: string } | string>;
  windows?: Array<{ owner: string; title: string }>; // macOS
}

export interface AgentSignal {
  method: 'CAPTURE_EXCLUDED_WINDOW' | 'PROCESS_SIGNATURE' | 'AUDIO_LOOPBACK';
  toolName: string | null;
  confidence: number;
  evidence: Record<string, unknown>;
  signatureId?: string | null;
}

const DEFAULT_SIGNATURES: Signature[] = [
  { toolName: 'Cluely', signatureType: 'PROCESS_NAME', signatureData: '(?i)cluely', confidence: 60 },
  { toolName: 'Cluely', signatureType: 'WINDOW_TITLE', signatureData: '(?i)cluely', confidence: 65 },
  { toolName: 'Cluely', signatureType: 'CODE_SIGNER', signatureData: '(?i)cluely', confidence: 80 },
  { toolName: 'Parakeet', signatureType: 'PROCESS_NAME', signatureData: '(?i)parakeet', confidence: 60 },
  { toolName: 'Parakeet', signatureType: 'AUDIO_DEVICE', signatureData: '(?i)(vb-audio|blackhole|virtual|loopback)', confidence: 55 },
  { toolName: 'Final Round', signatureType: 'PROCESS_NAME', signatureData: '(?i)final ?round', confidence: 60 },
  { toolName: 'Interview Coder', signatureType: 'PROCESS_NAME', signatureData: '(?i)interview ?coder', confidence: 60 },
];

function rx(pattern: string): RegExp {
  // Support inline (?i) flag by stripping and applying 'i'.
  const ci = pattern.startsWith('(?i)');
  return new RegExp(ci ? pattern.slice(4) : pattern, ci ? 'i' : '');
}

export function matchScan(scan: RawScan, signatures: Signature[] = DEFAULT_SIGNATURES): AgentSignal[] {
  const signals: AgentSignal[] = [];

  // 1. Capture-excluded windows — strongest signal, fires regardless of name match.
  for (const w of scan.captureExcludedWindows ?? []) {
    // Try to attribute to a known tool via title/process; else report as generic.
    let toolName: string | null = null;
    let confidence = 85; // high on its own — hiding from capture during interview
    for (const s of signatures) {
      if (s.signatureType === 'WINDOW_TITLE' && rx(s.signatureData).test(w.title)) {
        toolName = s.toolName;
        confidence = Math.max(confidence, s.confidence + 10);
      }
      if (s.signatureType === 'PROCESS_NAME' && w.processName && rx(s.signatureData).test(w.processName)) {
        toolName = s.toolName;
        confidence = Math.max(confidence, s.confidence + 10);
      }
    }
    signals.push({
      method: 'CAPTURE_EXCLUDED_WINDOW',
      toolName,
      confidence: Math.min(confidence, 98),
      evidence: { windowTitle: w.title, processName: w.processName, path: w.path, note: 'Window excluded from screen capture' },
    });
  }

  // 2. Process signatures (name / window title / signer).
  for (const p of scan.processes ?? []) {
    for (const s of signatures) {
      let hit = false;
      if (s.signatureType === 'PROCESS_NAME' && p.name && rx(s.signatureData).test(p.name)) hit = true;
      if (s.signatureType === 'WINDOW_TITLE' && p.windowTitle && rx(s.signatureData).test(p.windowTitle)) hit = true;
      if (s.signatureType === 'CODE_SIGNER' && p.signer && rx(s.signatureData).test(p.signer)) hit = true;
      if (hit) {
        signals.push({
          method: 'PROCESS_SIGNATURE',
          toolName: s.toolName,
          confidence: s.confidence,
          evidence: { processName: p.name, windowTitle: p.windowTitle, signer: p.signer, matchedOn: s.signatureType },
          signatureId: s.id ?? null,
        });
      }
    }
  }

  // macOS windows fallback (no affinity flag available without Swift helper)
  for (const w of scan.windows ?? []) {
    for (const s of signatures) {
      if ((s.signatureType === 'WINDOW_TITLE' || s.signatureType === 'PROCESS_NAME') &&
          (rx(s.signatureData).test(w.title) || rx(s.signatureData).test(w.owner))) {
        signals.push({
          method: 'PROCESS_SIGNATURE',
          toolName: s.toolName,
          confidence: s.confidence,
          evidence: { owner: w.owner, windowTitle: w.title, matchedOn: s.signatureType },
          signatureId: s.id ?? null,
        });
      }
    }
  }

  // 3. Audio devices (virtual/loopback → audio-listening assistants like Parakeet).
  for (const d of scan.audioDevices ?? []) {
    const name = typeof d === 'string' ? d : d.name ?? '';
    for (const s of signatures) {
      if (s.signatureType === 'AUDIO_DEVICE' && rx(s.signatureData).test(name)) {
        signals.push({
          method: 'AUDIO_LOOPBACK',
          toolName: s.toolName,
          confidence: s.confidence,
          evidence: { audioDevice: name },
          signatureId: s.id ?? null,
        });
      }
    }
  }

  // De-duplicate identical signals in one scan.
  const seen = new Set<string>();
  return signals.filter((sig) => {
    const key = `${sig.method}|${sig.toolName}|${JSON.stringify(sig.evidence)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

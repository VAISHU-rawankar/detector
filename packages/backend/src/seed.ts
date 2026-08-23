import { connectDB } from './lib/db';
import { DetectionSignature } from './models';
import mongoose from 'mongoose';

// Living signature list — keep updated (arms race). Server-side only.
const SIGNATURES = [
  // ── Cluely ────────────────────────────────────────────────────────────────
  { toolName: 'Cluely', signatureType: 'PROCESS_NAME', signatureData: '(?i)cluely', confidence: 60 },
  { toolName: 'Cluely', signatureType: 'WINDOW_TITLE', signatureData: '(?i)cluely', confidence: 65 },
  { toolName: 'Cluely', signatureType: 'CODE_SIGNER', signatureData: '(?i)cluely', confidence: 80 },

  // ── Parakeet ──────────────────────────────────────────────────────────────
  { toolName: 'Parakeet', signatureType: 'PROCESS_NAME', signatureData: '(?i)parakeet', confidence: 60 },
  { toolName: 'Parakeet', signatureType: 'WINDOW_TITLE', signatureData: '(?i)parakeet', confidence: 65 },
  { toolName: 'Parakeet', signatureType: 'CODE_SIGNER', signatureData: '(?i)parakeet', confidence: 80 },

  // ── Final Round ───────────────────────────────────────────────────────────
  { toolName: 'Final Round', signatureType: 'PROCESS_NAME', signatureData: '(?i)final ?round', confidence: 60 },
  { toolName: 'Final Round', signatureType: 'WINDOW_TITLE', signatureData: '(?i)final ?round', confidence: 65 },
  { toolName: 'Final Round', signatureType: 'CODE_SIGNER', signatureData: '(?i)final ?round', confidence: 80 },

  // ── Interview Coder ───────────────────────────────────────────────────────
  { toolName: 'Interview Coder', signatureType: 'PROCESS_NAME', signatureData: '(?i)interview ?coder', confidence: 60 },
  { toolName: 'Interview Coder', signatureType: 'WINDOW_TITLE', signatureData: '(?i)interview ?coder', confidence: 65 },
  { toolName: 'Interview Coder', signatureType: 'CODE_SIGNER', signatureData: '(?i)interview ?coder', confidence: 80 },

  // ── LockedIn AI ───────────────────────────────────────────────────────────
  { toolName: 'LockedIn AI', signatureType: 'PROCESS_NAME', signatureData: '(?i)lockedin', confidence: 60 },
  { toolName: 'LockedIn AI', signatureType: 'WINDOW_TITLE', signatureData: '(?i)lockedin', confidence: 65 },
  { toolName: 'LockedIn AI', signatureType: 'CODE_SIGNER', signatureData: '(?i)lockedin', confidence: 80 },

  // ── Virtual / loopback audio (Parakeet-style listeners) ───────────────────
  // Named products only. The bare word "virtual" used to be in this pattern and
  // matches innocent hardware — NVIDIA Broadcast, OBS, Teams and Realtek all
  // register devices called "... Virtual Audio Device" on a clean machine.
  {
    toolName: 'Virtual audio device',
    signatureType: 'AUDIO_DEVICE',
    signatureData: '(?i)(vb-?audio|vb-?cable|voicemeeter|blackhole|soundflower|virtual audio cable|loopback audio)',
    confidence: 55,
  },

  // ── Generic AI chat surfaces ──────────────────────────────────────────────
  // Deliberately low confidence: these match a browser tab TITLE, which is not
  // evidence of use during the interview. Kept below STRONG_SIGNAL_MIN_CONFIDENCE
  // so they can only ever corroborate, never accuse on their own.
  { toolName: 'ChatGPT', signatureType: 'WINDOW_TITLE', signatureData: '(?i)chatgpt', confidence: 40 },
  { toolName: 'Gemini', signatureType: 'WINDOW_TITLE', signatureData: '(?i)\bgemini\b', confidence: 35 },
  { toolName: 'Claude', signatureType: 'WINDOW_TITLE', signatureData: '(?i)\bclaude\b', confidence: 35 },
];

async function main() {
  await connectDB();
  await DetectionSignature.deleteMany({});
  await DetectionSignature.insertMany(SIGNATURES);
  console.log(`Seeded ${SIGNATURES.length} detection signatures.`);
  await mongoose.disconnect();
}
main();

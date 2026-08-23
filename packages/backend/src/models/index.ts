import mongoose, { Schema, Types } from 'mongoose';

// MongoDB collections mirroring the previous relational design.
// Relations = ObjectId refs. Event/Detection/Audit collections are append-only in app logic.

const { model } = mongoose;
const ref = (name: string) => ({ type: Schema.Types.ObjectId, ref: name });

// ── Org & Users ─────────────────────────────────────────────────────────────
const CompanySchema = new Schema({
  name: { type: String, required: true },
}, { timestamps: true });

const UserSchema = new Schema({
  company: ref('Company'),
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  fullName: { type: String, required: true },
  role: { type: String, enum: ['ADMIN', 'INTERVIEWER', 'CANDIDATE'], default: 'CANDIDATE' },
}, { timestamps: true });

// ── Interviews ──────────────────────────────────────────────────────────────
const InterviewSchema = new Schema({
  company: ref('Company'),
  interviewer: ref('User'),
  title: { type: String, required: true },
  scheduledAt: Date,
  requireAgent: { type: Boolean, default: false },
}, { timestamps: true });

const SESSION_STATUS = ['PENDING', 'CONSENTED', 'ACTIVE', 'PAUSED', 'TERMINATED', 'COMPLETED'];
const InterviewSessionSchema = new Schema({
  interview: ref('Interview'),
  candidate: ref('User'),
  status: { type: String, enum: SESSION_STATUS, default: 'PENDING' },
  startedAt: Date,
  endedAt: Date,
  agentConnected: { type: Boolean, default: false },
}, { timestamps: true });

const QuestionSchema = new Schema({
  interview: ref('Interview'),
  prompt: { type: String, required: true },
  order: { type: Number, default: 0 },
});

const CodingQuestionSchema = new Schema({
  interview: ref('Interview'),
  title: String,
  prompt: String,
  language: { type: String, default: 'javascript' },
  starterCode: { type: String, default: '' },
  order: { type: Number, default: 0 },
});

const CandidateAnswerSchema = new Schema({
  session: ref('InterviewSession'),
  question: ref('Question'),
  answerText: String,
}, { timestamps: true });

const CodeSubmissionSchema = new Schema({
  session: ref('InterviewSession'),
  codingQuestion: ref('CodingQuestion'),
  code: String,
  pasteBurstCount: { type: Number, default: 0 },
  keystrokeCount: { type: Number, default: 0 },
}, { timestamps: true });

// ── Events & Detection ──────────────────────────────────────────────────────
export const EVENT_TYPES = [
  'TAB_SWITCH', 'WINDOW_BLUR', 'WINDOW_FOCUS', 'COPY', 'PASTE', 'CUT',
  'FULLSCREEN_EXIT', 'SCREEN_SHARE_STOPPED', 'CAMERA_OFF', 'MIC_OFF',
  'PASTE_BURST', 'ANSWER_LATENCY_ANOMALY',
  'AGENT_CONNECTED', 'AGENT_DISCONNECTED', 'AGENT_HEARTBEAT_MISSED',
  // Webcam frame analysis (ai-service). A second person in frame is human
  // assistance, not AI assistance — kept as a behavioural event rather than a
  // DetectionEvent so it never claims an AI tool was found.
  'MULTIPLE_FACES', 'NO_FACE_DETECTED',
];
const InterviewEventSchema = new Schema({
  session: { ...ref('InterviewSession'), index: true },
  type: { type: String, enum: EVENT_TYPES, index: true },
  source: { type: String, enum: ['BROWSER', 'AGENT', 'AI_SERVICE', 'SYSTEM'] },
  payload: Schema.Types.Mixed,
  weight: { type: Number, default: 0 },
  occurredAt: { type: Date, default: Date.now, index: true },
});

export const DETECTION_METHODS = [
  'CAPTURE_EXCLUDED_WINDOW', 'PROCESS_SIGNATURE', 'AUDIO_LOOPBACK',
  'GLOBAL_HOTKEY', 'SCREEN_UI', 'BEHAVIORAL_CORRELATION',
];
const DetectionEventSchema = new Schema({
  session: { ...ref('InterviewSession'), index: true },
  event: ref('InterviewEvent'),
  method: { type: String, enum: DETECTION_METHODS },
  signature: ref('DetectionSignature'),
  toolName: { type: String, index: true },
  confidence: { type: Number, required: true },
  evidence: Schema.Types.Mixed,
  // Stable hash of method + tool + evidence. Providers re-report the same finding
  // on every scan cycle, so without this one running tool becomes dozens of
  // identical rows and the report reads "Cluely 50x" for three actual findings.
  dedupeKey: { type: String, index: true },
  occurredAt: { type: Date, default: Date.now },
});

const SIGNATURE_TYPES = ['PROCESS_NAME', 'PROCESS_HASH', 'CODE_SIGNER', 'WINDOW_TITLE', 'AUDIO_DEVICE', 'HOTKEY', 'UI_TEMPLATE'];
const DetectionSignatureSchema = new Schema({
  toolName: { type: String, index: true },
  signatureType: { type: String, enum: SIGNATURE_TYPES },
  signatureData: String,
  confidence: { type: Number, default: 70 },
  enabled: { type: Boolean, default: true, index: true },
}, { timestamps: true });

const RISK_LEVELS = ['NORMAL', 'SUSPICIOUS', 'HIGH_RISK', 'CRITICAL'];
const RiskScoreSchema = new Schema({
  session: { ...ref('InterviewSession'), index: true },
  score: Number,
  level: { type: String, enum: RISK_LEVELS },
  breakdown: Schema.Types.Mixed,
}, { timestamps: true });

// ── Consent / Records ───────────────────────────────────────────────────────
const ConsentRecordSchema = new Schema({
  session: { ...ref('InterviewSession'), unique: true },
  consentText: String,
  agentConsent: { type: Boolean, default: false },
  ipAddress: String,
  userAgent: String,
  consentedAt: { type: Date, default: Date.now },
});

const RecordingSchema = new Schema({
  session: ref('InterviewSession'),
  kind: String,
  s3Key: String,
  retainUntil: Date,
}, { timestamps: true });

const InterviewEvaluationSchema = new Schema({
  session: { ...ref('InterviewSession'), unique: true },
  verdict: String,
  notes: { type: String, default: '' },
  evaluatedBy: String,
}, { timestamps: true });

const NotificationSchema = new Schema({
  user: ref('User'),
  title: String,
  body: String,
  read: { type: Boolean, default: false },
}, { timestamps: true });

const AuditLogSchema = new Schema({
  company: ref('Company'),
  actorId: String,
  action: String,
  meta: Schema.Types.Mixed,
}, { timestamps: true });

const SystemSettingSchema = new Schema({
  company: ref('Company'),
  key: String,
  value: Schema.Types.Mixed,
}, { timestamps: true });
SystemSettingSchema.index({ company: 1, key: 1 }, { unique: true });

export const Company = model('Company', CompanySchema);
export const User = model('User', UserSchema);
export const Interview = model('Interview', InterviewSchema);
export const InterviewSession = model('InterviewSession', InterviewSessionSchema);
export const Question = model('Question', QuestionSchema);
export const CodingQuestion = model('CodingQuestion', CodingQuestionSchema);
export const CandidateAnswer = model('CandidateAnswer', CandidateAnswerSchema);
export const CodeSubmission = model('CodeSubmission', CodeSubmissionSchema);
export const InterviewEvent = model('InterviewEvent', InterviewEventSchema);
export const DetectionEvent = model('DetectionEvent', DetectionEventSchema);
export const DetectionSignature = model('DetectionSignature', DetectionSignatureSchema);
export const RiskScore = model('RiskScore', RiskScoreSchema);
export const ConsentRecord = model('ConsentRecord', ConsentRecordSchema);
export const Recording = model('Recording', RecordingSchema);
export const InterviewEvaluation = model('InterviewEvaluation', InterviewEvaluationSchema);
export const Notification = model('Notification', NotificationSchema);
export const AuditLog = model('AuditLog', AuditLogSchema);
export const SystemSetting = model('SystemSetting', SystemSettingSchema);

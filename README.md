# Interview Integrity Platform — MERN (MongoDB Atlas)

MERN version: **MongoDB + Express + React + Node**. Same platform and detection core
as before; the data layer now uses **Mongoose + MongoDB Atlas** instead of PostgreSQL/Prisma.
Using Atlas (cloud) means **no local database install** — this avoids all the local
Postgres/password/port issues.

> **Honest truth about detection (unchanged):** no software detects Cluely/Parakeet/Final
> Round with 100% certainty. This produces a **risk score with evidence**, not a verdict.
> A renamed tool, a phone, or a human helper can still evade software. Every commercial
> product in this space has the same limit.

## The detection core (verified working)
- **Electron agent** finds **capture-excluded windows** (the mechanism Cluely uses to hide
  its overlay from screen capture), matches **process signatures** (name / Authenticode
  signer / window title), and flags **virtual/loopback audio devices** (Parakeet-style).
- Tested against a simulated scan: a **renamed binary** (`a7f3k9x2.exe`) hiding from capture
  was caught at 85% confidence; a named Cluely process + BlackHole audio were attributed.
- Provider-agnostic webhook: plug in **your own agent** or a **third-party vendor**
  (InterviewGuard / Zero Assist style) — both hit the same HMAC-signed endpoint.

## Packages
- `packages/backend` — Express + Socket.IO + **Mongoose**. Auth, consent, risk engine,
  detection ingest, webhook adapter.
- `packages/web` — React + Vite. Login, interviewer dashboard, candidate room.
- `packages/agent-go` — **desktop agent, single 7 MB binary, no installer.** This is
  the one to ship.
- `packages/agent` — the original Electron agent. Same detectors, ~200 MB, kept for
  reference.
- `packages/ai-service` — FastAPI + OpenCV webcam analysis (second person in frame).

---

## Step 1 — Create a free MongoDB Atlas cluster (no local install)

1. Go to https://www.mongodb.com/cloud/atlas/register and sign up (free).
2. Create a **free M0 cluster** (any cloud/region).
3. **Database Access** → Add a database user (username + password). Remember these.
4. **Network Access** → Add IP Address → **Allow Access from Anywhere** (0.0.0.0/0) for dev.
5. **Connect** → **Drivers** → copy the connection string. It looks like:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
6. Add the database name `interview` before the `?`:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/interview?retryWrites=true&w=majority`

(Prefer local? Install MongoDB Community and use `mongodb://localhost:27017/interview`.)

## Step 2 — Backend
```bash
cd packages/backend
cp .env.example .env
# paste your Atlas string into MONGODB_URI in .env, set JWT_SECRET + DETECTION_WEBHOOK_SECRET
npm install
npm run seed        # loads Cluely/Parakeet detection signatures into Atlas
npm run dev         # backend → http://localhost:4000  (long-running; keep this terminal open)
```
Check `http://localhost:4000/health` → `{"ok":true}`. **No migrations needed** — Mongoose
creates collections automatically.

## Step 3 — Web (new terminal)
```bash
cd packages/web
cp .env.example .env
npm install
npm run dev         # → http://localhost:5173
```

## Step 4 — Use it

Open http://localhost:5173 and register an **interviewer** account.

1. Create an interview → copy its **invite link** (`/join/<interviewId>`)
2. Open that link in another browser or a private window, register as a
   **candidate** — the session is created automatically
3. Candidate: consent → Start Interview → answer the questions
4. Interviewer: **Candidates → Monitor** to watch the live report

Tokens are kept in `localStorage`, so the only thing you ever share is the invite
link. Switching tabs or pasting a large answer will move the risk score.

## Step 5 — Desktop agent (real tool detection, new terminal)

Without the agent there is **no AI-tool detection at all** — a browser cannot see
other applications. Only behavioural signals are collected.

```bash
cd packages/agent-go
BACKEND_URL=http://localhost:4000 DETECTION_WEBHOOK_SECRET=<same secret as the backend> go build -o interview-integrity-agent.exe .
./interview-integrity-agent.exe
```

A consent page opens in your browser. Paste the session ID (shown in the
candidate room when the interview requires an agent), tick consent, and scans
begin. For distributable builds see `packages/agent-go/README.md` — the backend
URL has to be compiled in, because a candidate double-clicking the binary has no
environment variables.

## Step 6 — Webcam analysis (optional, new terminal)

```bash
cd packages/ai-service
pip install -r requirements.txt
BACKEND_URL=http://localhost:4000 DETECTION_WEBHOOK_SECRET=<same secret> uvicorn main:app --port 8000
```

The candidate's browser posts sampled frames here; more than one face in frame
raises `MULTIPLE_FACES`. Frames are analysed and discarded, never stored.

## Deploying

See [DEPLOY.md](DEPLOY.md) — Render for the backend and ai-service, Vercel for
the web app, and the agent built with its backend URL baked in.

## Risk scoring
Weights in `services/riskEngine.ts`. Levels: `0–29 NORMAL · 30–59 SUSPICIOUS · 60–79
HIGH_RISK · 80+ CRITICAL`. Weak signals are capped so tab-switch spam can't alone reach
CRITICAL; only strong AI signals unlock "POSSIBLE AI ASSISTANCE". CRITICAL + strong AI
signal → **auto-pause + human confirm** (never auto-terminate on an algorithm alone).

A detection below `STRONG_SIGNAL_MIN_CONFIDENCE` (50) counts as a hint, not proof:
a browser tab merely *titled* "Gemini" scores as `WEAK_AI_TOOL_HINT` and can never
produce an AI-assistance verdict on its own. Another person in the candidate's
camera is scored too, but as a behavioural signal — it is human assistance, not an
AI tool, and is reported with different wording.

## Privacy / legal
Consent stored before monitoring; agent visible + metadata-only + stops at end; signatures
stay server-side; termination is a human action. `DetectionSignature` is a living list you
must keep updated — this is an arms race.

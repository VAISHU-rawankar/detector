# Deploying to Render + Vercel

Four pieces have to end up in three different places, plus one that runs on the
candidate's own laptop.

| Piece | Where | Why there |
|---|---|---|
| `packages/backend` | **Render** (Web Service) | Socket.IO needs a long-lived process |
| `packages/web` | **Vercel** | static build, nothing server-side |
| `packages/ai-service` | **Render** (Web Service) | Python + OpenCV, receives frames |
| `packages/agent-go` | **the candidate's laptop** | only native code can see other apps |
| MongoDB | Atlas | already set up |

> **Backend cannot go on Vercel.** Socket.IO holds a persistent connection and
> serverless functions cannot. The live dashboard would silently stop updating.

---

## 1. Backend → Render

**New Web Service** → connect the repo.

| Setting | Value |
|---|---|
| Root Directory | `packages/backend` |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |

Environment variables:

```
MONGODB_URI      = mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/interview?retryWrites=true&w=majority
JWT_SECRET       = <64+ random hex chars>
DETECTION_WEBHOOK_SECRET = <64+ random hex chars>
CORS_ORIGIN      = https://your-app.vercel.app
NODE_ENV         = production
```

- `CORS_ORIGIN` takes a comma-separated list if you also want Vercel preview
  domains: `https://your-app.vercel.app,https://your-app-git-dev.vercel.app`
- `PORT` is injected by Render — do not set it.
- `NODE_ENV=production` turns on `trust proxy`, without which every consent
  record stores Render's proxy IP instead of the candidate's, and the rate
  limiter treats all traffic as one client. Override with `TRUST_PROXY` if your
  setup has a different hop count.

In **Atlas → Network Access**, allow Render's outbound IPs (or `0.0.0.0/0` for a
first deploy).

Then seed the signature list once, from the Render shell:

```bash
npx tsx src/seed.ts
```

Check `https://your-api.onrender.com/health` returns `{"ok":true}`.

> Render's free tier sleeps after inactivity. The first request after a sleep
> takes ~50s, which will look like a hang mid-interview. Use a paid instance for
> anything real.

---

## 2. ai-service → Render

**New Web Service** → same repo.

| Setting | Value |
|---|---|
| Root Directory | `packages/ai-service` |
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |

```
BACKEND_URL              = https://your-api.onrender.com
DETECTION_WEBHOOK_SECRET = <same secret as the backend>
WEB_ORIGIN               = https://your-app.vercel.app
```

`WEB_ORIGIN` must be exact — the candidate's browser posts frames straight to
this service, so its CORS list is what allows those requests.

---

## 3. Web → Vercel

**New Project** → same repo.

| Setting | Value |
|---|---|
| Root Directory | `packages/web` |
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |

```
VITE_BACKEND_URL    = https://your-api.onrender.com
VITE_AI_SERVICE_URL = https://your-ai.onrender.com
```

> **Vite bakes `VITE_*` into the bundle at build time.** Setting them after a
> build changes nothing — add them first, then deploy. If you change them later,
> redeploy.

---

## 4. Agent → build, then host the file

```bash
cd packages/agent-go
BACKEND_URL=https://your-api.onrender.com \
DETECTION_WEBHOOK_SECRET=<same secret as the backend> \
./build.sh
```

This produces `dist/interview-integrity-agent.exe` (~7 MB) plus macOS builds,
with the URL and secret compiled in.

**Do not skip the baking step.** The candidate double-clicks the file with no
environment set. A binary built without `-ldflags` falls back to
`http://localhost:4000`, delivers nothing, and the dashboard reads exactly like
a clean machine — the failure is invisible. A misbuilt binary now prints a
`WARNING` line at startup for exactly this reason.

Upload the binaries anywhere the candidate can download them — an S3/R2 bucket,
a GitHub Release, or serve them from the backend.

One build serves every candidate: the session ID is entered at run time on the
consent page, not compiled in.

---

## Ordering

`CORS_ORIGIN` needs the Vercel URL and `VITE_BACKEND_URL` needs the Render URL,
so:

1. Deploy the backend → note its URL
2. Deploy the web app with `VITE_BACKEND_URL` → note its URL
3. Set `CORS_ORIGIN` on the backend to the Vercel URL → redeploy backend
4. Deploy ai-service with both URLs
5. Build and upload the agent

---

## Known gaps before this is production-safe

These are real and none of them are fixed by deploying.

**Tokens travel in the URL.** `?token=eyJ...` lands in browser history, server
logs and referrer headers. There is also no login page — session links are
currently produced by hand (see below). This needs a real auth flow.

**The webhook secret ships inside the agent binary.** Anyone who downloads it
can extract the secret, forge detections against any session, or pull the whole
signature list. Production needs a short-lived per-candidate token instead of
one shared secret.

**The agent is unsigned.** Windows SmartScreen shows "Windows protected your PC";
macOS refuses to open it at all. Most candidates will not get past that. Signing
and notarisation are required.

**No tool detection without the agent.** If the candidate declines or cannot run
it, only browser-level behavioural signals remain — Cluely and Final Round will
not be detected at all. The dashboard shows `agentConnected`, so check it.

**Linux candidates are unsupported.** The agent's `runScan` returns an error.

---

## Creating sessions until there is a login page

There is no UI for signing in or creating an interview yet, so links are made
against the API directly:

```bash
API=https://your-api.onrender.com

# one-time: create the two accounts
curl -s -X POST $API/api/auth/register -H "content-type: application/json" \
  -d '{"email":"boss@example.com","password":"...","fullName":"Boss","role":"INTERVIEWER"}'
curl -s -X POST $API/api/auth/register -H "content-type: application/json" \
  -d '{"email":"cand@example.com","password":"...","fullName":"Cand","role":"CANDIDATE"}'

# per interview
IT=<interviewer token from login>
CT=<candidate token from login>
IID=$(curl -s -X POST $API/api/interviews -H "content-type: application/json" \
  -H "authorization: Bearer $IT" -d '{"title":"Round 1","requireAgent":true}' | jq -r ._id)
SID=$(curl -s -X POST $API/api/sessions -H "content-type: application/json" \
  -H "authorization: Bearer $CT" -d "{\"interviewId\":\"$IID\"}" | jq -r ._id)
```

Then hand out:

- Candidate — `https://your-app.vercel.app/?view=candidate&session=$SID&token=$CT&agent=1`
- Interviewer — `https://your-app.vercel.app/?view=interviewer&session=$SID&token=$IT`

Tokens expire after 8 hours.

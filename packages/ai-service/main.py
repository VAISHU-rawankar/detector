# Webcam frame analysis for the interview integrity platform.
#
# Reports HUMAN-assistance signals (a second person in frame, or nobody in
# frame). These are deliberately NOT sent to /webhook/detection: that endpoint
# records AI-tool detections, and another person on camera is a different kind
# of violation. They go to /webhook/event and are scored as behavioural signals.
#
# Detection uses OpenCV Haar cascades, which ship with opencv-python 4.x — no
# model download and no network access required.
import base64
import hashlib
import hmac
import json
import os
import time

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx

app = FastAPI()

BACKEND = os.getenv("BACKEND_URL", "http://localhost:4000")
SECRET = os.getenv("DETECTION_WEBHOOK_SECRET", "change-me-webhook").encode()
WEB_ORIGIN = os.getenv("WEB_ORIGIN", "http://localhost:5173")

# The candidate's browser posts frames directly, so it needs to be allowed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[WEB_ORIGIN],
    allow_methods=["POST"],
    allow_headers=["content-type"],
)

_FRONTAL = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
_PROFILE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")

# A single frame is noisy: a turned head drops to zero, a poster on the wall can
# flicker as a face. Only report once the same reading holds across several
# consecutive frames, and then no more often than the cooldown allows.
CONSECUTIVE_FRAMES_REQUIRED = 3
REPORT_COOLDOWN_SECONDS = 30

_streak: dict[str, tuple[str, int]] = {}
_last_reported: dict[str, dict[str, float]] = {}


class Frame(BaseModel):
    sessionId: str
    imageBase64: str


def _overlaps(a, b, tolerance: float = 0.5) -> bool:
    """True when two detections cover substantially the same region."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    smaller = min(aw * ah, bw * bh)
    return smaller > 0 and inter / smaller > tolerance


def count_faces(image: np.ndarray) -> list:
    """Faces in the frame, de-duplicated across the frontal and profile passes."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    faces = list(
        _FRONTAL.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(60, 60))
    )
    # Someone leaning in from the side is frontal-invisible but profile-visible.
    for p in _PROFILE.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(60, 60)):
        if not any(_overlaps(p, f) for f in faces):
            faces.append(p)
    return faces


def classify(face_count: int) -> str | None:
    if face_count >= 2:
        return "MULTIPLE_FACES"
    if face_count == 0:
        return "NO_FACE_DETECTED"
    return None


def should_report(session_id: str, verdict: str | None) -> bool:
    """Debounce: require a stable streak, then rate-limit repeats."""
    previous, count = _streak.get(session_id, (None, 0))
    count = count + 1 if verdict == previous else 1
    _streak[session_id] = (verdict, count)

    if verdict is None or count < CONSECUTIVE_FRAMES_REQUIRED:
        return False

    now = time.time()
    last = _last_reported.setdefault(session_id, {})
    if now - last.get(verdict, 0.0) < REPORT_COOLDOWN_SECONDS:
        return False
    last[verdict] = now
    return True


async def report_event(session_id: str, event_type: str, payload: dict) -> int | None:
    body = json.dumps({"sessionId": session_id, "type": event_type, "payload": payload})
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(
                f"{BACKEND}/api/webhook/event",
                content=body,
                headers={
                    "content-type": "application/json",
                    "x-detection-signature": sig,
                },
            )
            if res.status_code != 200:
                print(f"[ai-service] event rejected ({res.status_code}): {res.text}")
            return res.status_code
    except Exception as exc:  # backend down: log, do not crash the analyser
        print(f"[ai-service] event not delivered: {exc}")
        return None


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/analyze-frame")
async def analyze_frame(f: Frame):
    raw = f.imageBase64
    if "," in raw:  # strip a data: URL prefix if the browser sent one
        raw = raw.split(",", 1)[1]
    try:
        buf = np.frombuffer(base64.b64decode(raw), dtype=np.uint8)
        image = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except Exception:
        image = None
    if image is None:
        return {"error": "undecodable frame"}

    faces = count_faces(image)
    verdict = classify(len(faces))
    reported = False

    if should_report(f.sessionId, verdict):
        payload = {
            "faceCount": len(faces),
            "boxes": [[int(v) for v in box] for box in faces],
            "note": (
                "More than one face visible in the candidate's camera"
                if verdict == "MULTIPLE_FACES"
                else "No face visible in the candidate's camera"
            ),
        }
        await report_event(f.sessionId, verdict, payload)
        reported = True

    return {"faceCount": len(faces), "verdict": verdict, "reported": reported}

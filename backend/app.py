"""
EchoMind backend — FastAPI wrapper around the existing LangChain pipeline.

Run from the PROJECT ROOT (the folder containing core/, utils/, backend/, frontend/):

    uvicorn backend.app:app --reload --port 8000

Then open http://localhost:8000 — the backend also serves the frontend,
so there's nothing else to run.
"""

import asyncio
import time
import uuid
from pathlib import Path
from typing import Dict

from dotenv import load_dotenv

load_dotenv()  # must happen before core/ modules read API keys

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.pipeline_runner import PipelineError, STAGES, run_chat, run_pipeline

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="EchoMind API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this before deploying publicly
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory job store. Perfectly fine for a single-user / portfolio demo.
# If you ever run multiple workers or need persistence, swap this for
# Redis (job JSON) — CHAINS would need to move to something process-local
# per worker either way, since LangChain runnables aren't serializable.
# ---------------------------------------------------------------------------
JOBS: Dict[str, dict] = {}
CHAINS: Dict[str, object] = {}  # rag_chain objects — never sent to the client


class CreateJobRequest(BaseModel):
    source: str = Field(..., description="YouTube URL (or a local file path on the server)")
    language: str = Field("english", pattern="^(english|hinglish)$")


class ChatRequest(BaseModel):
    question: str


def _new_job(source: str, language: str) -> str:
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {
        "id": job_id,
        "source": source,
        "language": language,
        "status": "queued",
        "message": "Queued…",
        "progress": 0,
        "result": None,
        "error": None,
        "created_at": time.time(),
    }
    return job_id


def _run_job_sync(job_id: str, source: str, language: str):
    """Runs on a worker thread (blocking) — see create_job()."""

    def on_update(stage, message, progress):
        job = JOBS.get(job_id)
        if job is None:
            return
        job["status"] = stage
        job["message"] = message
        job["progress"] = progress

    try:
        result = run_pipeline(source, language, on_update)
        rag_chain = result.pop("rag_chain")
        CHAINS[job_id] = rag_chain
        JOBS[job_id]["result"] = result
        JOBS[job_id]["status"] = "ready"
        JOBS[job_id]["progress"] = 100
        JOBS[job_id]["message"] = "Ready — ask away."
    except PipelineError as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = {"stage": e.stage, "message": e.message}
        JOBS[job_id]["message"] = e.message
    except Exception as e:  # belt and braces — should already be a PipelineError
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = {"stage": "unknown", "message": str(e)}
        JOBS[job_id]["message"] = str(e)


@app.get("/api/stages")
def get_stages():
    """Lets the frontend render the pipeline steps without hardcoding them."""
    return {"stages": [{"key": k, "label": l, "progress": p} for k, l, p in STAGES]}


@app.post("/api/jobs")
async def create_job(req: CreateJobRequest):
    source = req.source.strip()
    if not source:
        raise HTTPException(400, "source is required")

    job_id = _new_job(source, req.language)
    loop = asyncio.get_event_loop()
    # Fire-and-forget: the heavy pipeline runs on a thread-pool worker so
    # the event loop stays free to serve the WebSocket status updates.
    loop.run_in_executor(None, _run_job_sync, job_id, source, req.language)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@app.websocket("/ws/jobs/{job_id}")
async def job_socket(websocket: WebSocket, job_id: str):
    await websocket.accept()

    if job_id not in JOBS:
        await websocket.send_json({"status": "error", "message": "unknown job id", "progress": 0})
        await websocket.close()
        return

    try:
        last_sent = None
        while True:
            job = JOBS[job_id]
            snapshot = (job["status"], job["progress"], job["message"])
            if snapshot != last_sent:
                await websocket.send_json(
                    {
                        "status": job["status"],
                        "message": job["message"],
                        "progress": job["progress"],
                        "result": job["result"],
                        "error": job["error"],
                    }
                )
                last_sent = snapshot
            if job["status"] in ("ready", "error"):
                break
            await asyncio.sleep(0.35)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass  # already closed


@app.post("/api/jobs/{job_id}/chat")
async def chat(job_id: str, req: ChatRequest):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["status"] != "ready":
        raise HTTPException(409, "this job isn't ready for questions yet")

    rag_chain = CHAINS.get(job_id)
    if rag_chain is None:
        raise HTTPException(500, "index missing for this job")

    question = req.question.strip()
    if not question:
        raise HTTPException(400, "question is required")

    loop = asyncio.get_event_loop()
    answer = await loop.run_in_executor(None, run_chat, rag_chain, question)
    return {"answer": answer}


# ---------------------------------------------------------------------------
# Serve the frontend, so `uvicorn backend.app:app` is the only command
# needed to run the whole thing.
# ---------------------------------------------------------------------------
STATIC_DIR = FRONTEND_DIR / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(404, "frontend/index.html not found")
    return FileResponse(index_path)

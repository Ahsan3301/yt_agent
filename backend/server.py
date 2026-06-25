"""
backend/server.py — FastAPI wrapper around the YT Agent pipeline.

Endpoints:
  GET  /api/health                     liveness
  GET  /api/settings                   read settings.json
  PUT  /api/settings                   write settings.json
  GET  /api/keys                       per-key set/unset status
  PUT  /api/keys                       update .env keys
  POST /api/run                        kick off pipeline (background thread)
  GET  /api/state                      current run_state (poll for progress)
  POST /api/cancel                     mark current run cancelled
  GET  /api/runs                       list past runs (most recent first)
  GET  /api/runs/{id}                  detailed summary for one run
  GET  /api/runs/{id}/video            stream the run's final_video.mp4
  DELETE /api/runs/{id}                remove a run's output directory
  GET  /api/preflight                  run config.preflight() and return result

Launch with:
  python -m uvicorn backend.server:app --reload --port 8000
"""
import os
import sys
import json
import shutil
import logging
import threading
from pathlib import Path
from typing import Optional, Any

from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv, set_key, unset_key

# Make project root importable.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

load_dotenv()
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("backend")

from modules.config import load_settings, save_settings, preflight, PreflightError  # noqa: E402
from modules import run_state  # noqa: E402
from backend import jobs, registry, storage, idle_watchdog, keys_sync  # noqa: E402

RUNS_DIR = ROOT / "output" / "videos"
ENV_PATH = ROOT / ".env"

API_KEY_FIELDS = [
    "GROQ_API_KEY",
    "NVIDIA_NIM_API_KEY",
    "SHUTTERSTOCK_API_TOKEN",
    "SHUTTERSTOCK_CLIENT_ID",
    "SHUTTERSTOCK_CLIENT_SECRET",
    "PEXELS_API_KEY",
    "PIXABAY_API_KEY",
    "COVERR_API_KEY",
]

# ── App + CORS ────────────────────────────────────────────────
app = FastAPI(title="YT Agent API", version="1.0")

# CORS: localhost for dev + any Vercel preview/production URL the user
# configures via env. Vercel domains are *.vercel.app; we use a regex so
# the user doesn't have to list each deployment.
_extra_origins = [o for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        *_extra_origins,
    ],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _touch_idle_watchdog(request, call_next):
    """Every HTTP request counts as activity — keeps the Colab session
    alive while a user is on the dashboard, even between jobs."""
    idle_watchdog.touch()
    return await call_next(request)


@app.on_event("startup")
def _on_startup():
    # Pull the shared API keys from Hostinger BEFORE anything else so
    # downstream modules see the right env vars when they're imported
    # lazily on first request.
    try:
        keys_sync.pull_into_env()
    except Exception as e:
        log.warning(f"keys_sync.pull_into_env failed: {e}")
    # Heartbeat: publish this backend's URL to the Hostinger registry.
    try:
        registry.start()
    except Exception as e:
        log.warning(f"registry.start failed: {e}")
    # Idle watchdog: auto-terminate the session after N minutes of quiet
    # so we don't burn the Colab free-tier compute budget overnight.
    try:
        idle_watchdog.start()
    except Exception as e:
        log.warning(f"idle_watchdog.start failed: {e}")


@app.on_event("shutdown")
def _on_shutdown():
    try:
        registry.deregister()
    except Exception:
        pass


# ── Health + preflight ────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/preflight")
def preflight_check(skip_upload: bool = True):
    try:
        preflight(skip_upload=skip_upload)
        return {"ok": True}
    except PreflightError as e:
        return JSONResponse(status_code=200, content={"ok": False, "error": str(e)})


# ── Settings ──────────────────────────────────────────────────
@app.get("/api/settings")
def get_settings():
    return load_settings()


@app.put("/api/settings")
def put_settings(payload: dict = Body(...)):
    if not isinstance(payload, dict):
        raise HTTPException(400, "expected a settings object")
    save_settings(payload)
    return {"ok": True}


# ── API keys (.env) ───────────────────────────────────────────
def _mask(v: str) -> str:
    if not v:
        return ""
    if len(v) <= 8:
        return "*" * len(v)
    return v[:4] + "*" * (len(v) - 8) + v[-4:]


@app.get("/api/keys")
def get_keys():
    """
    Returns the merged view of each managed key:
      - the central store on Hostinger (authoritative for managed keys),
      - falling back to local env vars for bootstrap-only ones (FTP_*, etc.).
    Frontend renders these as set/unset chips with masked values.
    """
    if not storage.is_configured():
        # Central store isn't available on this backend; degrade gracefully
        # to local-env display so the user can still see what's set.
        out = {}
        for k in API_KEY_FIELDS:
            v = os.getenv(k, "")
            out[k] = {"set": bool(v), "masked": _mask(v), "managed": False}
        return out

    central = keys_sync.central_status()
    # Bootstrap-only keys (not in MANAGED_KEYS) still come from env.
    for k in API_KEY_FIELDS:
        if k in central:
            continue
        v = os.getenv(k, "")
        central[k] = {"set": bool(v), "masked": _mask(v), "managed": False}
    # OAuth file presence is local-only.
    central["YOUTUBE_CLIENT_SECRETS_FILE"] = {
        "set": (ROOT / os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secret.json")).exists(),
        "masked": os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secret.json"),
        "managed": False,
    }
    return central


class KeysPayload(BaseModel):
    updates: dict[str, Optional[str]]


@app.put("/api/keys")
def put_keys(payload: KeysPayload):
    """
    Persists the update.  Managed keys go to the shared Hostinger keys.json
    so every other backend picks them up on its next pull. Unmanaged keys
    (FTP_*, PUBLIC_*) update only the local .env (which usually shouldn't
    happen via the dashboard, but we tolerate it for completeness).
    """
    managed_updates = {}
    local_updates = {}
    for k, v in payload.updates.items():
        if k in keys_sync.MANAGED_KEYS:
            managed_updates[k] = v
        elif k in API_KEY_FIELDS:
            local_updates[k] = v

    if managed_updates:
        if not storage.is_configured():
            raise HTTPException(503, "FTP storage not configured — cannot push to central store")
        keys_sync.push_from_payload(managed_updates)

    if local_updates:
        ENV_PATH.touch(exist_ok=True)
        for k, v in local_updates.items():
            if v:
                set_key(str(ENV_PATH), k, v)
                os.environ[k] = v
            else:
                try:
                    unset_key(str(ENV_PATH), k)
                except Exception:
                    pass
                os.environ.pop(k, None)

    return {"ok": True, "central_updated": len(managed_updates),
            "local_updated": len(local_updates)}


@app.post("/api/keys/reload")
def reload_keys():
    """Force this backend to re-pull keys.json from Hostinger. Useful after
    another backend updated the central store."""
    applied = keys_sync.pull_into_env()
    return {"ok": True, "applied": list(applied.keys())}


# ── Run state + control ───────────────────────────────────────
@app.get("/api/state")
def get_state():
    return run_state.read()


class RunRequest(BaseModel):
    channel: Optional[str] = None
    dry_run: bool = True


_run_lock = threading.Lock()
_run_thread: Optional[threading.Thread] = None


@app.post("/api/run")
def start_run(req: RunRequest):
    global _run_thread
    cur = run_state.read()
    if cur.get("status") == "running":
        raise HTTPException(409, "a run is already in progress")

    settings = load_settings()
    channel = req.channel or settings["content"]["channel"]

    def worker():
        try:
            from main import run_pipeline
            run_pipeline(channel_type=channel, dry_run=req.dry_run)
        except Exception as e:
            log.exception(f"pipeline crash: {e}")
            try:
                run_state.finish(ok=False, error=repr(e))
            except Exception:
                pass

    with _run_lock:
        _run_thread = threading.Thread(target=worker, daemon=True)
        _run_thread.start()

    return {"ok": True, "channel": channel, "dry_run": req.dry_run}


@app.post("/api/cancel")
def cancel_run():
    cur = run_state.read()
    if cur.get("status") != "running":
        return {"ok": True, "noop": True}
    run_state.finish(ok=False, error="cancelled by user")
    return {"ok": True}


@app.post("/api/reset-state")
def reset_state():
    run_state.reset()
    return {"ok": True}


# ── Run history ───────────────────────────────────────────────
def _list_runs():
    if not RUNS_DIR.exists():
        return []
    out = []
    for d in sorted(RUNS_DIR.iterdir(), key=lambda p: p.name, reverse=True):
        if not d.is_dir():
            continue
        summary = d / "run_summary.json"
        data: dict[str, Any] = {"run_id": d.name, "has_video": (d / "final_video.mp4").exists()}
        if summary.exists():
            try:
                data.update(json.loads(summary.read_text(encoding="utf-8")))
            except Exception:
                pass
        out.append(data)
    return out


@app.get("/api/runs")
def list_runs():
    return _list_runs()


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    d = RUNS_DIR / run_id
    if not d.exists():
        raise HTTPException(404, "run not found")
    summary = d / "run_summary.json"
    data: dict[str, Any] = {"run_id": run_id, "has_video": (d / "final_video.mp4").exists()}
    if summary.exists():
        try:
            data.update(json.loads(summary.read_text(encoding="utf-8")))
        except Exception:
            pass
    return data


@app.get("/api/runs/{run_id}/video")
def get_run_video(run_id: str):
    p = RUNS_DIR / run_id / "final_video.mp4"
    if not p.exists():
        raise HTTPException(404, "video not found")
    return FileResponse(str(p), media_type="video/mp4")


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str):
    d = RUNS_DIR / run_id
    if not d.exists():
        raise HTTPException(404, "run not found")
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


# ── Jobs queue ────────────────────────────────────────────────
@app.post("/api/jobs")
def submit_job(req: RunRequest):
    settings = load_settings()
    channel = req.channel or settings["content"]["channel"]
    return jobs.submit({"channel": channel, "dry_run": req.dry_run})


@app.get("/api/jobs")
def list_jobs():
    return jobs.list_all()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str):
    ok = jobs.cancel(job_id)
    if not ok:
        raise HTTPException(404, "job not found or already terminal")
    return {"ok": True}


@app.get("/api/debug/heartbeat")
def debug_heartbeat():
    """Forces a synchronous registry push and surfaces any error.
    Used to diagnose silent FTP/upload failures when the background
    heartbeat thread isn't producing visible logs."""
    import traceback
    out = {
        "storage_configured": storage.is_configured(),
        "public_url": registry.public_url(),
        "instance_id": registry.INSTANCE_ID,
        "instance_tier": registry.INSTANCE_TIER,
        "ftp_host": os.getenv("FTP_HOST", ""),
        "ftp_user_set": bool(os.getenv("FTP_USER", "")),
        "ftp_pass_set": bool(os.getenv("FTP_PASS", "")),
        "ftp_port": os.getenv("FTP_PORT", "21"),
        "ftp_use_tls": os.getenv("FTP_USE_TLS", "1"),
        "ftp_base_dir": storage.FTP_BASE_DIR,
        "public_base_url": os.getenv("PUBLIC_BASE_URL", ""),
        "registry_filename": registry.REGISTRY_FILENAME,
    }
    try:
        # Try a raw connection first (isolates auth/host errors).
        ftp = storage._connect()
        out["ftp_connect_ok"] = True
        try:
            pwd = ftp.pwd()
            out["ftp_pwd"] = pwd
            out["ftp_listing_root"] = ftp.nlst()
        except Exception as e:
            out["ftp_pwd_error"] = repr(e)
        finally:
            try: ftp.quit()
            except Exception: pass
    except Exception as e:
        out["ftp_connect_ok"] = False
        out["ftp_connect_error"] = repr(e)
        out["traceback"] = traceback.format_exc()
        return out

    # Now try the real heartbeat push.
    try:
        registry.push_now(queue_depth=jobs.queue_depth())
        out["push_now_ok"] = True
    except Exception as e:
        out["push_now_ok"] = False
        out["push_now_error"] = repr(e)
        out["traceback"] = traceback.format_exc()
    return out


@app.get("/api/queue")
def queue_status():
    idle_for = int(idle_watchdog.idle_seconds())
    timeout = idle_watchdog.IDLE_TIMEOUT_SECONDS
    return {
        "busy": jobs.is_busy(),
        "queue_depth": jobs.queue_depth(),
        "instance_id": registry.INSTANCE_ID,
        "public_url": registry.public_url(),
        "status": "busy" if jobs.is_busy() else "available",
        "storage_configured": storage.is_configured(),
        "idle_seconds": idle_for,
        "idle_timeout_seconds": timeout,
        "auto_shutdown_in": max(0, timeout - idle_for) if timeout > 0 else None,
    }


# ── Voice catalog (for the settings UI) ──────────────────────
@app.get("/api/edge-voices")
def edge_voices():
    """Return a curated list of edge-tts voices (no live lookup; static)."""
    return [
        "en-US-BrianMultilingualNeural",
        "en-US-AndrewMultilingualNeural",
        "en-US-AvaMultilingualNeural",
        "en-US-EmmaMultilingualNeural",
        "en-US-ChristopherNeural",
        "en-US-GuyNeural",
        "en-US-DavisNeural",
        "en-US-AndrewNeural",
        "en-US-BrianNeural",
        "en-GB-RyanNeural",
    ]

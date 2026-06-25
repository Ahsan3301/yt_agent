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
    # Attach the in-memory ring buffer that backs /api/logs so the
    # dashboard can stream live progress text. Do this BEFORE the other
    # startup hooks so their log lines also get captured.
    try:
        from backend import logbuf
        logbuf.attach()
    except Exception as e:
        log.warning(f"logbuf.attach failed: {e}")
    # Pull the shared API keys from Hostinger BEFORE anything else so
    # downstream modules see the right env vars when they're imported
    # lazily on first request.
    try:
        keys_sync.pull_into_env()
    except Exception as e:
        log.warning(f"keys_sync.pull_into_env failed: {e}")
    # Hydrate settings.json from R2/SFTP so a fresh container boots
    # with the user's last saved channel/voice/video tuning instead of
    # the defaults. Best-effort; falls back to defaults if remote empty.
    try:
        from backend import settings_sync
        hydrated = settings_sync.pull_into_local()
        if hydrated:
            # Refresh the cached module-level constants in modules.config
            # so anything reading CHANNEL_TYPE / TTS_ENGINE / etc. sees
            # the user's saved values instead of the on-disk defaults
            # that were read at import time.
            from modules import config as _config_mod
            try:
                _config_mod.reload()
            except Exception as e:
                log.warning(f"config.reload failed: {e}")
    except Exception as e:
        log.warning(f"settings_sync.pull_into_local failed: {e}")
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
def _local_runs() -> list[dict]:
    """Read run summaries from this container's output/videos dir."""
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


def _list_runs():
    """Merge local + Hostinger runs. Local wins on conflict (same run_id)
    because it has the full summary with shots, timings, etc. Remote-only
    entries get marked has_video=True so the UI can stream from Hostinger."""
    local = _local_runs()
    by_id = {r["run_id"]: r for r in local}

    try:
        from backend import storage
        for entry in storage.list_remote_runs():
            if not isinstance(entry, dict):
                continue
            rid = entry.get("run_id")
            if not rid:
                continue
            if rid in by_id:
                # Fill in video_url if local copy didn't have it.
                if entry.get("video_url") and not by_id[rid].get("video_url"):
                    by_id[rid]["video_url"] = entry["video_url"]
                continue
            # Remote-only — full local container is gone (post-restart). The
            # video is still on Hostinger so the UI can play it.
            by_id[rid] = {
                "run_id":      rid,
                "channel":     entry.get("channel"),
                "dry_run":     entry.get("dry_run", False),
                "ok":          entry.get("ok"),
                "finished_at": entry.get("finished_at"),
                "video_url":   entry.get("video_url"),
                "has_video":   bool(entry.get("video_url")),
            }
    except Exception as e:
        log.warning(f"remote runs index fetch failed: {e}")

    # Sort by finished_at desc, then run_id desc as a fallback.
    def _sort_key(r):
        return (-(float(r.get("finished_at") or 0)), r.get("run_id", ""))
    return sorted(by_id.values(), key=_sort_key)


@app.get("/api/runs")
def list_runs():
    return _list_runs()


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    d = RUNS_DIR / run_id
    if d.exists():
        summary = d / "run_summary.json"
        data: dict[str, Any] = {"run_id": run_id, "has_video": (d / "final_video.mp4").exists()}
        if summary.exists():
            try:
                data.update(json.loads(summary.read_text(encoding="utf-8")))
            except Exception:
                pass
        return data

    # Local gone — try Hostinger fallback.
    try:
        from backend import storage
        remote = storage.fetch_remote_run_summary(run_id)
        if remote:
            remote.setdefault("run_id", run_id)
            remote.setdefault("has_video", bool(remote.get("video_url")))
            return remote
    except Exception as e:
        log.warning(f"remote run fetch failed for {run_id}: {e}")
    raise HTTPException(404, "run not found")


@app.get("/api/runs/{run_id}/video")
def get_run_video(run_id: str):
    p = RUNS_DIR / run_id / "final_video.mp4"
    if p.exists():
        return FileResponse(str(p), media_type="video/mp4")

    # Local gone — redirect to the canonical Hostinger copy.
    try:
        from backend import storage
        from fastapi.responses import RedirectResponse
        if storage.PUBLIC_BASE_URL:
            return RedirectResponse(storage.public_video_url(run_id), status_code=302)
    except Exception:
        pass
    raise HTTPException(404, "video not found")


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str):
    d = RUNS_DIR / run_id
    had_local = d.exists()
    had_remote = False
    if had_local:
        shutil.rmtree(d, ignore_errors=True)

    # Mirror the deletion to Hostinger: drop the summary, the video, and
    # the index entry.
    try:
        from backend import storage
        if storage.is_configured():
            had_remote = bool(storage.fetch_remote_run_summary(run_id))
            storage.delete_remote(f"{storage.RUNS_REMOTE_DIR}/{run_id}.json")
            storage.delete_remote(f"videos/{run_id}.mp4")
            storage.remove_from_runs_index(run_id)
    except Exception as e:
        log.warning(f"remote cleanup for {run_id} failed: {e}")

    if not (had_local or had_remote):
        raise HTTPException(404, "run not found")
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
    """Comprehensive diagnostic. Tests:
      1. DNS resolution (IPv4 vs IPv6)
      2. TCP connect to each resolved address
      3. Whether outbound HTTPS works at all (sanity check)
      4. FTP connection forced to IPv4 (in case IPv6 has no route)
      5. The actual registry push
    """
    import socket, traceback, ssl, urllib.request

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
    # Storage usage (primary R2 + secondary SFTP capability)
    try:
        out["storage_usage"] = storage.usage_summary()
    except Exception as e:
        out["storage_usage_error"] = repr(e)

    host = os.getenv("FTP_HOST", "")
    port = int(os.getenv("FTP_PORT", "21") or 21)

    # 1) DNS — show ALL addresses, separated by family.
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        out["dns_resolved"] = [
            {"family": "IPv4" if af == socket.AF_INET else "IPv6" if af == socket.AF_INET6 else str(af),
             "address": sa[0]}
            for af, _, _, _, sa in infos
        ]
    except Exception as e:
        out["dns_error"] = repr(e)

    # 2) Raw TCP connect to each resolved address (5s timeout each).
    out["tcp_per_address"] = []
    try:
        for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
            af, _, _, _, sa = info
            family = "IPv4" if af == socket.AF_INET else "IPv6"
            try:
                s = socket.socket(af, socket.SOCK_STREAM)
                s.settimeout(5)
                s.connect(sa)
                s.close()
                out["tcp_per_address"].append({"family": family, "address": sa[0], "ok": True})
            except Exception as e:
                out["tcp_per_address"].append({"family": family, "address": sa[0], "ok": False, "error": repr(e)})
    except Exception as e:
        out["tcp_per_address_error"] = repr(e)

    # 3) Sanity: does outbound HTTPS work at all?
    try:
        with urllib.request.urlopen("https://www.cloudflare.com/cdn-cgi/trace", timeout=5) as r:
            out["https_sanity"] = {"ok": True, "status": r.status}
    except Exception as e:
        out["https_sanity"] = {"ok": False, "error": repr(e)}

    # 4) Force-IPv4 FTP connect (most likely fix for ENETUNREACH on dual-stack DNS)
    try:
        ipv4_addrs = [sa[0] for af, _, _, _, sa in
                      socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                      if af == socket.AF_INET]
        if not ipv4_addrs:
            out["ftp_ipv4_attempt"] = {"ok": False, "error": "no IPv4 address from DNS"}
        else:
            from ftplib import FTP
            ftp = FTP()
            ftp.connect(ipv4_addrs[0], port, timeout=15)
            ftp.login(os.getenv("FTP_USER", ""), os.getenv("FTP_PASS", ""))
            pwd = ftp.pwd()
            listing = ftp.nlst()
            ftp.quit()
            out["ftp_ipv4_attempt"] = {
                "ok": True, "address": ipv4_addrs[0],
                "pwd": pwd, "root_listing": listing[:20],
            }
    except Exception as e:
        out["ftp_ipv4_attempt"] = {"ok": False, "error": repr(e),
                                    "traceback": traceback.format_exc()}

    # 5) The real heartbeat push (uses storage._connect which still tries TLS first)
    try:
        registry.push_now(queue_depth=jobs.queue_depth())
        out["push_now_ok"] = True
    except Exception as e:
        out["push_now_ok"] = False
        out["push_now_error"] = repr(e)

    # 6) Port-22 reachability — proves whether HF allows outbound SSH at all.
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(("github.com", 22))
        s.close()
        out["port22_sanity_github"] = {"ok": True}
    except Exception as e:
        out["port22_sanity_github"] = {"ok": False, "error": repr(e)}

    # 7) SFTP to Hostinger — the real test.
    sftp_user = os.getenv("SFTP_USER") or os.getenv("FTP_USER", "")
    sftp_pass = os.getenv("SFTP_PASS") or os.getenv("FTP_PASS", "")
    sftp_host = os.getenv("SFTP_HOST") or os.getenv("FTP_HOST", "")
    sftp_port = int(os.getenv("SFTP_PORT", "22") or 22)
    out["sftp_target"] = {"host": sftp_host, "port": sftp_port, "user_set": bool(sftp_user)}

    try:
        import paramiko
    except ImportError as e:
        out["sftp_attempt"] = {"ok": False, "error": f"paramiko not installed: {e!r}"}
        return out

    try:
        # Probe port 22 to Hostinger first (separate signal from auth).
        ipv4 = None
        for af, _, _, _, sa in socket.getaddrinfo(sftp_host, sftp_port, type=socket.SOCK_STREAM):
            if af == socket.AF_INET:
                ipv4 = sa[0]; break
        if not ipv4:
            raise OSError(f"no IPv4 address for {sftp_host!r}")
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect((ipv4, sftp_port))
        s.close()
        out["sftp_port_open"] = {"ok": True, "address": ipv4}
    except Exception as e:
        out["sftp_port_open"] = {"ok": False, "error": repr(e)}
        out["sftp_attempt"] = {"ok": False, "error": "port 22 unreachable — skipped SFTP login"}
        return out

    try:
        transport = paramiko.Transport((ipv4, sftp_port))
        transport.banner_timeout = 10
        transport.connect(username=sftp_user, password=sftp_pass)
        sftp = paramiko.SFTPClient.from_transport(transport)
        pwd = sftp.getcwd() or "/"
        listing = sftp.listdir(pwd)
        sftp.close(); transport.close()
        out["sftp_attempt"] = {"ok": True, "host_ipv4": ipv4, "port": sftp_port,
                               "pwd": pwd, "listing_sample": listing[:20]}
    except Exception as e:
        out["sftp_attempt"] = {"ok": False, "error": repr(e),
                                "traceback": traceback.format_exc()}

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


# ── Resource stats (Monitor page) ──────────────────────────
@app.get("/api/stats")
def get_stats():
    """Snapshot of this backend's CPU/RAM/disk/GPU + active job. Polled
    by the dashboard's Monitor page every 2 seconds per backend."""
    try:
        from backend import stats
        return stats.collect()
    except Exception as e:
        log.warning(f"/api/stats failed: {e}")
        return {"error": repr(e)}


# ── Live logs (ring buffer for the dashboard) ───────────────
@app.get("/api/logs")
def get_logs(since: int = 0, limit: int = 500):
    """Return log entries with seq > since. The dashboard polls this
    every second while a job runs (longer interval otherwise) and uses
    the returned head_seq as the next `since` value."""
    try:
        from backend import logbuf
        return logbuf.read(since=since, limit=limit)
    except Exception as e:
        log.warning(f"/api/logs failed: {e}")
        return {"entries": [], "head_seq": 0}


@app.delete("/api/logs")
def clear_logs():
    try:
        from backend import logbuf
        logbuf.clear()
    except Exception:
        pass
    return {"ok": True}


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

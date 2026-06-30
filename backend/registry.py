"""
registry.py — Self-register this backend in the Firestore `backends` collection.

Each backend writes one document keyed by its instance_id. The frontend
subscribes to the collection via onSnapshot and gets instant updates
when backends come and go — no polling, no CDN caching, no CORS dance.

Document shape:
    backends/<instance_id> {
      url:         "https://xxx.trycloudflare.com",
      status:      "available" | "busy",
      queue_depth: int,
      tier:        "gpu" | "cpu",
      label:       str | None,
      version:     "2.0",
      started_at:  Timestamp,
      last_seen:   Timestamp,       # server timestamp on every write
    }

Heartbeat thread refreshes the doc every HEARTBEAT_INTERVAL seconds.
"""
from __future__ import annotations
import os
import time
import uuid
import socket
import logging
import threading

from backend import db

log = logging.getLogger(__name__)

# Heartbeat every 60s by default. Each beat writes one doc to Firestore
# (which counts against the 20K/day free write quota) AND triggers an
# onSnapshot fire on every connected dashboard (1 read per listener per
# update against the 50K/day read quota). At 30s the math compounds
# fast on long-lived sessions; 60s is a better default for free tier.
# Override via REGISTRY_HEARTBEAT_SECONDS env var if needed.
HEARTBEAT_INTERVAL = int(os.getenv("REGISTRY_HEARTBEAT_SECONDS", "60") or 60)


def _detect_gpu_name() -> str:
    """Read the actual GPU model from nvidia-smi.

    Kaggle hands out T4 or P100 randomly per session; Colab varies between
    T4 and (rarely) A100. Hardcoding 'kaggle-t4-gpu' in env vars is wrong
    half the time. This runs once at import so the registry doc reports
    the real hardware.

    Returns the trimmed model string (e.g. 'Tesla P100-PCIE-16GB') or ""
    if nvidia-smi isn't on PATH / no GPU is attached.
    """
    import subprocess
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=4,
        )
        if r.returncode != 0:
            return ""
        # Take the first GPU (Kaggle T4 x2 returns two lines).
        first = (r.stdout or "").splitlines()[0].strip()
        return first
    except Exception:
        return ""


# Per-instance metadata.
INSTANCE_ID = os.getenv("INSTANCE_ID") or f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}"
PUBLIC_URL = os.getenv("PUBLIC_BACKEND_URL", "")    # set by the Colab notebook after cloudflared
INSTANCE_TIER = (os.getenv("INSTANCE_TIER", "gpu") or "gpu").lower()
GPU_NAME = _detect_gpu_name()

# Auto-build a useful label if the env var didn't set one explicitly.
# Examples: "kaggle · Tesla P100-PCIE-16GB", "colab · Tesla T4".
_raw_label = os.getenv("INSTANCE_LABEL", "").strip()
if _raw_label and GPU_NAME:
    # Strip stale "-t4-gpu" / "-gpu" suffixes and append the real model.
    base = _raw_label.split("-")[0].split(" ")[0]
    INSTANCE_LABEL = f"{base} · {GPU_NAME}"
elif _raw_label:
    INSTANCE_LABEL = _raw_label
elif GPU_NAME:
    INSTANCE_LABEL = GPU_NAME
else:
    INSTANCE_LABEL = ""

# Back-compat — used by /api/debug/heartbeat in server.py.
REGISTRY_FILENAME = "backends"   # now a Firestore collection name

# Worker connection mode.
#   "tunnel"        — legacy: expose inbound cloudflared, dashboard
#                     polls our URL. PUBLIC_BACKEND_URL must be set.
#   "outbound_poll" — Coolify-friendly: NO public URL. We register
#                     ourselves via HTTPS POST to COOLIFY_BASE_URL +
#                     poll /api/jobs/claim instead of being polled.
WORKER_MODE = (os.getenv("WORKER_MODE") or "tunnel").strip().lower()
COOLIFY_BASE_URL = (os.getenv("COOLIFY_BASE_URL") or "").rstrip("/")
RENDER_TRIGGER_KEY = os.getenv("RENDER_TRIGGER_KEY") or ""

_status = "available"
_running = False
_startup_epoch = time.time()


def public_url() -> str:
    return os.getenv("PUBLIC_BACKEND_URL", PUBLIC_URL)


def _is_outbound_poll() -> bool:
    return WORKER_MODE == "outbound_poll" and bool(COOLIFY_BASE_URL)


def set_status(status: str):
    """Called by jobs.py when the queue transitions busy/available."""
    global _status
    _status = status


def _self_payload(queue_depth: int) -> dict:
    return {
        "instance_id":  INSTANCE_ID,
        "url":          public_url(),
        "status":       _status,
        "queue_depth":  int(queue_depth),
        "tier":         INSTANCE_TIER,
        "label":        INSTANCE_LABEL or None,
        # Real GPU model from nvidia-smi (e.g. "Tesla P100-PCIE-16GB").
        # Empty string on CPU-only workers — frontend can show "—".
        "gpu_name":     GPU_NAME or None,
        "version":      "2.0",
        "started_at":   _startup_epoch,
        "last_seen":    db.server_timestamp(),
    }


def push_now(queue_depth: int = 0):
    """Publish a heartbeat immediately. Goes via HTTPS in outbound-
    poll mode, direct DB write in tunnel mode."""
    if _is_outbound_poll():
        _push_outbound(queue_depth)
        return
    if not db.is_configured():
        return
    if not public_url():
        return  # tunnel not up yet
    try:
        c = db.client()
        c.collection("backends").document(INSTANCE_ID).set(
            _self_payload(queue_depth), merge=True
        )
        log.debug(f"heartbeat ok ({_status}, depth={queue_depth})")
    except Exception as e:
        log.warning(f"heartbeat write failed: {e}")


def _push_outbound(queue_depth: int):
    """Heartbeat via the Coolify dashboard's /api/workers/register
    endpoint. The dashboard is the only thing that talks to the DB —
    the worker never needs creds for it."""
    if not COOLIFY_BASE_URL or not RENDER_TRIGGER_KEY:
        log.debug("outbound-poll heartbeat skipped: COOLIFY_BASE_URL/RENDER_TRIGGER_KEY not set")
        return
    import requests
    payload = _self_payload(queue_depth)
    # Strip the server_timestamp sentinel (it's a Firestore object that
    # JSON can't serialise — the route generates its own timestamp).
    payload.pop("last_seen", None)
    payload["queue_depth"] = int(queue_depth)
    try:
        r = requests.post(
            f"{COOLIFY_BASE_URL}/api/workers/register",
            json=payload,
            headers={"X-API-Key": RENDER_TRIGGER_KEY},
            timeout=10,
        )
        if r.ok:
            log.debug(f"outbound-poll heartbeat ok ({_status}, depth={queue_depth})")
        else:
            log.warning(f"outbound-poll heartbeat HTTP {r.status_code}: {r.text[:100]}")
    except Exception as e:
        log.warning(f"outbound-poll heartbeat failed: {e}")


def _claim_outbound() -> dict | None:
    """Poll the dashboard for a queued job. Returns the job payload or
    None when nothing's queued. Used by the loop in outbound-poll mode
    instead of jobs_db.claim_queued (which goes via the DB client and
    requires Firestore creds we don't have)."""
    if not COOLIFY_BASE_URL or not RENDER_TRIGGER_KEY:
        return None
    import requests
    try:
        r = requests.post(
            f"{COOLIFY_BASE_URL}/api/jobs/claim",
            json={
                "instance_id": INSTANCE_ID,
                "tier": INSTANCE_TIER,
            },
            headers={"X-API-Key": RENDER_TRIGGER_KEY},
            timeout=10,
        )
        if r.status_code == 204:
            return None
        if r.ok:
            return (r.json() or {}).get("job")
        log.warning(f"outbound-poll claim HTTP {r.status_code}: {r.text[:100]}")
    except Exception as e:
        log.warning(f"outbound-poll claim failed: {e}")
    return None


def deregister():
    """Best-effort: remove ourselves on graceful shutdown."""
    if not db.is_configured() or not public_url():
        return
    try:
        c = db.client()
        c.collection("backends").document(INSTANCE_ID).delete()
        log.info(f"deregistered {INSTANCE_ID}")
    except Exception as e:
        log.warning(f"deregister failed: {e}")


def start():
    """Spawn the heartbeat thread. Idempotent."""
    global _running, _startup_epoch
    if _running:
        return
    # In tunnel mode we need DB creds. In outbound-poll mode we don't
    # (the dashboard is the only thing that talks to the DB).
    if not _is_outbound_poll() and not db.is_configured():
        log.info("registry: DB not configured + not in outbound-poll mode — skipping heartbeat")
        return
    if _is_outbound_poll() and (not COOLIFY_BASE_URL or not RENDER_TRIGGER_KEY):
        log.warning(
            "registry: WORKER_MODE=outbound_poll but COOLIFY_BASE_URL/"
            "RENDER_TRIGGER_KEY not set — heartbeat disabled"
        )
        return
    _running = True
    _startup_epoch = time.time()

    def _loop():
        from backend import jobs, jobs_db
        # Adaptive cadence: heartbeat 15s while there's an active job,
        # 60s when idle. Same total write budget over time (idle dominates),
        # but the dashboard's Monitor card stays fresh during renders +
        # the queue-claim loop polls 4x faster when actively serving.
        busy_interval = 15
        idle_interval = HEARTBEAT_INTERVAL  # respects env override (default 60s)

        # In outbound-poll mode the worker is responsible for *finding*
        # jobs (vs being-pushed-to in tunnel mode), so we poll the claim
        # endpoint every 5 sec when idle.
        outbound_claim_interval = 5

        # First heartbeat fires IMMEDIATELY on worker startup so the
        # dashboard's onSnapshot listener sees the card within ~1 sec
        # instead of after the first sleep (was up to 60s wait).
        first = True
        while _running:
            try:
                depth = jobs.queue_depth()
                busy = jobs.is_busy()
                new_status = "busy" if busy else "available"
                if new_status != _status:
                    set_status(new_status)
                push_now(queue_depth=depth)

                if not busy:
                    if _is_outbound_poll():
                        # Outbound-poll: pull a job from the dashboard.
                        claimed = _claim_outbound()
                    elif public_url():
                        # Tunnel: legacy DB-side claim.
                        claimed = jobs_db.claim_queued(INSTANCE_ID, public_url())
                    else:
                        claimed = None
                    if claimed:
                        jobs.adopt_remote(claimed)
            except Exception as e:
                log.warning(f"heartbeat loop error: {e}")
            # Pick the next sleep based on current state.
            if jobs.is_busy():
                sleep_for = busy_interval
            elif _is_outbound_poll():
                # Idle + outbound-poll: poll the claim endpoint often
                # so users see jobs picked up within seconds of
                # submitting.
                sleep_for = outbound_claim_interval
            else:
                sleep_for = idle_interval
            # Don't sleep at startup — get the second heartbeat out
            # quickly to confirm the worker is alive (timestamp fresh).
            if first:
                first = False
                sleep_for = min(sleep_for, 3)
            time.sleep(sleep_for)

    t = threading.Thread(target=_loop, daemon=True, name="registry-heartbeat")
    t.start()
    log.info(f"registry heartbeat started "
             f"(idle={HEARTBEAT_INTERVAL}s, busy=15s; instance_id={INSTANCE_ID})")

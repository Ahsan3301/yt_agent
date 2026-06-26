"""
checkpoint.py — Pipeline resume across worker restarts.

Each successful pipeline stage writes a small JSON to
`output/videos/<run_id>/checkpoint.json` describing what's done and
the path to any intermediate artefacts (script JSON, audio path,
shots, etc.). On retry, the pipeline reads the checkpoint and skips
already-completed stages.

The checkpoint is ALSO mirrored to Firestore `runs_index/<run_id>.checkpoint`
so a retry on a different worker can resume — Colab dies mid-edit,
HF Space picks up the queued retry, and resumes from edit instead of
rendering everything from scratch.

Stage names match `modules.run_state.STEPS`:
  research, script, voiceover, footage, edit, upload
"""
from __future__ import annotations
import os
import json
import logging
import threading
from pathlib import Path

log = logging.getLogger(__name__)

_lock = threading.Lock()


def path_for(run_id: str) -> Path:
    return Path("output/videos") / run_id / "checkpoint.json"


def load(run_id: str) -> dict:
    """Return the checkpoint dict for this run. Empty dict if missing.

    Resolution order:
      1. local file (fastest, populated by previous run on this worker)
      2. Firestore mirror (if local doesn't have it but a previous
         worker checkpointed before dying)
    """
    p = path_for(run_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning(f"checkpoint local read failed for {run_id}: {e}")

    try:
        from backend import runs_db
        remote = runs_db.fetch_summary(run_id) or {}
        cp = remote.get("checkpoint")
        if isinstance(cp, dict):
            log.info(f"checkpoint: hydrated from Firestore for {run_id}")
            # Cache locally so we don't refetch on every stage.
            try:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(cp, indent=2), encoding="utf-8")
            except Exception:
                pass
            return cp
    except Exception as e:
        log.debug(f"checkpoint Firestore read miss for {run_id}: {e}")
    return {}


def save(run_id: str, stage: str, data: dict | None = None):
    """Mark `stage` complete and merge `data` into the checkpoint."""
    with _lock:
        p = path_for(run_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        cp = load(run_id)
        completed = set(cp.get("completed_stages", []))
        completed.add(stage)
        cp["completed_stages"] = sorted(completed)
        cp["last_stage"] = stage
        if data:
            cp.setdefault("artifacts", {})[stage] = data
        try:
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(cp, indent=2), encoding="utf-8")
            os.replace(tmp, p)
        except Exception as e:
            log.warning(f"checkpoint local save failed: {e}")

        # Mirror to Firestore so a DIFFERENT worker can resume.
        try:
            from backend import db
            if db.is_configured():
                db.client().collection("runs_index").document(run_id).set({
                    "checkpoint": cp,
                    "updated_at": db.server_timestamp(),
                }, merge=True)
        except Exception as e:
            log.debug(f"checkpoint Firestore mirror skipped: {e}")


def completed(run_id: str, stage: str) -> bool:
    cp = load(run_id)
    return stage in set(cp.get("completed_stages", []))


def artifact(run_id: str, stage: str) -> dict | None:
    cp = load(run_id)
    return (cp.get("artifacts") or {}).get(stage)


def clear(run_id: str):
    """Forget all checkpoints for this run — used when starting fresh."""
    p = path_for(run_id)
    try:
        if p.exists():
            p.unlink()
    except Exception:
        pass
    try:
        from backend import db
        if db.is_configured():
            db.client().collection("runs_index").document(run_id).update({
                "checkpoint": __import__("firebase_admin").firestore.DELETE_FIELD,
            })
    except Exception:
        pass

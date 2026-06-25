"""
run_state.py — Tiny shared-state file so the GUI can show live progress while
a pipeline run executes in a background thread.

The pipeline writes a single JSON file (atomic temp+rename) at each step
transition. The GUI polls it. Keeping it filesystem-based means it survives
Streamlit's session-state reset on rerun and works across processes (e.g.
pipeline run from CLI + GUI showing live status).
"""
import os
import json
import time
from pathlib import Path

STATE_PATH = Path("data/run_state.json")

# Step weights — ordered, each (key, label, cumulative_percent_when_done).
# These map to the steps in main.py / run_pipeline so the percent shown in
# the GUI roughly matches actual wall-clock progress.
STEPS = [
    ("research",  "Researching topic",   5),
    ("script",    "Writing script",      15),
    ("voiceover", "Generating voice",    30),
    ("footage",   "Fetching footage",    60),
    ("edit",      "Editing video",       92),
    ("upload",    "Uploading",          100),
]
STEP_INDEX = {k: i for i, (k, _, _) in enumerate(STEPS)}


def _atomic_write(data):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, STATE_PATH)


def read():
    """Return the current state dict, or a default 'idle' state if unset."""
    if not STATE_PATH.exists():
        return {"status": "idle"}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"status": "idle"}


def start(run_id, channel, dry_run):
    """Mark a run as started. Clears any previous state."""
    _atomic_write({
        "status": "running",
        "run_id": run_id,
        "channel": channel,
        "dry_run": dry_run,
        "started_at": time.time(),
        "current_step": "research",
        "current_step_label": STEPS[0][1],
        "percent": 0,
        "message": "",
    })


def step_started(step_key):
    """Mark the start of a named step (so the bar shows label + previous %)."""
    cur = read()
    if cur.get("status") != "running":
        return
    cur["current_step"] = step_key
    cur["current_step_label"] = next(
        (label for k, label, _ in STEPS if k == step_key), step_key.title()
    )
    # Percent is the cumulative percent of the PREVIOUS finished step.
    idx = STEP_INDEX.get(step_key, 0)
    cur["percent"] = STEPS[idx - 1][2] if idx > 0 else 0
    cur["updated_at"] = time.time()
    _atomic_write(cur)


def step_done(step_key):
    """Mark a step as finished — bumps percent to that step's cumulative %."""
    cur = read()
    if cur.get("status") != "running":
        return
    idx = STEP_INDEX.get(step_key)
    if idx is not None:
        cur["percent"] = STEPS[idx][2]
        cur["updated_at"] = time.time()
        _atomic_write(cur)


def finish(ok, video_path=None, video_url=None, error=None):
    """Mark the run complete (or failed)."""
    cur = read()
    cur["status"] = "complete" if ok else "failed"
    cur["percent"] = 100 if ok else cur.get("percent", 0)
    cur["finished_at"] = time.time()
    if video_path:
        cur["video_path"] = str(video_path)
    if video_url:
        cur["video_url"] = video_url
    if error:
        cur["error"] = str(error)
    _atomic_write(cur)


def reset():
    """Clear the state file. Called by the GUI when the user dismisses a result."""
    if STATE_PATH.exists():
        STATE_PATH.unlink()

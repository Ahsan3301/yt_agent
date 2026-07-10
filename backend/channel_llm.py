"""
backend.channel_llm — apply a job's channel-specific LLM provider
priority to LLM_PRIORITY env for the duration of one render.

The channel doc stores `llm_priority` as a comma-separated ordered list
of provider names, e.g. "nim,openrouter,groq" or "openrouter,nim".
Absent from the list = OFF for that render (nim.py's _try_provider
just skips the missing name).

Recognised providers: nim, groq, openrouter.
"""
from __future__ import annotations
import os
import logging

log = logging.getLogger(__name__)

_KEY = "LLM_PRIORITY"
_KNOWN = ("nim", "groq", "openrouter")


def _sanitize(raw: str) -> str:
    seen: list[str] = []
    for tok in (raw or "").split(","):
        t = tok.strip().lower()
        if t in _KNOWN and t not in seen:
            seen.append(t)
    return ",".join(seen)


def apply_from_job(job: dict) -> dict:
    """Set LLM_PRIORITY env from the job's llm_priority field.
    Returns a snapshot for later restore_env()."""
    snapshot = {_KEY: os.environ.get(_KEY, "")}
    raw = str(job.get("llm_priority") or "").strip()
    cleaned = _sanitize(raw)
    if cleaned:
        os.environ[_KEY] = cleaned
        log.info(f"channel_llm: LLM_PRIORITY={cleaned}")
    else:
        # No per-channel override — clear so nim.py uses its default.
        os.environ.pop(_KEY, None)
        log.info("channel_llm: no channel override, using default LLM priority")
    return snapshot


def restore_env(snapshot: dict) -> None:
    v = snapshot.get(_KEY, "")
    if v:
        os.environ[_KEY] = v
    else:
        os.environ.pop(_KEY, None)

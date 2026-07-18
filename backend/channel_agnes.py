"""
backend.channel_agnes — apply a job's channel-specific Agnes AI image
key to os.environ for the duration of one render.

Mirror of backend.channel_cf. Called by every worker path (backend.jobs,
coolify.side_worker) right before entering main.run_pipeline.

  agnes_source == "own" → set AGNES_API_KEY from the channel's stored
                          key. shotfinder's _agnes_generate runs against
                          it; _provider_ready gates on it being present.

  agnes_source == "off" / unset → wipe AGNES_API_KEY so the Agnes
                          provider is skipped entirely on this channel
                          (fail-closed: a channel that never opted in
                          never sends its prompts to Agnes).

Per-channel by design: each channel supplies its OWN key, so channels
that don't want Agnes are fully isolated from it. There is no global
Agnes key — opting in is an explicit per-channel action.

Returns a snapshot dict the caller must pass to restore_env() at the
end of the render so subsequent jobs on the same worker don't inherit
the override.
"""
from __future__ import annotations
import os
import logging

log = logging.getLogger(__name__)

_KEYS = ("AGNES_API_KEY",)


def apply_from_job(job: dict) -> dict:
    """Mutate os.environ to reflect this job's Agnes config.
    Returns a snapshot for later restore_env()."""
    snapshot = {k: os.environ.get(k, "") for k in _KEYS}

    source = str(job.get("agnes_source") or "off").strip().lower()
    if source == "own":
        key = str(job.get("agnes_own_api_key") or "").strip()
        if key:
            os.environ["AGNES_API_KEY"] = key
            log.info(f"channel_agnes: using OWN Agnes key (…{key[-4:]}) for this render")
        else:
            os.environ.pop("AGNES_API_KEY", None)
            log.warning(
                "channel_agnes: agnes_source=own but no key on job — "
                "Agnes provider will skip this render"
            )
    else:
        os.environ.pop("AGNES_API_KEY", None)
        log.info("channel_agnes: agnes_source=off — Agnes provider disabled for this render")

    return snapshot


def restore_env(snapshot: dict) -> None:
    """Undo whatever apply_from_job did."""
    for k in _KEYS:
        v = snapshot.get(k, "")
        if v:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)

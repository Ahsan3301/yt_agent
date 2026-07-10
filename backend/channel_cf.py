"""
backend.channel_cf — apply a job's channel-specific Cloudflare Workers
AI credentials to os.environ for the duration of one render.

Called by every worker path (backend.jobs, coolify.side_worker) right
before entering main.run_pipeline. Rules:

  cf_source == "own"    → override CLOUDFLARE_ACCOUNT_ID + _API_TOKEN
                          with the channel's stored creds. Runs against
                          that channel's own 150/day quota.

  cf_source == "global" → leave the env as-is. The keys_sync-loaded
                          global creds (set on /keys) apply. Multiple
                          "global" channels share ONE 150/day quota.

  cf_source == "off"    → wipe CLOUDFLARE_ACCOUNT_ID + _API_TOKEN so
                          shotfinder's _provider_ready returns False
                          and the Cloudflare provider is skipped
                          entirely on this channel.

  (unset / missing job) → treated as "global" (backwards-compatible
                          with jobs queued before this field existed).

Returns a snapshot dict the caller must pass to `restore_env()` at the
end of the render so subsequent jobs on the same worker don't inherit
the override.
"""
from __future__ import annotations
import os
import logging

log = logging.getLogger(__name__)

_KEYS = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")


def apply_from_job(job: dict) -> dict:
    """Mutate os.environ to reflect this job's Cloudflare config.
    Returns a snapshot for later restore_env()."""
    snapshot = {k: os.environ.get(k, "") for k in _KEYS}

    # Fail-closed default: an unset cf_source (job queued before the
    # per-channel wiring landed, or written by a code path that forgot
    # to include it) means "off" — do NOT silently draw from the
    # operator's shared global quota. The operator has to opt into
    # "global" explicitly per channel via the /channels UI.
    source = str(job.get("cf_source") or "off").strip().lower()
    if source == "own":
        acc = str(job.get("cf_own_account_id") or "").strip()
        tok = str(job.get("cf_own_api_token") or "").strip()
        if acc and tok:
            os.environ["CLOUDFLARE_ACCOUNT_ID"] = acc
            os.environ["CLOUDFLARE_API_TOKEN"] = tok
            log.info(
                f"channel_cf: using OWN Cloudflare creds "
                f"(account={acc[:8]}…, token_len={len(tok)})"
            )
        else:
            # own selected but no creds arrived — treat as off so the
            # provider doesn't accidentally fall back to global.
            os.environ["CLOUDFLARE_ACCOUNT_ID"] = ""
            os.environ["CLOUDFLARE_API_TOKEN"] = ""
            log.warning(
                "channel_cf: cf_source=own but no creds on job — "
                "clearing env so Cloudflare provider skips this render"
            )
    elif source == "off":
        os.environ["CLOUDFLARE_ACCOUNT_ID"] = ""
        os.environ["CLOUDFLARE_API_TOKEN"] = ""
        log.info("channel_cf: cf_source=off — Cloudflare provider disabled for this render")
    else:
        # "global" — leave env as-is; keys_sync already populated it
        # from /keys at worker boot. Warn loudly when the operator
        # picked global but never actually set the global keys.
        if os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
            log.info(f"channel_cf: using GLOBAL Cloudflare creds (source={source})")
        else:
            log.warning(
                "channel_cf: cf_source=global but CLOUDFLARE_ACCOUNT_ID "
                "is empty — set global creds on /keys or switch this "
                "channel to 'own' / 'off'"
            )

    return snapshot


def restore_env(snapshot: dict) -> None:
    """Undo whatever apply_from_job did."""
    for k in _KEYS:
        v = snapshot.get(k, "")
        if v:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)

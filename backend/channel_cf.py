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
import json
import os
import logging

log = logging.getLogger(__name__)

_KEYS = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNTS_JSON")


def apply_from_job(job: dict) -> dict:
    """Mutate os.environ to reflect this job's Cloudflare config.
    Returns a snapshot for later restore_env().

    Precedence for cf_source=own renders:
      1. cf_pool (JSON list) → sets CLOUDFLARE_ACCOUNTS_JSON so
         shotfinder rotates through the pool. Wins over single account.
      2. cf_own_account_id + cf_own_api_token → single-account creds
         (legacy path, still supported).
      3. Neither → warn + clear env so CF provider is skipped rather
         than silently drawing from the operator's global pool.
    """
    snapshot = {k: os.environ.get(k, "") for k in _KEYS}

    # Fail-closed default: an unset cf_source means "off".
    source = str(job.get("cf_source") or "off").strip().lower()
    if source == "own":
        pool = str(job.get("cf_pool") or "").strip()
        acc = str(job.get("cf_own_account_id") or "").strip()
        tok = str(job.get("cf_own_api_token") or "").strip()

        # Pool wins if present + parseable as a non-empty list.
        pool_ok = False
        pool_count = 0
        if pool:
            try:
                _parsed = json.loads(pool)
                if isinstance(_parsed, list) and _parsed:
                    pool_ok = True
                    pool_count = len(_parsed)
            except Exception:
                log.warning(
                    f"channel_cf: cf_pool present but not valid JSON — "
                    f"falling back to single-account creds if available"
                )

        if pool_ok:
            os.environ["CLOUDFLARE_ACCOUNTS_JSON"] = pool
            # Wipe single-account env so shotfinder's fallback logic
            # doesn't collide with the pool.
            os.environ.pop("CLOUDFLARE_ACCOUNT_ID", None)
            os.environ.pop("CLOUDFLARE_API_TOKEN", None)
            log.info(
                f"channel_cf: using OWN Cloudflare pool "
                f"({pool_count} account(s) — rotates on 429-quota)"
            )
        elif acc and tok:
            os.environ["CLOUDFLARE_ACCOUNT_ID"] = acc
            os.environ["CLOUDFLARE_API_TOKEN"] = tok
            os.environ.pop("CLOUDFLARE_ACCOUNTS_JSON", None)
            log.info(
                f"channel_cf: using OWN single-account Cloudflare creds "
                f"(account={acc[:8]}…, token_len={len(tok)})"
            )
        else:
            os.environ.pop("CLOUDFLARE_ACCOUNT_ID", None)
            os.environ.pop("CLOUDFLARE_API_TOKEN", None)
            os.environ.pop("CLOUDFLARE_ACCOUNTS_JSON", None)
            log.warning(
                "channel_cf: cf_source=own but no pool AND no single-account "
                "creds on job — CF provider will skip this render"
            )
    elif source == "off":
        os.environ.pop("CLOUDFLARE_ACCOUNT_ID", None)
        os.environ.pop("CLOUDFLARE_API_TOKEN", None)
        os.environ.pop("CLOUDFLARE_ACCOUNTS_JSON", None)
        log.info("channel_cf: cf_source=off — Cloudflare provider disabled for this render")
    else:
        # "global" — leave env as-is; keys_sync already populated it
        # from /keys at worker boot. Applies to both single-account
        # (CLOUDFLARE_ACCOUNT_ID) and pool (CLOUDFLARE_ACCOUNTS_JSON).
        has_single = bool(os.environ.get("CLOUDFLARE_ACCOUNT_ID"))
        has_pool = bool(os.environ.get("CLOUDFLARE_ACCOUNTS_JSON"))
        if has_pool:
            log.info(f"channel_cf: using GLOBAL Cloudflare pool (source={source})")
        elif has_single:
            log.info(f"channel_cf: using GLOBAL Cloudflare creds (source={source})")
        else:
            log.warning(
                "channel_cf: cf_source=global but neither "
                "CLOUDFLARE_ACCOUNT_ID nor CLOUDFLARE_ACCOUNTS_JSON is "
                "set — set them on /keys or switch this channel to "
                "'own' / 'off'"
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

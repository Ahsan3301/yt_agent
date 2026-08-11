"""
shotfinder.py — Storyboard-driven, vision-validated image selection.

The contract:
    fetch_shots(shots, output_dir, channel) -> list of source dicts

For each shot, this module tries every enabled provider, vision-judges each
candidate against the shot's `visual_description`, and picks the best
match. Failed shots are skipped (caller falls through gracefully).
"""
import os
import time
import threading as _threading
import logging
import base64
import hashlib
import json
import urllib.parse

import requests

from modules import nim
from modules._net import retry
from modules.config import load_settings
from modules import footage as F   # reuse provider helpers + dedup state
from modules.image_prompter import craft_image_prompt

log = logging.getLogger(__name__)


# ── Per-provider preview searchers ────────────────────────────

def _ss_search_previews(query, count, exclude_ids):
    token, scope = F._shutterstock_token()
    if not token or scope != "user":
        return []
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "query": query, "per_page": min(max(count, 5), 100),
        "orientation": "vertical", "view": "full",
        "safe": "true" if F._restrictions_on() else "false",
        "image_type": "photo",
    }
    try:
        r = retry(lambda: requests.get(
            "https://api.shutterstock.com/v2/images/search",
            headers=headers, params=params, timeout=15,
        ), attempts=2, on=(requests.RequestException,), desc="ss-shot-search")
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Shutterstock shot search error for {query!r}: {e}")
        return []
    out = []
    for it in r.json().get("data", []):
        iid = it.get("id")
        if not iid or f"shutterstock:{iid}" in exclude_ids:
            continue
        u = F._shutterstock_preview_url(it)
        if u:
            out.append((iid, u, it))
    return out


def _ss_license_download(image_id, output_dir):
    token, _ = F._shutterstock_token()
    sub_id = F._shutterstock_subscription_id(token) if token else None
    if not token or not sub_id:
        return None
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        lr = retry(lambda: requests.post(
            "https://api.shutterstock.com/v2/images/licenses",
            headers=headers,
            json={
                "images": [{"image_id": str(image_id), "subscription_id": sub_id}],
                "format": "jpg", "size": "huge",
            },
            timeout=20,
        ), attempts=2, on=(requests.RequestException,), desc="ss-shot-license")
        lr.raise_for_status()
    except Exception as e:
        log.warning(f"Shutterstock license failed for {image_id}: {e}")
        return None
    data = (lr.json().get("data") or [{}])[0]
    if data.get("error"):
        log.warning(f"Shutterstock license error: {data.get('error')}")
        return None
    url = (data.get("download") or {}).get("url")
    if not url:
        return None
    dest = os.path.join(output_dir, f"shutterstock_{image_id}.jpg")
    return F.download_file(url, dest)


def _pexels_search_previews(query, count, exclude_ids):
    if not F.PEXELS_KEY:
        return []
    headers = {"Authorization": F.PEXELS_KEY}
    try:
        r = retry(lambda: requests.get(
            "https://api.pexels.com/v1/search",
            headers=headers,
            params={"query": query, "per_page": min(count, 80),
                    "orientation": "portrait", "size": "large"},
            timeout=20,
        ), attempts=2, on=(requests.RequestException,), desc="pexels-shot-search")
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Pexels shot search error: {e}")
        return []
    out = []
    for p in r.json().get("photos", []):
        pid = p.get("id")
        if not pid or f"pexels_img:{pid}" in exclude_ids:
            continue
        src = p.get("src") or {}
        preview = src.get("medium") or src.get("large") or src.get("portrait")
        full = src.get("large2x") or src.get("original") or src.get("large")
        if preview and full:
            out.append((pid, preview, full))
    return out


def _pexels_download_full(image_id, full_url, output_dir):
    dest = os.path.join(output_dir, f"pexels_img_{image_id}.jpg")
    return F.download_file(full_url, dest)


# ── Cloudflare Workers AI (Flux 2 [dev]) — breaker + daily quota ──
# Model: black-forest-labs/flux-2-dev — Black Forest Labs' current
# flagship. Requires multipart/form-data (CF returned HTTP 400 for
# JSON: 'required properties at / are multipart'). We send the
# prompt + optional negative_prompt + steps + guidance + seed as
# form fields; response is raw image bytes.
#
# Free tier: 10k neurons/day, Flux 2 dev = 56 neurons/image → ~178
# images/day. Soft-cap at 150 leaves headroom for the pipeline to
# fall through to Pollinations before hitting a real Cloudflare 429.
_CF_DAILY_CAP = 150
_CF_CONSECUTIVE_FAILS = 0
_CF_OPEN_UNTIL = 0.0
_CF_BACKOFF_FAILS = 3
_CF_OPEN_FOR_SECONDS = 300     # 5 min — auth issues need operator fix, not a retry storm


def _cf_breaker_skip():
    return time.time() < _CF_OPEN_UNTIL


def _cf_breaker_record(success: bool, http_status: int | None = None):
    global _CF_CONSECUTIVE_FAILS, _CF_OPEN_UNTIL
    if success:
        if _CF_CONSECUTIVE_FAILS:
            log.info("Cloudflare Flux 2 [klein-9b]: breaker reset after successful call")
        _CF_CONSECUTIVE_FAILS = 0
        return
    # 401 / 403 are auth issues — trip immediately (no point retrying).
    if http_status in (401, 403):
        _CF_OPEN_UNTIL = time.time() + _CF_OPEN_FOR_SECONDS
        log.warning(
            f"Cloudflare Flux 2 [klein-9b]: breaker OPEN — HTTP {http_status} (bad token / scope). "
            f"Skipping for {_CF_OPEN_FOR_SECONDS}s. Fix creds via /keys."
        )
        return
    _CF_CONSECUTIVE_FAILS += 1
    if _CF_CONSECUTIVE_FAILS >= _CF_BACKOFF_FAILS:
        _CF_OPEN_UNTIL = time.time() + _CF_OPEN_FOR_SECONDS
        log.warning(
            f"Cloudflare Flux 2 [klein-9b]: breaker OPEN — {_CF_CONSECUTIVE_FAILS} consecutive failures; "
            f"skipping for {_CF_OPEN_FOR_SECONDS}s"
        )


def _cf_today_key() -> str:
    """UTC YYYY-MM-DD — the quota partition key. Auto-resets at 00:00 UTC."""
    import datetime as _dt
    return _dt.datetime.utcnow().strftime("%Y-%m-%d")


# ── Multi-account rotation pool ─────────────────────────────
# Operator pastes a JSON list at /keys as CLOUDFLARE_ACCOUNTS_JSON:
#   [{"label":"primary","account_id":"aaa","api_token":"cfut_..."},
#    {"label":"channel-2","account_id":"bbb","api_token":"cfut_..."}]
# Each account = ~60 imgs/day free. Rotation happens on 429-quota only.
_CF_POOL_CACHE: list[dict] | None = None
# Cache-invalidation key derived from ALL three env vars the pool
# builder reads. Was previously just CLOUDFLARE_ACCOUNTS_JSON, which
# left a stale cache when a worker first rendered a global/own
# channel (populating the fallback single-account pool) and then a
# subsequent render used cf_source=off (which clears the single-
# account env but not the JSON) — the stale pool kept returning the
# previous channel's creds. Now any of the three env vars changing
# forces a rebuild.
_CF_POOL_ENV_FP = ""
# In-process "burned today" set: keyed by account_id, value is the UTC
# date (YYYY-MM-DD) it was marked. When date rolls over, the entry is
# effectively expired.
_CF_BURNED_TODAY: dict[str, str] = {}


def _cf_account_pool() -> list[dict]:
    """Return the parsed CLOUDFLARE_ACCOUNTS_JSON pool. Falls back to a
    single-item pool built from CLOUDFLARE_ACCOUNT_ID + _API_TOKEN when
    the JSON is empty/missing (preserves the single-account behaviour
    the codebase had before this feature).

    Cached across calls — invalidated whenever ANY of the three env
    vars the builder reads changes, so per-channel apply_from_job
    switches (own → global → off etc.) get picked up on the next call
    without a worker restart.
    """
    global _CF_POOL_CACHE, _CF_POOL_ENV_FP
    raw = os.getenv("CLOUDFLARE_ACCOUNTS_JSON", "").strip()
    acc_env = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
    tok_env = os.getenv("CLOUDFLARE_API_TOKEN", "").strip()
    fp = f"{raw}\x00{acc_env}\x00{tok_env}"
    if fp != _CF_POOL_ENV_FP:
        _CF_POOL_ENV_FP = fp
        _CF_POOL_CACHE = None
    if _CF_POOL_CACHE is not None:
        return _CF_POOL_CACHE

    pool: list[dict] = []
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                for i, item in enumerate(data):
                    if not isinstance(item, dict):
                        continue
                    acc = str(item.get("account_id") or "").strip()
                    tok = str(item.get("api_token") or "").strip()
                    if not acc or not tok:
                        continue
                    label = str(item.get("label") or f"acc-{i+1}").strip()
                    pool.append({"account_id": acc, "api_token": tok, "label": label})
        except Exception as e:
            log.warning(
                f"CLOUDFLARE_ACCOUNTS_JSON malformed ({e}) — "
                f"falling back to single-account env creds"
            )

    if not pool:
        # No pool configured — synthesise a single-item pool from the
        # legacy single-account env vars so downstream code is
        # unaware of the pool-vs-single distinction.
        acc = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
        tok = os.getenv("CLOUDFLARE_API_TOKEN", "").strip()
        if acc and tok:
            pool.append({"account_id": acc, "api_token": tok, "label": "env"})

    _CF_POOL_CACHE = pool
    return pool


def _cf_pick_account() -> dict | None:
    """Return the first pool account that isn't burned today, or None
    when every account is burned (chain should fall through to
    Pollinations)."""
    today = _cf_today_key()
    for acc in _cf_account_pool():
        if _CF_BURNED_TODAY.get(acc["account_id"]) != today:
            return acc
    return None


def _cf_mark_burned(account_id: str) -> None:
    """Flag an account as quota-exhausted for today. Auto-clears on
    date rollover because _cf_pick_account compares against today."""
    _CF_BURNED_TODAY[account_id] = _cf_today_key()


def _cf_account_key() -> str:
    """Stable 12-char key identifying the CURRENT account. Own-mode
    channels each get their own counter automatically because their
    account_id differs from the global one.

    Falls back to 'global' when no account_id is set (older jobs)."""
    acc = (os.getenv("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    if not acc:
        return "global"
    return hashlib.sha256(acc.encode()).hexdigest()[:12]


def _cf_quota_read() -> int:
    """Return today's usage for the current CF account_id. 0 if new day
    / no doc / DB down."""
    try:
        from backend import db as _db
        if not _db.is_configured():
            return 0
        doc = _db.client().collection("settings").document("image_gen_quota").get()
        if not doc.exists:
            return 0
        d = (doc.to_dict() or {}).get("data") or {}
        if d.get("cloudflare_flux2_date") != _cf_today_key():
            return 0
        per_acc = d.get("cloudflare_flux2_per_account") or {}
        return int(per_acc.get(_cf_account_key()) or 0)
    except Exception as e:
        log.debug(f"cf quota read failed: {e}")
        return 0


def _cf_quota_inc(by: int = 1) -> None:
    """Best-effort atomic-ish increment of today's per-account counter."""
    try:
        from backend import db as _db
        if not _db.is_configured():
            return
        ref = _db.client().collection("settings").document("image_gen_quota")
        doc = ref.get()
        d = ((doc.to_dict() or {}).get("data") if doc.exists else {}) or {}
        today = _cf_today_key()
        if d.get("cloudflare_flux2_date") != today:
            d = {"cloudflare_flux2_date": today, "cloudflare_flux2_per_account": {}}
        per_acc = dict(d.get("cloudflare_flux2_per_account") or {})
        acc_key = _cf_account_key()
        per_acc[acc_key] = int(per_acc.get(acc_key) or 0) + by
        d["cloudflare_flux2_per_account"] = per_acc
        # Keep the legacy single-counter around too so any older reader
        # (dashboard reports panel) doesn't see zero.
        d["cloudflare_flux2_used"] = sum(int(v or 0) for v in per_acc.values())
        ref.set({"data": d, "updated_at": time.time()}, merge=True)
    except Exception as e:
        log.debug(f"cf quota inc failed: {e}")


def _cloudflare_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via Cloudflare Workers AI (Flux 2 [dev]).
    Returns (path, seed) on success, (None, seed) on any failure.

    Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in env
    (populated by keys_sync on worker boot OR by channel_cf per-render).
    Soft-caps at _CF_DAILY_CAP images/day via PB counter — beyond that
    _provider_ready returns False and the chain falls through to
    Pollinations.

    Flux 2 [dev] REQUIRES multipart/form-data (JSON body returns
    HTTP 400: 'required properties at / are multipart'). We send
    fields via requests.post(files=...) which auto-encodes as
    multipart with boundary. Response body is raw image bytes."""
    seed = int(hashlib.md5(f"{prompt}|{trial}|cf".encode()).hexdigest()[:8], 16)

    if _cf_breaker_skip():
        wait = int(_CF_OPEN_UNTIL - time.time())
        log.info(f"Cloudflare Flux 2 [klein-9b]: breaker OPEN (skipping; reopens in {wait}s)")
        return None, seed

    # Multi-account pool. If CLOUDFLARE_ACCOUNTS_JSON is set at /keys,
    # _cf_account_pool() returns the parsed list; otherwise a single
    # entry synthesised from the legacy env creds. Either way we loop
    # here so a 429-quota on one account rotates to the next
    # transparently.
    pool = _cf_account_pool()
    if not pool:
        # _provider_ready should have caught this — belt-and-braces.
        return None, seed

    # Flux 2 klein wants natural language (Qwen encoder), NOT tag lists.
    # _distill_prompt_for_flux keeps the sentence structure intact and
    # caps at ~600 chars (~120 words) — BFL's sweet spot for klein.
    final_prompt = _distill_prompt_for_flux(prompt)[:700]

    fields: dict = {
        "prompt":   (None, final_prompt),
        # Klein is a DISTILLED Flux 2 — designed for 4-8 steps.
        "steps":    (None, "6"),
        "guidance": (None, "3.5"),
        "seed":     (None, str(seed)),
    }
    if negative_prompt:
        fields["negative_prompt"] = (None, negative_prompt[:200])

    dest = os.path.join(output_dir, f"cloudflare_{seed:08x}.jpg")

    # Save/restore env so _cf_account_key() (which reads
    # CLOUDFLARE_ACCOUNT_ID) sees the account that actually made THIS
    # request when we call _cf_quota_inc / _cf_breaker_record below.
    # This is cleaner than plumbing an account_id parameter through
    # every quota helper.
    _env_acc = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    _env_tok = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    try:
        for acc_entry in pool:
            account_id = acc_entry["account_id"]
            api_token  = acc_entry["api_token"]
            label      = acc_entry.get("label") or account_id[:8]

            if _CF_BURNED_TODAY.get(account_id) == _cf_today_key():
                # Marked burned earlier this UTC day — skip immediately.
                continue

            os.environ["CLOUDFLARE_ACCOUNT_ID"] = account_id
            os.environ["CLOUDFLARE_API_TOKEN"] = api_token

            url = (
                f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
                f"/ai/run/@cf/black-forest-labs/flux-2-klein-9b"
            )
            log.debug(f"Cloudflare Flux 2 [klein-9b]: attempt {trial+1} account={label} seed={seed:08x}")

            try:
                r = requests.post(
                    url,
                    headers={"Authorization": f"Bearer {api_token}"},
                    files=fields,
                    timeout=45,
                )
            except Exception as e:
                _cf_breaker_record(success=False)
                log.warning(f"Cloudflare Flux 2 [klein-9b] ({label}) network error: {e}")
                return None, seed

            if r.status_code in (401, 403):
                _cf_breaker_record(success=False, http_status=r.status_code)
                log.warning(
                    f"Cloudflare Flux 2 [klein-9b] ({label}): HTTP {r.status_code} — "
                    f"auth failure (check the token in CLOUDFLARE_ACCOUNTS_JSON)"
                )
                return None, seed

            if r.status_code == 429:
                # CF's 429 on Workers AI means one of:
                #   (a) the daily free 10k-neuron bucket is exhausted, OR
                #   (b) a short-lived per-minute rate ceiling.
                # The response body carries the distinction — "used up
                # your daily free allocation" → mark burned + rotate;
                # anything else → treat as a real rate-limit + trip
                # the breaker as before.
                body = r.text[:400]
                if "used up your daily free allocation" in body.lower():
                    _cf_mark_burned(account_id)
                    log.warning(
                        f"Cloudflare account '{label}' burned for today "
                        f"({len([1 for a in pool if _CF_BURNED_TODAY.get(a['account_id']) != _cf_today_key()])}"
                        f" of {len(pool)} accounts still viable) — rotating"
                    )
                    # Try the next viable account in the pool.
                    continue
                # Non-quota 429 (per-minute rate-limit) — trip breaker.
                _cf_breaker_record(success=False, http_status=429)
                log.warning(f"Cloudflare Flux 2 [klein-9b] ({label}): HTTP 429 (rate limit) — {body[:120]}")
                return None, seed

            if not r.ok:
                _cf_breaker_record(success=False)
                log.warning(f"Cloudflare Flux 2 [klein-9b] ({label}): HTTP {r.status_code} — {r.text[:200]}")
                return None, seed

            # Success. Parse the response body.
            ctype = (r.headers.get("Content-Type") or "").lower()
            img_bytes: bytes | None = None
            try:
                if "image/" in ctype:
                    img_bytes = r.content
                else:
                    data = r.json()
                    if not (data or {}).get("success", True):
                        _cf_breaker_record(success=False)
                        log.warning(f"Cloudflare Flux 2 [klein-9b] ({label}): API error {data.get('errors')}")
                        return None, seed
                    b64 = ((data.get("result") or {}).get("image") or "").strip()
                    if b64:
                        import base64 as _b64
                        img_bytes = _b64.b64decode(b64)
            except Exception as e:
                _cf_breaker_record(success=False)
                log.warning(f"Cloudflare Flux 2 [klein-9b] ({label}): response parse failed: {e}")
                return None, seed

            if not img_bytes or len(img_bytes) < 4096:
                _cf_breaker_record(success=False)
                log.warning(f"Cloudflare Flux 2 [klein-9b] ({label}): response empty / too small")
                return None, seed

            try:
                with open(dest, "wb") as f:
                    f.write(img_bytes)
            except Exception as e:
                _cf_breaker_record(success=False)
                log.warning(f"Cloudflare Flux 2 [klein-9b] ({label}): write failed: {e}")
                return None, seed

            _cf_breaker_record(success=True)
            # _cf_quota_inc reads CLOUDFLARE_ACCOUNT_ID from env — which
            # we set just above — so per-account daily counters stay
            # correct without any parameter plumbing.
            _cf_quota_inc(1)
            if len(pool) > 1:
                log.info(f"Cloudflare Flux 2 [klein-9b] ({label}): image generated (seed {seed:08x})")
            return dest, seed

        # Fell out of the loop — every account in the pool is burned.
        log.warning(
            f"Cloudflare Flux 2 [klein-9b]: all {len(pool)} pool account(s) exhausted for today — "
            f"chain falls through to next provider"
        )
        return None, seed
    finally:
        # Restore the pre-call env so nothing outside this function
        # observes the pool's internal account swapping.
        if _env_acc:
            os.environ["CLOUDFLARE_ACCOUNT_ID"] = _env_acc
        else:
            os.environ.pop("CLOUDFLARE_ACCOUNT_ID", None)
        if _env_tok:
            os.environ["CLOUDFLARE_API_TOKEN"] = _env_tok
        else:
            os.environ.pop("CLOUDFLARE_API_TOKEN", None)


# ── Pollinations circuit breaker ──────────────────────────────
# Pollinations rate-limits per ~minute. When we hit 429s we used to retry
# every shot which made things worse (hammered the same wall). The breaker:
#   • after N consecutive 429s, OPEN for OPEN_FOR seconds (skip the provider)
#   • on success, CLOSE (counter resets)
#
# State is module-level — survives across shots in one run.
_POLL_CONSECUTIVE_429 = 0
_POLL_OPEN_UNTIL = 0.0          # epoch seconds; if time.time() < this, skip
_POLL_BACKOFF_429 = 3            # consecutive 429s before tripping
_POLL_OPEN_FOR_SECONDS = 90      # how long to stay open once tripped


def _pollinations_breaker_skip():
    return time.time() < _POLL_OPEN_UNTIL


def _pollinations_breaker_record(success: bool, http_status: int | None = None):
    global _POLL_CONSECUTIVE_429, _POLL_OPEN_UNTIL
    if success:
        if _POLL_CONSECUTIVE_429:
            log.info("Pollinations: circuit breaker reset after successful call")
        _POLL_CONSECUTIVE_429 = 0
        return
    if http_status == 429:
        _POLL_CONSECUTIVE_429 += 1
        if _POLL_CONSECUTIVE_429 >= _POLL_BACKOFF_429:
            _POLL_OPEN_UNTIL = time.time() + _POLL_OPEN_FOR_SECONDS
            log.warning(
                f"Pollinations: circuit breaker OPEN — {_POLL_CONSECUTIVE_429} consecutive 429s; "
                f"skipping Pollinations for {_POLL_OPEN_FOR_SECONDS}s"
            )


# Flux prompt distiller — condenses long visual_description prose into
# a 15-25 word tag-style prompt. Flux only weights the first ~77 tokens
# meaningfully; sending a 500-char poetic description caused Flux to
# truncate and hallucinate a generic image. Distilled output is
# comma-separated subject + key details + style tags, which is what
# every stable-diffusion / Flux fine-tune expects.
_FLUX_DISTILL_CACHE: dict[str, str] = {}


# One-shot session flag — after the first NIM distiller timeout we
# stop calling NIM entirely and use the regex-based shortener for the
# rest of the render. Was previously burning ~30 sec per shot on NIM
# timeouts, one per shot × 8 shots = 4 minutes wasted per video.
_FLUX_DISTILLER_NIM_BROKEN = False


def _regex_distill(text: str) -> str:
    """Light natural-language cleanup — no LLM, no tag-splitting.

    Rewritten 2026-07-10 after the Flux-2 klein migration + a research
    pass against BFL's official prompt guide: klein uses a Qwen text
    encoder that wants NATURAL LANGUAGE. Comma-splitting sentences into
    tag style + appending "photorealistic, cinematic, sharp focus"
    quality-booster tags (what this function used to do) actively
    degrades klein output.

    So this function now only:
      - collapses whitespace runs
      - trims obvious filler phrases (still helps signal density)
      - hard-caps at ~600 chars (~120 words) which BFL calls the sweet
        spot for klein
    It preserves sentence punctuation so the model sees a paragraph, not
    a tag list.
    """
    import re
    t = (text or "").strip()
    # Kill filler phrases the LLM loves that add nothing for Flux.
    for junk in [
        "camera focuses on", "we see", "the frame captures",
        "the composition ", "the shot ", "the scene ", "the image ",
        "cinematic depth of field", "with a shallow depth of field",
    ]:
        t = re.sub(re.escape(junk), "", t, flags=re.IGNORECASE)
    # Whitespace cleanup only — preserve periods + commas as sentence
    # structure klein's encoder actually parses.
    t = re.sub(r"\s+", " ", t).strip()
    return t[:600].rstrip()


def _distill_prompt_for_flux(visual_description: str, channel: str = "") -> str:
    """Return a Flux-optimised tag-style prompt.

    Uses ONLY the deterministic regex distiller. NIM was previously used
    for a per-shot LLM rewrite, but the free tier's 40 rpm limit + our
    10 sec timeout meant every render burned quota on retries AND still
    fell back to regex. Skipping NIM entirely: same net output for
    slow-NIM renders (99% of them), zero rate-limit burn, no wasted
    wall-clock. The user can enable LLM distillation via the
    NIM_DISTILLER=1 env var if their NIM tier is genuinely fast.
    """
    key = (visual_description or "").strip()
    # Strip Nemotron's tokenization garbage — the model occasionally
    # returns unknown tokens as literal "<unk>" strings inside JSON,
    # which then reaches the image provider verbatim and causes 400s
    # (or with CF, an outright quota-burning gen of noise). Also drop
    # any JSON-wrapper the model added around the actual prompt.
    if "<unk>" in key:
        key = key.replace("<unk>", "").strip()
    if key.startswith("{") and '"prompt"' in key:
        try:
            _j = json.loads(key)
            if isinstance(_j, dict) and isinstance(_j.get("prompt"), str):
                key = _j["prompt"].strip()
        except Exception:
            pass
    if not key:
        return ""
    if key in _FLUX_DISTILL_CACHE:
        return _FLUX_DISTILL_CACHE[key]
    if os.getenv("NIM_DISTILLER", "").strip() not in ("1", "true", "yes"):
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out
    # Opt-in NIM path (user set NIM_DISTILLER=1). Same guard as before —
    # first NIM failure of the session flips the session-wide broken
    # flag so subsequent shots go straight to regex.
    global _FLUX_DISTILLER_NIM_BROKEN
    if _FLUX_DISTILLER_NIM_BROKEN:
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out
    try:
        prompt = (
            "Rewrite the scene below into a short image-generation prompt "
            "for Flux / SDXL. Format: 15 to 25 words, comma-separated. "
            "Structure: MAIN SUBJECT, key visual details, environment, "
            "lighting/mood, style tags. No poetic prose, no complete "
            "sentences, no 'shot' / 'scene' / 'image' words. "
            f"Channel: {channel or 'generic'}.\n\nSCENE: {key[:400]}\n\n"
            "Reply with ONLY the prompt string."
        )
        raw = nim.chat(
            messages=[{"role": "user", "content": prompt}],
            model="meta/llama-3.3-70b-instruct",
            max_tokens=80,
            temperature=0.5,
            stream=False,
            timeout=10,
            attempts=1,
        )
        distilled = (raw or "").strip().strip('"').strip().split("\n")[0]
        for pfx in ("Prompt:", "prompt:", "PROMPT:", "-"):
            if distilled.lower().startswith(pfx.lower()):
                distilled = distilled[len(pfx):].strip()
        distilled = distilled[:240]
        if len(distilled) < 15:
            distilled = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = distilled
        return distilled
    except Exception as e:
        _FLUX_DISTILLER_NIM_BROKEN = True
        log.warning(f"flux distiller (NIM opt-in): failed ({e}); regex from now on")
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out


# ── Stable Horde (community-run, genuinely free, SDXL) ────────
# Works anonymously (no signup, no card) — that's the whole point vs
# Together.ai which now gates every key behind a deposit. Anonymous
# uses a shared kudos queue (slower under load, ~30-60 sec typical);
# a free STABLEHORDE_API_KEY unlocks priority. Real Stable Diffusion
# XL weights — materially higher quality than Pollinations Flux.
#
# API: https://stablehorde.net/api/v2/
#   POST /generate/async  → returns { id }
#   GET  /generate/check/<id> → poll until { done: true }
#   GET  /generate/status/<id> → returns final { generations: [{ img: <b64> }] }
_HORDE_CONSEC_FAIL = 0
_HORDE_OPEN_UNTIL  = 0.0


def _horde_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via Stable Horde's SDXL crowdsourced endpoint.
    Returns (path, seed) on success, (None, seed) on failure/timeout.

    Uses the STABLEHORDE_API_KEY env var if set (priority in the queue),
    otherwise falls back to '0000000000' which the horde treats as
    anonymous — still works, just slower under load.
    """
    seed = int(hashlib.md5(f"{prompt}|{trial}|horde".encode()).hexdigest()[:8], 16)
    global _HORDE_CONSEC_FAIL, _HORDE_OPEN_UNTIL
    if time.time() < _HORDE_OPEN_UNTIL:
        return None, seed
    api_key = os.getenv("STABLEHORDE_API_KEY", "").strip() or "0000000000"
    # Distil to a Flux/SDXL-style tag prompt for best-quality output.
    final_prompt = _distill_prompt_for_flux(prompt)[:600]
    dest = os.path.join(output_dir, f"horde_{seed:08x}.jpg")
    try:
        # Submit async job.
        submit = requests.post(
            "https://stablehorde.net/api/v2/generate/async",
            headers={
                "apikey": api_key,
                "Client-Agent": "yt-agent:1.0:https://github.com/Ahsan3301/yt_agent",
                "Content-Type": "application/json",
            },
            json={
                "prompt":  final_prompt + (f" ### {negative_prompt}" if negative_prompt else ""),
                "params":  {
                    "sampler_name":     "k_euler",
                    "cfg_scale":        6.0,
                    "steps":            20,
                    "width":            576,
                    "height":           1024,
                    "seed":             str(seed),
                    "n":                1,
                },
                "models":  ["AlbedoBase XL (SDXL)", "Fustercluck", "Juggernaut XL"],
                "nsfw":    False,
                "trusted_workers": True,
                "r2":       True,
            },
            timeout=30,
        )
        if submit.status_code == 429:
            _HORDE_CONSEC_FAIL += 1
            if _HORDE_CONSEC_FAIL >= 3:
                _HORDE_OPEN_UNTIL = time.time() + 120
                log.warning("Stable Horde: 3x 429 -> circuit break 120 sec")
            return None, seed
        submit.raise_for_status()
        job_id = submit.json().get("id")
        if not job_id:
            log.warning(f"Stable Horde: no job id in response: {submit.text[:200]}")
            return None, seed
        # Poll until done (or 90 sec hard cap).
        # Previously 300 sec (5 min) — but Horde's queue is often congested
        # even with a priority API key. Waiting 5 min per stuck shot and
        # then falling through to Pollinations meant a 9-shot render
        # could take 45+ min. 90 sec is enough for a healthy queue
        # (typical priority-key completion is 15-40 sec); stuck jobs
        # fall through to Pollinations faster and the render moves on.
        deadline = time.time() + 90
        img_url = ""
        while time.time() < deadline:
            time.sleep(3)
            check = requests.get(
                f"https://stablehorde.net/api/v2/generate/check/{job_id}",
                timeout=15,
            )
            if not check.ok:
                continue
            js = check.json()
            if js.get("done"):
                break
            if js.get("faulted"):
                log.warning(f"Stable Horde: job faulted after {int(time.time()-(deadline-300))}s")
                return None, seed
        else:
            log.warning("Stable Horde: 5 min timeout, no result")
            return None, seed
        status = requests.get(
            f"https://stablehorde.net/api/v2/generate/status/{job_id}",
            timeout=30,
        )
        status.raise_for_status()
        gens = status.json().get("generations") or []
        if not gens:
            return None, seed
        # r2=True → generations[0].img is a URL. Otherwise it's base64.
        img_field = gens[0].get("img", "")
        if img_field.startswith("http"):
            img_url = img_field
            img_r = requests.get(img_url, timeout=30)
            img_r.raise_for_status()
            with open(dest, "wb") as f:
                f.write(img_r.content)
        else:
            import base64 as _b64
            with open(dest, "wb") as f:
                f.write(_b64.b64decode(img_field))
        if os.path.getsize(dest) < 4096:
            return None, seed
        _HORDE_CONSEC_FAIL = 0
        log.info(f"Stable Horde: image ok (seed {seed}, {os.path.getsize(dest)//1024} KB)")
        return dest, seed
    except Exception as e:
        _HORDE_CONSEC_FAIL += 1
        log.warning(f"Stable Horde gen failed: {e}")
        return None, seed


# Serialise Pollinations requests across threads. The public endpoint
# returns 429 aggressively when two calls land within a few hundred ms
# of each other — which happens instantly with the ThreadPoolExecutor.
# Three consecutive 429s trips the circuit breaker for 90s and the rest
# of the shots get dropped. This lock + a 1.5 sec min-interval turns
# the parallel pool into serialised Pollinations calls (still faster
# than the OLD serial-shot code because stock lookups + other providers
# still run in parallel — only Pollinations itself is one-at-a-time).
import threading as _poll_threading
_POLL_CALL_LOCK = _poll_threading.Lock()
_POLL_LAST_CALL_AT = 0.0
_POLL_MIN_INTERVAL = 1.5


def _pollinations_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via Pollinations, respecting the circuit breaker.
    Returns (path, seed) on success, (None, seed) on any failure.

    Pollinations Flux has NO native negative_prompt parameter, so we
    append a plain-English `avoid: …` clause to the prompt. Flux's
    caption model is decent at honouring it in practice, though the
    effect is weaker than SDXL's proper negative_prompt path."""
    seed = int(hashlib.md5(f"{prompt}|{trial}".encode()).hexdigest()[:8], 16)

    if _pollinations_breaker_skip():
        wait = int(_POLL_OPEN_UNTIL - time.time())
        log.info(f"Pollinations: breaker OPEN (skipping; reopens in {wait}s)")
        return None, seed

    # Pollinations URL-encodes the prompt into a GET URL.
    # Two coordinated changes that materially improved output quality:
    #   1. DISTILL the prompt to a 15-25 word tag-style Flux prompt.
    #      Flux only weights the first ~77 tokens, so sending 500-char
    #      poetic prose caused it to truncate + hallucinate a generic
    #      image. Comma-separated subject + details + style at the end
    #      is what stable-diffusion + Flux fine-tunes were trained on.
    #   2. No negative-prompt clause — Flux via Pollinations doesn't
    #      respect it strongly, and appending it just pushed the URL
    #      past Pollinations' 500-storm threshold.
    final_prompt = _distill_prompt_for_flux(prompt)[:400]
    encoded = urllib.parse.quote(final_prompt, safe="")
    # Rotate the Pollinations model across attempts. All three verified
    # working (flux + sdxl + flux-pro) — cycling means a bad prompt on
    # flux gets retried on sdxl instead of just failing. Also gives
    # visual variety across shots so the video doesn't look monochrome.
    # trial 0 → flux, 1 → sdxl, 2 → flux-pro, 3 → flux, 4 → sdxl ...
    _POLL_MODELS = ("flux", "sdxl", "flux-pro")
    poll_model = _POLL_MODELS[trial % len(_POLL_MODELS)]
    url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=1080&height=1920&seed={seed}&model={poll_model}&nologo=true&private=true"
        f"&safe={'true' if F._restrictions_on() else 'false'}"
    )
    dest = os.path.join(output_dir, f"pollinations_{poll_model}_{seed:08x}.jpg")
    log.debug(f"Pollinations: using model={poll_model} (attempt {trial+1})")

    try:
        # Serialise across threads + enforce a min interval between
        # successive calls. Two parallel threads used to hit the endpoint
        # simultaneously, both get 429, and the breaker trips after 3 in
        # a row — killing the rest of the shots.
        global _POLL_LAST_CALL_AT
        with _POLL_CALL_LOCK:
            _now = time.time()
            gap = _now - _POLL_LAST_CALL_AT
            if gap < _POLL_MIN_INTERVAL:
                time.sleep(_POLL_MIN_INTERVAL - gap)
            _POLL_LAST_CALL_AT = time.time()
            r = requests.get(url, stream=True, timeout=120)
        if r.status_code == 429:
            _pollinations_breaker_record(success=False, http_status=429)
            log.warning("Pollinations 429 — breaker counter bumped")
            return None, seed
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        if not os.path.exists(dest) or os.path.getsize(dest) < 4096:
            _pollinations_breaker_record(success=False)
            return None, seed
        _pollinations_breaker_record(success=True)
        return dest, seed
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        _pollinations_breaker_record(success=False, http_status=status)
        log.warning(f"Pollinations gen failed (HTTP {status}): {e}")
        return None, seed
    except Exception as e:
        _pollinations_breaker_record(success=False)
        log.warning(f"Pollinations gen failed: {e}")
        return None, seed


def reset_pollinations_breaker():
    """Reset the breaker — called at the start of each pipeline run."""
    global _POLL_CONSECUTIVE_429, _POLL_OPEN_UNTIL
    _POLL_CONSECUTIVE_429 = 0
    _POLL_OPEN_UNTIL = 0.0


# ── HuggingFace Inference API (free fallback when Pollinations is rate-limited) ─
# Same breaker pattern as Pollinations. HF returns image bytes directly.
# Default model is SDXL base 1.0 — fast and gives decent horror/cinematic.
_HF_CONSECUTIVE_FAILS = 0
_HF_OPEN_UNTIL = 0.0
_HF_BACKOFF_THRESHOLD = 3
_HF_OPEN_FOR_SECONDS = 120

_HF_MODEL = os.getenv("HF_IMAGE_MODEL",
                     "stabilityai/stable-diffusion-xl-base-1.0")


def _hf_breaker_skip():
    return time.time() < _HF_OPEN_UNTIL


def _hf_breaker_record(success: bool, http_status: int | None = None):
    global _HF_CONSECUTIVE_FAILS, _HF_OPEN_UNTIL
    if success:
        if _HF_CONSECUTIVE_FAILS:
            log.info("HuggingFace: circuit breaker reset after successful call")
        _HF_CONSECUTIVE_FAILS = 0
        return
    # Any failure (5xx, 429, network) counts. Trip the breaker on N
    # consecutive fails so we don't hammer a sick service.
    _HF_CONSECUTIVE_FAILS += 1
    if _HF_CONSECUTIVE_FAILS >= _HF_BACKOFF_THRESHOLD:
        _HF_OPEN_UNTIL = time.time() + _HF_OPEN_FOR_SECONDS
        log.warning(
            f"HuggingFace: circuit breaker OPEN — {_HF_CONSECUTIVE_FAILS} "
            f"consecutive failures (status={http_status}); skipping for "
            f"{_HF_OPEN_FOR_SECONDS}s"
        )


def reset_hf_breaker():
    global _HF_CONSECUTIVE_FAILS, _HF_OPEN_UNTIL
    _HF_CONSECUTIVE_FAILS = 0
    _HF_OPEN_UNTIL = 0.0


def _huggingface_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via HF Inference API. Returns (path, seed) on
    success, (None, seed) on failure. Honours its own circuit breaker.

    Needs HF_TOKEN env var. Token is free at
    https://huggingface.co/settings/tokens (Read scope is enough).
    negative_prompt is passed to SDXL as a real parameter (native
    support), unlike Pollinations Flux which has no negative field."""
    token = os.getenv("HF_TOKEN", "").strip()
    seed = int(hashlib.md5(f"{prompt}|{trial}|hf".encode()).hexdigest()[:8], 16)
    if not token:
        return None, seed
    if _hf_breaker_skip():
        wait = int(_HF_OPEN_UNTIL - time.time())
        log.info(f"HuggingFace: breaker OPEN (skipping; reopens in {wait}s)")
        return None, seed

    dest = os.path.join(output_dir, f"huggingface_{seed:08x}.jpg")
    # HuggingFace shut down api-inference.huggingface.co in mid-2025 when
    # they rebranded to Inference Providers. The domain no longer resolves
    # at all (DNS NXDOMAIN). New endpoint is under router.huggingface.co,
    # backed by the hf-inference provider by default. Configurable via
    # HF_INFERENCE_PROVIDER env in case the user wants replicate/fal via
    # HF's routing layer instead.
    provider = os.getenv("HF_INFERENCE_PROVIDER", "hf-inference").strip() or "hf-inference"
    url = f"https://router.huggingface.co/{provider}/models/{_HF_MODEL}"
    try:
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                # Wait for model to warm up rather than 503 immediately —
                # HF caches models in memory after a few requests.
                "x-wait-for-model": "true",
                # Get a fresh image, not a cached one for the same prompt.
                "x-use-cache": "false",
            },
            json={
                "inputs": prompt,
                "parameters": {
                    # SDXL natively wants 1024x1024; we resize later. 9:16
                    # generation is supported but quality drops at extreme
                    # aspects, so stay square and crop in the editor.
                    "width": 1024,
                    "height": 1024,
                    "guidance_scale": 7.5,
                    "num_inference_steps": 25,
                    "seed": seed,
                    # Native negative-prompt support on SDXL. Empty string
                    # is fine — the API treats it the same as omitting.
                    "negative_prompt": negative_prompt or "",
                },
                "options": {"wait_for_model": True},
            },
            timeout=120,
        )
        if r.status_code == 429:
            _hf_breaker_record(success=False, http_status=429)
            log.warning("HuggingFace 429 — rate limited")
            return None, seed
        if r.status_code == 503:
            # Model still loading — short wait + breaker bump
            _hf_breaker_record(success=False, http_status=503)
            log.info("HuggingFace 503 — model loading, will retry next shot")
            return None, seed
        r.raise_for_status()
        # HF returns raw image bytes (jpeg or png).
        with open(dest, "wb") as f:
            f.write(r.content)
        if not os.path.exists(dest) or os.path.getsize(dest) < 4096:
            _hf_breaker_record(success=False)
            log.warning("HuggingFace returned <4 KB file — treating as failure")
            return None, seed
        _hf_breaker_record(success=True)
        return dest, seed
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        _hf_breaker_record(success=False, http_status=status)
        log.warning(f"HuggingFace gen failed (HTTP {status}): {e}")
        return None, seed
    except Exception as e:
        _hf_breaker_record(success=False)
        log.warning(f"HuggingFace gen failed: {e}")
        return None, seed


# ── Local SDXL (via diffusers) — free GPU-only fallback ──────────
#
# Runs on the worker's own CUDA device (T4/P100 on Colab/Kaggle).
# Model is cached on first use; subsequent generations are ~5-8 sec.
# No rate limits, no API keys, and native negative_prompt support.
# On a CPU-only worker this provider silently no-ops.

# Device-keyed pipeline cache. Empty on CPU; single entry {0: pipe} on
# T4x1; two entries {0: pipe0, 1: pipe1} when running on T4x2 with
# multi-GPU mode enabled. Each pipe is bound to its own CUDA device so
# round-robin dispatch from _fetch_one can drive both cards concurrently.
_LOCAL_SDXL_PIPES: dict = {}
_LOCAL_SDXL_BROKEN = False
_LOCAL_SDXL_BROKEN_REASON = ""

# Providers whose "skipped ({reason})" line has already been logged
# in this worker's lifetime. Second and later shots that see the same
# provider unavailable log a terse breadcrumb instead of the full
# ~200-char reason (audit follow-up 2026-07-13). Reset by process
# restart — every fresh worker boot logs the full reason once.
_SKIP_REASON_LOGGED: set[str] = set()
# Per-device "this specific card can't load" markers. Used when GPU 0
# works but GPU 1 OOMs during load — we want to keep serving from GPU 0
# and just skip GPU 1 in round-robin, not tank the whole provider.
_LOCAL_SDXL_DEVICE_BROKEN: dict = {}
# Serialises the one-shot model load PER DEVICE. Two devices load in
# parallel because they hold different locks. Within a device, the
# standard double-checked pattern keeps the fast path lock-free.
import threading as _sdxl_threading
_LOCAL_SDXL_LOAD_LOCKS: dict = {}
_LOCAL_SDXL_LOCKS_LOCK = _sdxl_threading.Lock()
# Thread-local so shotfetch workers can each pin themselves to a GPU
# without threading a device_id through the whole provider-callable
# signature (huggingface/pollinations/horde are HTTP and ignore it).
_LOCAL_SDXL_TLS = _sdxl_threading.local()


def _sdxl_lock_for(device_id: int):
    with _LOCAL_SDXL_LOCKS_LOCK:
        lk = _LOCAL_SDXL_LOAD_LOCKS.get(device_id)
        if lk is None:
            lk = _sdxl_threading.Lock()
            _LOCAL_SDXL_LOAD_LOCKS[device_id] = lk
        return lk


def _current_sdxl_device() -> int:
    """Which cuda:N should this thread's local_sdxl call target?

    _fetch_one sets `_LOCAL_SDXL_TLS.device` per-shot in round-robin
    order (0,1,0,1,...) when multi-GPU is on. Anything outside that
    threadpool (e.g. pre-warm on the main thread) passes an explicit
    device_id, so this default only fires on unexpected callers → 0.
    """
    return int(getattr(_LOCAL_SDXL_TLS, "device", 0))


def _local_sdxl_load(device_id: int | None = None):
    """Lazy-load the diffusers pipeline on a specific CUDA device (thread-safe).

    Kept out of module import path so CPU workers never pay the
    diffusers/torch import tax. All failure paths WARN with actionable
    text so the priority loop's provider skip is diagnosable from logs.
    """
    if _LOCAL_SDXL_BROKEN:
        return None
    if device_id is None:
        device_id = _current_sdxl_device()
    if _LOCAL_SDXL_DEVICE_BROKEN.get(device_id):
        return None
    # Fast path — no lock needed once THIS device's pipeline exists.
    pipe = _LOCAL_SDXL_PIPES.get(device_id)
    if pipe is not None:
        return pipe
    # Slow path — grab the device's lock and re-check inside so exactly
    # ONE thread performs the download + CUDA move per device.
    with _sdxl_lock_for(device_id):
        if _LOCAL_SDXL_BROKEN:
            return None
        if _LOCAL_SDXL_DEVICE_BROKEN.get(device_id):
            return None
        pipe = _LOCAL_SDXL_PIPES.get(device_id)
        if pipe is not None:
            return pipe
        return _local_sdxl_load_locked(device_id)


def _local_sdxl_load_locked(device_id: int):
    """Actual load path. Caller must hold the per-device load lock."""
    global _LOCAL_SDXL_BROKEN, _LOCAL_SDXL_BROKEN_REASON
    # Import torch first — every other failure depends on it.
    try:
        import torch
    except ImportError as e:
        _LOCAL_SDXL_BROKEN = True
        _LOCAL_SDXL_BROKEN_REASON = f"torch not installed: {e}"
        log.warning(
            "local_sdxl: torch is not installed on this worker — provider "
            "DISABLED. Reinstall requirements-gpu.txt or run cell 3 of the "
            "Colab notebook."
        )
        return None
    if not torch.cuda.is_available():
        _LOCAL_SDXL_BROKEN = True
        _LOCAL_SDXL_BROKEN_REASON = "no CUDA device"
        log.warning(
            "local_sdxl: torch.cuda.is_available() is False — no GPU on this "
            "runtime. Provider DISABLED for this process. "
            "(This is normal for the Oracle side-worker + HF CPU Space.)"
        )
        return None
    # Preflight: modern PyTorch wheels dropped sm_5x + sm_6x kernels,
    # so a P100 (sm_6.0) or older Pascal will `.to("cuda")` and throw
    # cudaErrorNoKernelImageForDevice on the first tensor op. Skip
    # early so we don't waste time downloading a 7 GB SDXL model just
    # to fail on `.to("cuda")` at the end.
    try:
        _cap = torch.cuda.get_device_capability(device_id)
        if _cap[0] < 7:
            # This device can't run SDXL, but a SIBLING device might —
            # mark just this device broken so the other GPU keeps
            # serving. If it's the only device visible, the round-robin
            # dispatcher will fall through to the next AI provider on
            # its own once every device is broken.
            _LOCAL_SDXL_DEVICE_BROKEN[device_id] = (
                f"cuda:{device_id} sm_{_cap[0]}.{_cap[1]} < sm_7.0"
            )
            log.info(
                f"local_sdxl[cuda:{device_id}] skipped: "
                f"{_LOCAL_SDXL_DEVICE_BROKEN[device_id]}"
            )
            return None
    except Exception:
        pass   # fall through if the probe itself fails
    try:
        from diffusers import AutoPipelineForText2Image
    except ImportError as e:
        _LOCAL_SDXL_BROKEN = True
        _LOCAL_SDXL_BROKEN_REASON = f"diffusers not installed: {e}"
        log.warning(
            "local_sdxl: diffusers is not installed on this worker — provider "
            "DISABLED. On Colab: re-run cell 3 (it now installs diffusers "
            "transformers accelerate). On Kaggle: `pip install diffusers>=0.30 "
            "transformers>=4.40 accelerate>=0.30`."
        )
        return None
    model_id = os.getenv(
        "LOCAL_SDXL_MODEL",
        (load_settings().get("image_gen", {}) or {}).get(
            "local_sdxl_model", "stabilityai/sdxl-turbo"
        ),
    )
    # First-load model download is ~7 GB for sdxl-turbo. The user needs to
    # see this happening so they don't think the render is stuck. Log to
    # WARN so it lands on the dashboard's realtime log stream.
    log.warning(
        f"local_sdxl: loading pipeline model={model_id!r} — first-load "
        f"download can be 2-5 min on a fresh Colab/Kaggle runtime "
        f"(cached for the rest of the session)."
    )
    # Hard timeout on the download so a genuinely stuck fetch (HF outage,
    # network drop) bails the provider instead of blocking every shot.
    # Falls through to the next provider in the priority loop. 6 min is
    # generous — a healthy fetch finishes in 60-120 sec.
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "360")
    try:
        # bfloat16 gives quality parity with fp16 on Ampere+/Hopper and
        # avoids some VAE overflow artifacts. On Turing (T4, sm_7.5) and
        # older, bf16 is only available via slow software emulation. But
        # newer PyTorch's is_bf16_supported() counts emulation as
        # supported → returns True on T4 → pipeline runs on emulated bf16
        # which is slow AND less numerically stable than native fp16
        # (contributed to the SDXL scheduler off-by-one indexing bug we
        # were hitting on T4). Gate on compute capability instead:
        # sm_8.0 = Ampere, first arch with hardware bf16.
        cap = torch.cuda.get_device_capability(device_id)
        use_bf16 = cap[0] >= 8
        dtype = torch.bfloat16 if use_bf16 else torch.float16
        # The `variant="fp16"` load path only exists for models that
        # actually publish an fp16-suffixed weights file. sdxl-turbo does;
        # some community forks do not. Fall back to variant=None on a
        # load failure so a swapped-in model still boots.
        # low_cpu_mem_usage=False loads the whole state_dict in one shot
        # instead of materializing each of ~517 layer params one at a time
        # (diffusers default). Skips a ~8 min per-layer loop on SDXL first
        # load — the biggest single win when local_sdxl is primary. Costs
        # ~3× peak CPU RAM during load; Kaggle T4×2 has 31 GB free so
        # we're well under.
        # Pin the LOAD thread's default CUDA device to device_id so any
        # default-device allocations diffusers makes during .to() land
        # on THIS card, not cuda:0. Matches the pattern in _local_sdxl_
        # generate below — see comment there for the "Half vs Float"
        # bug this prevents.
        torch.cuda.set_device(device_id)
        # low_cpu_mem_usage=False is ~7× faster to load but needs ~3×
        # peak CPU RAM (whole state_dict materialised in one shot). On
        # Kaggle T4×2 with 31 GB RAM that's fine; on Colab T4×1 with
        # only 12.7 GB RAM the kernel OOM-killed uvicorn during load
        # (returncode=-9). Auto-detect: use the fast path only when
        # total RAM ≥ 24 GB; drop to the diffusers default (True,
        # per-layer materialise) on low-RAM hosts. ~2 min slower first
        # load on Colab vs OOM crash.
        try:
            import psutil
            _total_gb = psutil.virtual_memory().total / (1024**3)
        except Exception:
            _total_gb = 32.0  # assume roomy on probe failure
        _low_cpu = _total_gb < 24.0
        if _low_cpu:
            log.info(
                f"local_sdxl: {_total_gb:.1f} GB RAM detected — using "
                f"low_cpu_mem_usage=True (slower load, avoids OOM on Colab)"
            )
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id,
                torch_dtype=dtype,
                variant="fp16" if not use_bf16 else None,
                use_safetensors=True,
                low_cpu_mem_usage=_low_cpu,
            )
        except Exception as e_variant:
            log.warning(
                f"local_sdxl: variant='fp16' load failed ({e_variant}); "
                f"retrying without variant hint …"
            )
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id, torch_dtype=dtype, use_safetensors=True,
                low_cpu_mem_usage=_low_cpu,
            )
        pipe = pipe.to(f"cuda:{device_id}")
        # SDXL fp16 VAE NaN fix — the classic "SDXL outputs all-black
        # images on Turing" bug. On T4 (sm_7.5) and older, SDXL's VAE
        # decoder can overflow to NaN in fp16, producing entirely
        # black images. Ampere+ (bf16) doesn't hit this because bf16
        # has a wider dynamic range. Fix: cast VAE to fp32 on non-bf16
        # devices. Costs ~200 MB VRAM (tiny) but eliminates black
        # outputs. Confirmed live 2026-07-10 on Colab T4: 11/11 shots
        # rendered as full-black PNGs before this fix, subs+audio
        # burned onto pure black.
        if not use_bf16:
            try:
                pipe.vae = pipe.vae.to(torch.float32)
                log.info(
                    f"local_sdxl[cuda:{device_id}]: VAE cast to fp32 to avoid "
                    f"Turing/fp16 NaN overflow (black-image bug)"
                )
            except Exception as _vae_e:
                log.warning(f"local_sdxl: VAE fp32 cast failed: {_vae_e}")
        # Memory-thrift knobs — matters on T4-16GB.
        try:
            pipe.enable_vae_slicing()
            pipe.enable_attention_slicing()
        except Exception:
            pass
        _LOCAL_SDXL_PIPES[device_id] = pipe
        log.warning(
            f"local_sdxl[cuda:{device_id}]: pipeline READY "
            f"(dtype={dtype}, model={model_id})"
        )
        return pipe
    except Exception as e:
        _msg = f"{type(e).__name__}: {e}"
        # Import-time errors are TERMINAL for the whole provider (both
        # GPUs), not per-device. Example: transformers>=4.50 removed
        # AlbertModel + PreTrainedModel lazy-imports that Kokoro and
        # diffusers depend on. Retrying on the sibling GPU crashes with
        # the same error. Kill the whole provider so the shot fetch
        # loop falls through to pollinations after the first attempt.
        if any(m in _msg for m in ("Could not import module",
                                   "Failed to import",
                                   "No module named")):
            _LOCAL_SDXL_BROKEN = True
            _LOCAL_SDXL_BROKEN_REASON = _msg[:200]
            log.warning(
                f"local_sdxl: TERMINAL import error, provider DISABLED "
                f"for this process — {_msg[:200]}. All shots skip to next "
                f"AI provider (pollinations/horde/hf)."
            )
            return None
        # Per-device failure: mark THIS device broken (not the whole
        # provider) so a sibling GPU can keep serving. Only when every
        # device is broken does the provider actually stop responding.
        _LOCAL_SDXL_DEVICE_BROKEN[device_id] = _msg[:200]
        log.warning(
            f"local_sdxl[cuda:{device_id}]: pipeline load FAILED "
            f"({_msg}). Common causes: OOM (VRAM), corrupted HF cache, "
            f"model id typo. Sibling GPUs (if any) keep serving; if "
            f"none, priority loop skips to next provider."
        )
        return None


def _local_sdxl_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image on the local GPU. Returns (path, seed) on
    success, (None, seed) on failure or when disabled.

    Device selection: thread-local, set by _fetch_one round-robin. On
    T4x1 always cuda:0; on T4x2 alternates cuda:0/cuda:1 per shot.
    """
    seed = int(hashlib.md5(f"{prompt}|{trial}|sdxl".encode()).hexdigest()[:8], 16)
    device_id = _current_sdxl_device()
    pipe = _local_sdxl_load(device_id)
    if pipe is None:
        return None, seed
    try:
        import torch
        # Pin THIS thread's default CUDA device to device_id for the
        # duration of the generate call. Diffusers' internal allocations
        # (torch.zeros/ones/tensor without device=) go to the CURRENT
        # default device — otherwise they land on cuda:0 and collide
        # with the fp16 pipe on cuda:1, throwing "expected scalar type
        # Half but found Float" on every attempt. Confirmed live: with-
        # out this, cuda:0 worked but cuda:1 failed every retry. Each
        # ThreadPoolExecutor worker has its own current_device, so
        # per-thread set_device is safe.
        torch.cuda.set_device(device_id)
        gen = torch.Generator(device=f"cuda:{device_id}").manual_seed(seed)
        # SDXL-Turbo is calibrated for very few steps + guidance 0. If the
        # user swapped to a full SDXL model, guidance 5-7 + 25 steps is a
        # good default; we detect via the pipe class name.
        # pipe.name_or_path may be None on some diffusers versions; coerce
        # to str before .lower() so we don't crash the whole provider.
        pipe_name = str(getattr(pipe, "name_or_path", "") or "").lower()
        env_model = str(os.getenv("LOCAL_SDXL_MODEL", "") or "").lower()
        settings_model = str(
            (load_settings().get("image_gen", {}) or {}).get("local_sdxl_model", "")
        ).lower()
        is_turbo = "turbo" in pipe_name or "turbo" in env_model or "turbo" in settings_model
        kwargs = {
            "prompt": prompt,
            # Passing "" (not None) matters on SDXL-turbo. With
            # negative_prompt=None + guidance_scale=0, diffusers builds
            # DEFAULT negative embeddings in torch's default dtype
            # (float32) instead of matching the pipe's fp16 weights —
            # then the first cross-attention op throws "expected scalar
            # type Half but found Float". Empty-string forces the
            # tokenizer path which produces embeddings in the right
            # dtype. Confirmed live on both cuda:0 and cuda:1.
            "negative_prompt": negative_prompt or "",
            "height": 1024,
            "width": 576,   # 9:16 portrait; SDXL handles this via 32-multiple sizes
            "generator": gen,
        }
        if is_turbo:
            # 5 (not 4) — SDXL-turbo's default EulerDiscreteScheduler
            # creates a sigmas array of length num_inference_steps+1. At
            # steps=4 the array is length 5; one code path inside
            # diffusers' turbo prompt-encoder branch tries to access
            # sigmas[num_inference_steps]=sigmas[5] and blows up with
            # "index 5 is out of bounds for dimension 0 with size 5" on
            # ~half the generation attempts. Bumping to 5 makes the
            # array length 6 → index 5 is valid → the bug can't fire.
            # +25% inference time (~0.5-1 sec / image on T4) is trivial
            # vs losing an entire retry to the crash.
            kwargs.update({"num_inference_steps": 5, "guidance_scale": 0.0})
        else:
            kwargs.update({"num_inference_steps": 25, "guidance_scale": 6.5})
        # Belt-and-suspenders: autocast to fp16 forces every internal op
        # to fp16 regardless of what dtype a rogue tensor was allocated
        # in. Cheap on T4 and catches any negative-embedding / latent
        # / conditioning-tensor path we haven't seen yet. Torch's
        # autocast is context-manager based and thread-safe.
        _pipe_dtype = torch.float16  # T4 uses fp16; sm_8+ uses bfloat16
        try:
            _pipe_dtype = next(pipe.unet.parameters()).dtype
        except Exception:
            pass
        with torch.autocast(device_type="cuda", dtype=_pipe_dtype):
            image = pipe(**kwargs).images[0]
        # Sanity check for degenerate outputs BEFORE saving. Turing +
        # fp16 SDXL can produce NaN → PIL renders as fully black; a
        # partial VAE overflow can produce near-uniform grey/purple.
        # Reject anything with too little colour variance so the
        # vision-judge-disabled fallback path doesn't accept a pure
        # black image and end up with a black final video. Confirmed
        # live 2026-07-10.
        try:
            import numpy as _np
            _arr = _np.asarray(image).astype(_np.float32)
            _std = float(_arr.std())
            _mean = float(_arr.mean())
            if _std < 8.0 or _mean < 6.0:
                log.warning(
                    f"local_sdxl[cuda:{device_id}]: degenerate output "
                    f"(mean={_mean:.1f}, std={_std:.1f}) — likely VAE overflow "
                    f"or all-black; treating as failure"
                )
                return None, seed
        except Exception:
            pass  # sanity check is best-effort; don't block save on numpy failure
        dest = os.path.join(output_dir, f"local_sdxl_{seed:08x}.jpg")
        image.save(dest, quality=92)
        if not os.path.exists(dest) or os.path.getsize(dest) < 4096:
            log.warning("local_sdxl: pipe returned <4 KB — treating as failure")
            return None, seed
        return dest, seed
    except Exception as e:
        msg = str(e)
        # Terminal errors: CUDA capability mismatch means the torch
        # wheel doesn't have kernels for this GPU. OOM means this
        # device can't run the model. Both are permanent for the
        # affected device — mark THAT device broken so we don't waste
        # 5 attempts on the same failure, but let sibling GPUs keep
        # serving (T4x2). The _provider_ready check demotes the
        # provider only after every device is broken.
        terminal_markers = (
            "no kernel image is available",
            "cudaErrorNoKernelImageForDevice",
            "CUDA out of memory",
            "CUDA driver version is insufficient",
        )
        # Import-time markers: diffusers/transformers version conflict
        # (e.g. transformers>=4.50 removed AlbertModel + PreTrainedModel
        # lazy-import) breaks the ENTIRE provider on every shot, not
        # just this device. Kill the whole provider so the fetch loop
        # falls through to pollinations instead of retrying the same
        # broken import 5×N shots. Confirmed live 2026-07-09.
        import_markers = (
            "Could not import module",
            "Failed to import",
            "No module named",
        )
        if any(m in msg for m in import_markers):
            global _LOCAL_SDXL_BROKEN, _LOCAL_SDXL_BROKEN_REASON
            _LOCAL_SDXL_BROKEN = True
            _LOCAL_SDXL_BROKEN_REASON = msg[:200]
            log.warning(
                f"local_sdxl: TERMINAL import error, provider DISABLED for "
                f"this process — {msg[:200]}. All shots will skip to next "
                f"AI provider (pollinations/horde/hf)."
            )
            return None, seed
        if any(m in msg for m in terminal_markers):
            _LOCAL_SDXL_DEVICE_BROKEN[device_id] = msg[:200]
            log.warning(
                f"local_sdxl[cuda:{device_id}]: TERMINAL error, this GPU "
                f"DISABLED — {msg[:200]}. Sibling GPUs (if any) keep "
                f"serving; provider skips once every device is broken."
            )
        else:
            log.warning(f"local_sdxl[cuda:{device_id}] gen failed: {e}")
        return None, seed


# ── Local Flux 2 klein-4B (via diffusers) — free GPU-only backup ─────
# Runs on the Kaggle T4×2 accelerator via device_map='balanced' which
# splits the ~13 GB model (transformer + Qwen3-4B text encoder + VAE)
# across both cards. Kicks in when the Cloudflare klein-9b pool has
# been drained for the day — same Flux 2 quality tier, unlimited, free.
# Skipped automatically on single-GPU workers (Colab T4×1) and CPU
# workers (Oracle) because gpu_topology.flux2_supported is False there.
# Model download (~7.8 GB) happens in a background thread from the
# Kaggle notebook's cell 4.5, so the first render doesn't pay the cost.
_LOCAL_FLUX2_PIPES: dict = {}
_LOCAL_FLUX2_BROKEN = False
_LOCAL_FLUX2_BROKEN_REASON = ""
_LOCAL_FLUX2_DEVICE_BROKEN: dict = {}
# Shared load lock — unlike SDXL (per-device locks because we load ONE
# pipe per GPU independently), klein-4B uses device_map='balanced' which
# does its own multi-GPU splitting inside a single from_pretrained call.
# One lock is enough.
_LOCAL_FLUX2_LOAD_LOCK = _sdxl_threading.Lock()


def _local_flux2_klein_load(device_id: int | None = None):
    """Lazy-load Flux2KleinPipeline. Returns pipe on success, None on
    failure. On T4×2 the pipeline is split across BOTH devices via
    device_map='balanced'; device_id is used to key the cache but the
    actual placement is decided by accelerate.
    """
    global _LOCAL_FLUX2_BROKEN, _LOCAL_FLUX2_BROKEN_REASON

    if _LOCAL_FLUX2_BROKEN:
        return None

    # Fast path: cached pipe already loaded on this device (or the
    # "shared" -1 slot when device_map='balanced' spans multiple GPUs).
    cache_key = -1  # single balanced pipeline serves all shots
    pipe = _LOCAL_FLUX2_PIPES.get(cache_key)
    if pipe is not None:
        return pipe

    with _LOCAL_FLUX2_LOAD_LOCK:
        # Double-check inside the lock.
        pipe = _LOCAL_FLUX2_PIPES.get(cache_key)
        if pipe is not None:
            return pipe
        try:
            import torch
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"torch not importable: {e}"
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None
        if not torch.cuda.is_available():
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = "no CUDA device visible"
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None
        try:
            from modules import gpu_topology as _gt
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"gpu_topology import failed: {e}"
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None
        if not _gt.flux2_supported:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = (
                f"needs at least 2 sm_7+ GPUs (found {len(_gt.sdxl_ready_devices)})"
            )
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None

        try:
            from diffusers import Flux2KleinPipeline
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = (
                f"Flux2KleinPipeline not available in diffusers "
                f"(need >=0.36): {e}"
            )
            log.warning(
                f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}. "
                f"Kaggle notebook cell 2 must install diffusers>=0.36 + "
                f"transformers>=4.51."
            )
            return None

        model_id = os.getenv("LOCAL_FLUX2_KLEIN_MODEL", "") or ""
        if not model_id:
            try:
                model_id = str(
                    (load_settings().get("image_gen", {}) or {})
                    .get("local_flux2_klein_model", "")
                ).strip() or "black-forest-labs/FLUX.2-klein-4B"
            except Exception:
                model_id = "black-forest-labs/FLUX.2-klein-4B"

        # device_map='balanced' spreads transformer + text_encoder + VAE
        # across all visible GPUs based on parameter size. On T4×2 this
        # typically lands Qwen3 on one card and transformer+VAE on the
        # other. max_memory leaves ~2 GB per card as buffer for
        # activations + concurrent Kokoro co-tenancy.
        max_mem = {i: "14GB" for i in _gt.flux2_ready_devices}
        log.info(
            f"local_flux2_klein: loading {model_id} "
            f"(device_map=balanced, max_memory={max_mem}, "
            f"torch_dtype=fp16 for T4 sm_7.5)"
        )
        os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "360")
        try:
            pipe = Flux2KleinPipeline.from_pretrained(
                model_id,
                torch_dtype=torch.float16,
                device_map="balanced",
                max_memory=max_mem,
            )
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"from_pretrained failed: {e}"
            log.warning(
                f"local_flux2_klein: from_pretrained crashed — {e}. "
                f"Provider DISABLED for this worker's lifetime; "
                f"chain falls through to next provider."
            )
            return None

        # VAE fp32 upcast to prevent the same Turing (T4 sm_7.5) fp16
        # overflow that makes SDXL produce fully-black images. See the
        # SDXL VAE handling above for the empirical reference.
        try:
            pipe.vae = pipe.vae.to(torch.float32)
            log.info("local_flux2_klein: VAE upcast to fp32 (Turing fp16-overflow fix)")
        except Exception as _e:
            log.debug(f"local_flux2_klein: VAE upcast skipped: {_e}")

        _LOCAL_FLUX2_PIPES[cache_key] = pipe
        log.info(
            "local_flux2_klein: pipeline READY (device_map=balanced across "
            f"{_gt.flux2_ready_devices}; 4 steps CFG 1.0 per BFL guidance)"
        )
        return pipe


def _local_flux2_klein_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via Flux 2 klein-4B on the local GPU pair.
    Returns (path, seed) on success, (None, seed) on failure.

    Klein is a distilled model — steps=4 + guidance=1.0 is BFL's
    documented sweet spot. Extra steps HURT quality (per InferenceBench).
    No negative prompt (Flux family doesn't use them).
    """
    seed = int(hashlib.md5(f"{prompt}|{trial}|flux2klein".encode()).hexdigest()[:8], 16)
    pipe = _local_flux2_klein_load()
    if pipe is None:
        return None, seed
    try:
        import torch
        gen = torch.Generator(device="cuda").manual_seed(seed)
        # 1024×576 = 9:16 portrait, matches klein-9b on CF + editor's
        # target aspect for YouTube Shorts.
        #
        # Prompt distillation — same _distill_prompt_for_flux() used by
        # klein-9b on Cloudflare AND Pollinations/HF Flux paths. Klein-4B
        # is the exact same distilled Flux 2 model family as klein-9b —
        # both benefit from the same Qwen-encoder-friendly polish (natural
        # language sentences, no tag lists, capped length). This was
        # missed in the initial klein-4B provider ship; without it, klein-4B
        # on Kaggle got raw craft_image_prompt output while klein-9b on
        # Cloudflare got the polished version — noticeable quality gap.
        # Confirmed 2026-07-13. 600 char cap matches Pollinations Flux
        # path (klein-4B has similar context window to Pollinations Flux).
        distilled = _distill_prompt_for_flux(prompt)[:600]
        # num_inference_steps=5 (not the 4 BFL documents) — same fix as
        # SDXL-turbo above. Klein-4B's scheduler creates a sigmas array
        # of length steps+1. At steps=4 → length=5 → some code path in
        # the transformer inference tries to access sigmas[num_inference_steps]
        # = sigmas[5] and crashes with:
        #   "IndexError: index 5 is out of bounds for dimension 0 with size 5"
        # Bumping to 5 makes the array length 6 → index 5 valid → the
        # bug can't fire. +25% inference time (~2s/image on T4) is a fair
        # trade vs losing every retry to the crash. Confirmed live during
        # the 2026-07-13 verify-render session.
        kwargs = {
            "prompt": distilled,
            "num_inference_steps": 5,
            "guidance_scale": 1.0,
            "height": 1024,
            "width": 576,
            "generator": gen,
        }
        # Klein-4B's Flux 2 lineage does not use negative prompts — the
        # rectified-flow objective ignores them. We accept the kwarg for
        # signature parity with other providers but silently drop it.
        with torch.autocast(device_type="cuda", dtype=torch.float16):
            image = pipe(**kwargs).images[0]

        # Same degenerate-output check the SDXL provider uses. Turing
        # fp16 numerical instability can still occasionally slip past
        # the VAE fp32 cast and produce black/near-uniform images.
        try:
            import numpy as _np
            _arr = _np.asarray(image).astype(_np.float32)
            _std = float(_arr.std())
            _mean = float(_arr.mean())
            if _std < 8 or _mean < 6:
                log.warning(
                    f"local_flux2_klein: degenerate image "
                    f"(std={_std:.1f}, mean={_mean:.1f}) — treating as failure"
                )
                return None, seed
        except Exception:
            pass

        dest = os.path.join(output_dir, f"flux2klein_{seed:08x}.jpg")
        image.save(dest, "JPEG", quality=92)
        return dest, seed
    except Exception as e:
        msg = str(e)
        # Distinguish OOM (per-device kill) vs transient errors.
        if "out of memory" in msg.lower() or "OutOfMemoryError" in msg:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"OOM: {msg[:120]}"
            log.warning(
                f"local_flux2_klein: OOM during gen — provider DISABLED "
                f"for this worker's lifetime. Reduce shot_parallelism or "
                f"upgrade to a GPU tier with more VRAM."
            )
            try:
                import torch as _t
                _t.cuda.empty_cache()
            except Exception:
                pass
        else:
            log.warning(f"local_flux2_klein gen failed: {e}")
        return None, seed


# ── Agnes AI image provider (agnes-ai.com) ────────────────────────
# Free OpenAI-compatible multimodal API (Sapiens AI, Singapore).
# Per-channel: the render's AGNES_API_KEY is set by backend.channel_agnes
# from the channel's own key (agnes_source='own'). Empty key → provider
# skipped by _provider_ready. Generous free image quota (thousands/day),
# so it's a strong CF-pool-exhaustion fallback — but quality is
# inconsistent per reviews, so slot it BELOW the flux providers.
_AGNES_BASE = os.getenv("AGNES_API_BASE", "https://apihub.agnes-ai.com/v1")
_AGNES_IMAGE_MODEL = os.getenv("AGNES_IMAGE_MODEL", "agnes-image-2.1-flash")
_AGNES_COOLDOWN_UNTIL = 0.0   # set on 401/402/429 so we stop hammering


def _agnes_key() -> str:
    return (os.getenv("AGNES_API_KEY", "") or "").strip()


# ── Agnes AI VIDEO provider ───────────────────────────────────────
# Generates an actual moving clip per shot instead of a still image
# with a Ken Burns pan. Native output is 720x1280 — already the Shorts
# aspect ratio, so nothing is cropped or letterboxed.
#
# This is a DIFFERENT endpoint from the chat/image ones and is
# asynchronous: POST /v1/videos returns a task id, then you poll
# GET /v1/videos/<id> until status=completed and read metadata.url.
# Calling the video model through /chat/completions returns
# 403 "Model is blocked", which reads like an account restriction but
# only means the model is not served on that endpoint.
#
# Cost control: ~90 s per 5 s clip, so generating every shot this way
# would add 15-30 min to a render. AGNES_VIDEO_SHOTS caps how many
# shots get a real clip; the rest fall through to the image chain. The
# cap applies to the FIRST shots because Shorts retention is decided in
# the opening seconds — that is where motion earns the most.
_AGNES_VIDEO_MODEL = os.getenv("AGNES_VIDEO_MODEL", "agnes-video-v2.0")
_AGNES_VIDEO_POLL_SECONDS = int(os.getenv("AGNES_VIDEO_POLL_SECONDS", "180"))


def _archive_clips_enabled() -> bool:
    """Whether opening shots may fall back to Internet Archive footage.

    On by default: it costs no credentials and is bounded by the
    provider's own time budget. Set ARCHIVE_SHOT_CLIPS=0 to force the
    old stills-only behaviour.
    """
    return (os.getenv("ARCHIVE_SHOT_CLIPS", "1").strip().lower()
            not in ("0", "false", "no", "off"))


# The live endpoint enforces "2 requests per 1 minute" on video
# creation (measured: HTTP 429 rate_limit_exceeded). Pace ourselves to
# that rather than firing six shots and letting most of them bounce —
# a bounced create used to cost the shot its motion entirely.
_AGNES_VIDEO_RPM = int(os.getenv("AGNES_VIDEO_RPM", "2") or 2)
_AGNES_VIDEO_MAX_TRIES = int(os.getenv("AGNES_VIDEO_MAX_TRIES", "4") or 4)
_agnes_video_calls: list = []
_agnes_video_lock = _threading.Lock()


def _agnes_video_gate() -> None:
    """Block until another video create is allowed under the RPM cap.

    Shots are generated concurrently, so this has to be shared state
    behind a lock rather than a per-call sleep.
    """
    if _AGNES_VIDEO_RPM <= 0:
        return
    while True:
        with _agnes_video_lock:
            now = time.time()
            # Drop calls older than the window.
            while _agnes_video_calls and now - _agnes_video_calls[0] > 60.0:
                _agnes_video_calls.pop(0)
            if len(_agnes_video_calls) < _AGNES_VIDEO_RPM:
                _agnes_video_calls.append(now)
                return
            wait = 60.0 - (now - _agnes_video_calls[0]) + 0.5
        time.sleep(max(1.0, min(wait, 60.0)))


def _agnes_video_shots() -> int:
    """How many opening shots get a generated clip. 0 disables it.

    Read per call rather than cached at import so the dashboard setting
    takes effect on the next render without restarting a worker.
    Default 2: enough for the hook to move, cheap enough that it adds
    roughly three minutes rather than half an hour.
    """
    try:
        return max(0, min(10, int(os.getenv("AGNES_VIDEO_SHOTS", "2"))))
    except Exception:
        return 2


def _archive_clip_for_shot(shot: dict, output_dir: str, idx: int, used_ids: set):
    """Real public-domain motion footage for one shot, or None.

    The image chain produces stills that get pan/zoomed. That is what
    makes output read as auto-generated, and it is the complaint the
    Archive provider exists to answer: genuine moving footage, free,
    no credentials.

    Sits BELOW Agnes in the motion slot rather than replacing it.
    Agnes generates a clip matching the prompt exactly; the Archive can
    only return whatever real footage happens to exist, so it is the
    fallback — but it is the only motion source that works with no key
    at all, which is the current configuration.

    Never raises: a miss must fall through to a still, because a
    missing shot kills the render.
    """
    try:
        from modules.footage import fetch_archive_videos
    except Exception:
        return None
    # The visual prompt is written for an image model — long, full of
    # style adjectives ("cinematic, volumetric fog, 8k"). Archive search
    # matches titles, so feed it the subject only.
    # These are the keys the storyboard actually emits — see
    # find_image_for_shot, which reads the same ones. An earlier version
    # of this guessed at "query"/"visual"/"prompt"/"description", none of
    # which exist, so `raw` was always empty and the function returned
    # instantly for every shot. The render logged "no motion source" with
    # no error, because returning None IS the documented miss path.
    #
    # search_query first: it is already a short stock-search phrase,
    # which is exactly what an archive title index wants.
    # visual_description and ai_prompt are written for a diffusion model
    # and need the stopword pass below to be usable.
    raw = (shot.get("search_query") or shot.get("visual_description")
           or shot.get("ai_prompt") or "")
    if not raw:
        log.info(f"archive-clip: shot {idx} has no usable query keys ({sorted(shot)[:6]})")
        return None
    # Imported locally: this module has no module-level `re`, only
    # function-local ones (see line ~580). A module-level re.findall
    # here would NameError on every call.
    import re as _re
    words = [w for w in _re.findall(r"[A-Za-z]{3,}", str(raw))
             if w.lower() not in _ARCHIVE_STOPWORDS]
    if not words:
        return None

    # Progressive narrowing. Archive search ORs its terms and ranks by
    # downloads, so every extra word reshuffles the results: "abandoned
    # house" returns a matching clip, while "abandoned house fog"
    # returns nothing because the good hit drops past the provider's
    # probe cap. Try the fuller query first for precision, then fall
    # back to the two-word core rather than giving up.
    tried = []
    for n in (3, 2):
        query = " ".join(words[:n]).strip()
        if not query or query in tried:
            continue
        tried.append(query)
        try:
            got = fetch_archive_videos(query, output_dir, count=1, used_ids=used_ids)
        except Exception as e:
            log.info(f"archive-clip: shot {idx} lookup failed: {e}")
            return None
        if got:
            log.info(f"archive-clip: shot {idx} matched on {query!r}")
            return {"type": "video", "path": got[0],
                    "origin": "archive-video", "score": 6}
    return None


# Style vocabulary that image prompts are full of and that means
# nothing to a footage archive's title index.
_ARCHIVE_STOPWORDS = {
    "cinematic", "photorealistic", "realistic", "detailed", "highly", "ultra",
    "volumetric", "dramatic", "moody", "atmospheric", "eerie", "ominous",
    "shot", "photo", "photograph", "image", "view", "scene", "style",
    "lighting", "light", "dark", "colour", "color", "grain", "film",
    "wide", "close", "closeup", "angle", "lens", "depth", "field", "bokeh",
    "the", "and", "with", "from", "that", "this", "into", "over", "under",
    "digital", "art", "render", "rendering", "quality", "masterpiece",
}


def _agnes_video_generate(prompt: str, output_dir: str, idx: int, seconds: float = 5.0,
                          init_image_url: str = ""):
    """Generate one clip. Returns a shot-source dict or None.

    Never raises: a video miss must fall through to the image chain
    rather than fail the shot, since a missing shot kills the render.
    """
    import requests as _rq
    key = _agnes_key()
    if not key:
        return None
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        # Parameters per the Agnes Video V2.0 reference:
        #   wiki.agnes-ai.com/en/docs/agnes-video-v20.md
        #
        # width/height are what select the aspect ratio — there is no
        # aspect_ratio/size/ratio parameter, and passing one is accepted
        # with HTTP 200 and silently ignored. Omitting width/height
        # entirely gives the 1152x768 LANDSCAPE default, which is wrong
        # for Shorts. The service normalises whatever it is given to the
        # nearest preset tier (720x1280 comes back as 704x1280).
        #
        # Duration is num_frames / frame_rate, and num_frames MUST
        # satisfy 8n+1 (max 441). 24fps rather than 16: the docs' own
        # duration table is built on 24, and 16fps reads as judder on a
        # slow push-in, which is most of what we ask for.
        _secs = max(2.0, min(float(seconds or 5.0), 10.0))
        # Snap UP to the next legal 8n+1, never down: a clip shorter than
        # its shot leaves a gap the editor has to fill by freezing or
        # stretching. Rounding up reproduces the reference table exactly
        # (5s -> 121 frames, 10s -> 241).
        _frames = int(round(_secs * 24))
        _frames = max(9, min(441, ((_frames - 1 + 7) // 8) * 8 + 1))
        # Direction, not just description.
        #
        # The prompt handed in here is the DIFFUSION prompt — it
        # describes a scene, not a shot. A video model given no camera
        # or action instruction produces a near-static frame with drifting
        # detail, which reads as "artifacting" and "movement not on
        # point" because nothing is deliberately moving.
        #
        # One camera move plus one physical action gives the model
        # something coherent to animate, so its motion budget goes into
        # intended movement instead of hallucinated wobble.
        _moves = ("slow dolly-in", "slow push-in", "gentle handheld drift",
                  "slow tilt up", "steady tracking shot")
        _directed = (
            f"{prompt[:900]}. "
            f"Cinematography: {_moves[idx % len(_moves)]}, "
            f"single continuous take, stable framing, natural motion, "
            f"consistent lighting throughout the shot."
        )
        body = {
            "model": _AGNES_VIDEO_MODEL,
            "prompt": _directed[:1200],
            # 1080x1920, not 720x1280. The model normalises to 480p/720p/
            # 1080p tiers (wiki.agnes-ai.com/en/docs/agnes-video-v20.md),
            # so asking for 720p meant every clip was then scaled UP 1.5x
            # to the 1080x1920 output — softening detail and smearing
            # exactly the fine texture that reads as "artifacting". The
            # 1080p tier is available; generate at output resolution and
            # the upscale disappears.
            "width": int(os.getenv("AGNES_VIDEO_W", "1080")),
            "height": int(os.getenv("AGNES_VIDEO_H", "1920")),
            "num_frames": _frames, "frame_rate": 24,
            # Documented and never sent. This is the standard lever for
            # artifact reduction — more denoising steps mean fewer of
            # the warped hands, smeared faces and boiling textures that
            # show up on a default-step generation.
            "num_inference_steps": int(os.getenv("AGNES_VIDEO_STEPS", "40")),
            "negative_prompt": (
                "blurry, low quality, distorted, deformed, warped face, "
                "extra limbs, extra fingers, melting features, flickering, "
                "morphing, jitter, ghosting, duplicated subject, "
                "watermark, text, subtitles, letterboxing, static, still image"
            ),
        }
        # Image-to-video when we already have a still for this shot.
        # Animating our own 9:16 frame beats text-to-video on both
        # fidelity and consistency: the composition is already the one
        # the shot called for, so the model interpolates motion instead
        # of reinventing the scene.
        if init_image_url:
            # Accepts a public URL or a base64 data URI — both verified
            # against the live endpoint before relying on it, so a local
            # portrait needs no upload anywhere.
            body["image"] = init_image_url
            log.info(f"agnes-video: shot {idx} driven by a character reference")
        # Retry the two errors the live endpoint actually returns under
        # load. Measured against it directly:
        #
        #   429 {"code":"rate_limit_exceeded"} — "allows 2 requests per
        #       1 minute(s)". Six shots means we WILL hit this.
        #   503 {"code":"video_queue_full"}    — their queue is busy.
        #
        # Both are transient and explicitly retryable, and the previous
        # code treated every >=400 as fatal and returned None. The caller
        # reads None as "no motion available" and quietly substitutes a
        # still, so a momentary rate limit permanently downgraded that
        # shot. That is the likeliest reason motion looked inconsistent
        # across a video and across niches — nothing errored, shots just
        # went missing.
        _RETRYABLE = (408, 409, 425, 429, 500, 502, 503, 504)
        r = None
        for _attempt in range(_AGNES_VIDEO_MAX_TRIES):
            _agnes_video_gate()          # client-side 2/min limiter
            r = _rq.post(f"{_AGNES_BASE}/videos", headers=headers, timeout=60, json=body)
            if r.status_code < 400:
                break
            if r.status_code not in _RETRYABLE or _attempt == _AGNES_VIDEO_MAX_TRIES - 1:
                log.warning(f"agnes-video: create failed HTTP {r.status_code}: {r.text[:160]}")
                return None
            # Honour Retry-After when present, else back off. The window
            # is a minute, so waiting out a rate limit is cheap next to
            # losing the shot.
            try:
                _wait = float(r.headers.get("Retry-After") or 0)
            except Exception:
                _wait = 0
            _wait = _wait or min(90.0, 20.0 * (_attempt + 1))
            log.info(f"agnes-video: shot {idx} got HTTP {r.status_code} "
                     f"({(r.text or '')[:60]}) — retrying in {_wait:.0f}s "
                     f"[{_attempt + 1}/{_AGNES_VIDEO_MAX_TRIES}]")
            time.sleep(_wait)
        task_id = (r.json() or {}).get("task_id") or (r.json() or {}).get("id")
        if not task_id:
            log.warning("agnes-video: no task id in create response")
            return None
    except Exception as e:
        log.warning(f"agnes-video: create error: {e}")
        return None

    deadline = time.time() + _AGNES_VIDEO_POLL_SECONDS
    url = ""
    while time.time() < deadline:
        time.sleep(10)
        try:
            p = _rq.get(f"{_AGNES_BASE}/videos/{task_id}", headers=headers, timeout=30)
            d = p.json() if p.status_code < 400 else {}
        except Exception:
            continue
        status = str(d.get("status") or "")
        if status in ("completed", "succeeded", "success", "finished"):
            url = str((d.get("metadata") or {}).get("url") or "")
            break
        if status in ("failed", "error"):
            log.warning(f"agnes-video: task {task_id} reported {status}")
            return None
    if not url:
        log.warning(f"agnes-video: task {task_id} did not finish within "
                    f"{_AGNES_VIDEO_POLL_SECONDS}s — falling back to a still")
        return None

    dest = os.path.join(output_dir, f"agnes_video_{idx:02d}.mp4")
    try:
        with _rq.get(url, stream=True, timeout=120) as vr:
            vr.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in vr.iter_content(1 << 16):
                    if chunk:
                        f.write(chunk)
    except Exception as e:
        log.warning(f"agnes-video: download failed: {e}")
        return None

    # An HTML error page saved as .mp4 would sail through the editor and
    # produce a broken segment, so verify the container before trusting it.
    try:
        with open(dest, "rb") as f:
            if f.read(12)[4:8] != b"ftyp":
                log.warning("agnes-video: downloaded file is not an mp4")
                os.remove(dest)
                return None
    except Exception:
        return None

    log.info(f"agnes-video: shot {idx} -> {os.path.getsize(dest)//1024} KB clip")
    return {"type": "video", "path": dest, "origin": "agnes-video", "score": 8}


# ── character anchors ────────────────────────────────────────
# First generated image per character, reused as an image-to-image
# reference for every later shot featuring them. Cleared at the start
# of each render so one video's cast can never leak into the next.
#
# Keyed by the cast name the storyboard assigned. Thread-safe because
# shots are fetched in a pool and two shots with the same character can
# finish out of order — whoever lands first becomes the anchor.
_CAST_ANCHORS: dict[str, str] = {}
_CAST_ANCHOR_LOCK = __import__("threading").Lock()


def build_cast_sheet(shots, output_dir) -> int:
    """Generate one reference portrait per recurring character.

    Anchoring on "whatever shot 1 produced" is weak: the opening shot is
    usually a wide establishing frame where the character is small,
    backlit or facing away, which is a poor thing to match a face
    against. A purpose-built portrait — frontal, evenly lit, plain
    background — gives every later shot a clean likeness to lock onto.

    It also decouples the anchor from shot order, so re-rolling shot 1
    can no longer change what the whole cast looks like.

    Costs one image per character. Returns how many were built.
    """
    if not _agnes_key():
        return 0
    looks: dict[str, str] = {}
    for sh in (shots or []):
        for nm in (sh.get("cast_names") or []):
            if nm in looks:
                continue
            # The storyboard appends "Character reference — Name: look"
            # to ai_prompt; recover this character's clause from it.
            _ap = str(sh.get("ai_prompt") or "")
            _marker = f"{nm}:"
            if _marker in _ap:
                seg = _ap.split(_marker, 1)[1]
                looks[nm] = seg.split(";")[0].strip(" .")[:300]
    built = 0
    for nm, look in list(looks.items())[:3]:      # 3 portraits is plenty for a Short
        if not look:
            continue
        prompt = (
            f"Head and shoulders portrait photograph of {look}. "
            "Facing camera, neutral expression, even soft lighting, "
            "plain neutral background, sharp focus, photorealistic."
        )
        try:
            path, _seed = _agnes_generate(prompt, output_dir, trial=0)
        except Exception as e:
            log.warning(f"cast-sheet: {nm} failed: {e}")
            continue
        if path:
            _cast_anchor_put([nm], path)
            built += 1
            log.info(f"cast-sheet: built reference portrait for {nm}")
    return built


def reset_cast_anchors() -> None:
    with _CAST_ANCHOR_LOCK:
        _CAST_ANCHORS.clear()


def _cast_anchor_get(names) -> str:
    with _CAST_ANCHOR_LOCK:
        for n in (names or []):
            p = _CAST_ANCHORS.get(n)
            if p and os.path.exists(p):
                return p
    return ""


def _cast_anchor_put(names, path: str) -> None:
    if not path or not os.path.exists(path):
        return
    with _CAST_ANCHOR_LOCK:
        for n in (names or []):
            _CAST_ANCHORS.setdefault(n, path)


def _agnes_generate(prompt, output_dir, trial, negative_prompt="", ref_image_path=""):
    """Generate one image via Agnes AI. Returns (path, seed) on success,
    (None, seed) on any failure. OpenAI-images-style endpoint:
      POST {base}/v1/images/generations
      body: {model, prompt, size, extra_body:{response_format:"url"}}
      resp: {data:[{url}]}  → we download the PNG and re-save as JPG.
    """
    global _AGNES_COOLDOWN_UNTIL
    seed = int(hashlib.md5(f"{prompt}|{trial}|agnes".encode()).hexdigest()[:8], 16)
    key = _agnes_key()
    if not key:
        return None, seed
    if time.time() < _AGNES_COOLDOWN_UNTIL:
        return None, seed

    # Agnes runs a Gemini-Flash-class image model — natural-language
    # prompts work best (same as Flux). Reuse the flux distiller.
    final_prompt = _distill_prompt_for_flux(prompt)[:700]
    body = {
        "model": _AGNES_IMAGE_MODEL,
        "prompt": final_prompt,
        # `size` is a quality tier (1K/2K/3K/4K) and `ratio` picks the
        # aspect — per the model reference. We previously sent an exact
        # "576x1024", which the service accepted as a legacy value and
        # normalised anyway; asking for 2K/9:16 gets a bigger source
        # frame, so the editor's crop to 1080x1920 upscales less.
        "size": os.getenv("AGNES_IMAGE_SIZE", "2K"),
        "ratio": "9:16",
        "extra_body": {"response_format": "url"},
    }
    # Character reference. The cast description alone keeps a face
    # roughly on-model for a video clip but visibly drifts between
    # separate stills, because two different prompts produce two
    # different people no matter how the person is described.
    #
    # image-to-image fixes that properly: the FIRST shot featuring a
    # character becomes the anchor, and every later shot with that
    # character is generated with the anchor attached, so the model
    # matches a face it can see instead of one it has to imagine.
    #
    # Sent as a base64 data URI, which the reference explicitly allows
    # alongside public URLs — that removes the need to upload each
    # still somewhere public first.
    if ref_image_path and os.path.exists(ref_image_path):
        try:
            import base64 as _b64
            with open(ref_image_path, "rb") as _f:
                _enc = _b64.b64encode(_f.read()).decode("ascii")
            body["extra_body"]["image"] = [f"data:image/jpeg;base64,{_enc}"]
            body["prompt"] = (
                f"{final_prompt}. Keep the person's face, hair and clothing "
                f"identical to the reference image; change only the scene."
            )[:900]
            log.info("agnes: generating with a character reference")
        except Exception as _e:
            log.warning(f"agnes: could not attach character reference: {_e}")
    dest = os.path.join(output_dir, f"agnes_{seed:08x}.jpg")
    try:
        r = requests.post(
            f"{_AGNES_BASE}/images/generations",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            json=body, timeout=120,
        )
        if r.status_code in (401, 402, 403, 429):
            # Auth/quota problem — cool down 10 min so we don't burn the
            # per-shot attempt budget re-hitting a dead/exhausted key.
            _AGNES_COOLDOWN_UNTIL = time.time() + 600
            log.warning(f"agnes: HTTP {r.status_code} — cooling provider 10 min")
            return None, seed
        r.raise_for_status()
        data = (r.json() or {}).get("data") or []
        if not data:
            return None, seed
        img_url = str(data[0].get("url") or "").strip()
        if not img_url:
            # Fall back to b64 if the account is configured for it.
            b64 = data[0].get("b64_json")
            if b64:
                import base64 as _b64
                with open(dest, "wb") as f:
                    f.write(_b64.b64decode(b64))
                return (dest, seed) if _agnes_ok(dest) else (None, seed)
            return None, seed
        # Download the URL.
        ir = requests.get(img_url, stream=True, timeout=120)
        ir.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in ir.iter_content(chunk_size=8192):
                f.write(chunk)
        return (dest, seed) if _agnes_ok(dest) else (None, seed)
    except Exception as e:
        log.warning(f"agnes gen failed: {e}")
        return None, seed


def _agnes_ok(path: str) -> bool:
    """Reject truncated/degenerate downloads (same guard SDXL uses)."""
    try:
        if not os.path.exists(path) or os.path.getsize(path) < 4096:
            return False
        from PIL import Image as _Img
        import numpy as _np
        with _Img.open(path) as im:
            im = im.convert("RGB")
            arr = _np.asarray(im).astype(_np.float32)
        if float(arr.std()) < 6 or float(arr.mean()) < 4:
            log.warning("agnes: degenerate image (near-uniform) — treating as failure")
            return False
        # Normalise to JPG so the editor pipeline (which globs *.jpg for
        # some paths) + storage stay consistent with other providers.
        # We're always downloading raw response bytes into a `.jpg`-
        # named file — those bytes may actually be PNG/WebP. Re-open
        # + save as JPEG to make the file's contents match its
        # extension. 2026-07-21: this branch previously had `if not
        # path.lower().endswith(".jpg"): return True` which was
        # inverted (it skipped the re-encode for non-jpg paths, when
        # non-jpg paths are exactly the ones that NEED it). Today
        # dest is always .jpg so the bug was latent; fixing so the
        # intent matches the behaviour.
        if path.lower().endswith(".jpg"):
            with _Img.open(path) as im:
                im.convert("RGB").save(path, "JPEG", quality=92)
        return True
    except Exception:
        # If PIL isn't available or the check errored, accept the file
        # as long as it's non-trivial in size (belt-and-braces).
        try:
            return os.path.exists(path) and os.path.getsize(path) >= 4096
        except Exception:
            return False


def _score_local_image(path, visual, premise):
    """Vision-score a LOCAL image file by passing it as a data URL."""
    try:
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return nim.vision_score(
            f"data:image/jpeg;base64,{b64}",
            fit_description=visual, premise=premise,
        )
    except Exception as e:
        log.warning(f"score_local_image error: {e}")
        return -1


# ── Per-shot finder ──────────────────────────────────────────

def find_image_for_shot(shot, output_dir, used_ids, channel="horror",
                        tone_override: str = "", language: str = ""):
    # Cancel check at entry — a user clicking Cancel between shots
    # shouldn't have to wait for the current shot to fully resolve
    # before the pipeline unwinds.
    from modules import run_state as _rs
    _rs.check_cancel()

    vid_cfg = load_settings().get("video", {})
    providers = load_settings().get("providers", {}) or {}
    threshold = int(vid_cfg.get("vision_judge_threshold", 4))
    judge_on = bool(vid_cfg.get("vision_judge_enabled", True)) and nim.is_available()

    # Anchor for any character already drawn in an earlier shot. Empty
    # on the first appearance, which is what makes that shot the anchor.
    _cast_ref = _cast_anchor_get(shot.get("cast_names") or [])

    visual = shot.get("visual_description") or shot.get("search_query") or ""
    query = shot.get("search_query") or ""
    ai_prompt = shot.get("ai_prompt") or visual
    premise = shot.get("narration_excerpt") or ""
    # Per-shot era anchor (backfilled from story_period in storyboard.py
    # if the model forgot). Empty string is fine — the prompt template
    # skips the period line when missing.
    period = str(shot.get("period") or "").strip()

    # Very defensive clamp — only if the query is absurdly long. The
    # LLM's own query is left alone otherwise; the earlier 6-word cap
    # was truncating good 7-8 word queries and hurting match quality.
    # If stock returns nothing on the original, the generic fallback
    # below still fires as a safety net.
    def _shorten(q: str, max_words: int) -> str:
        words = [w for w in q.split() if w]
        return " ".join(words[:max_words])
    if query and len(query.split()) > 12:
        log.info(f"Shot fetch: query >12 words, clamping to 10")
        query = _shorten(query, 10)

    # Generic backup query built from visual_description keywords. Used
    # by providers that return zero candidates for the specific query.
    _stop = {"the","a","an","and","or","of","for","with","from","in","on",
             "at","to","by","is","are","was","were","be","been","that",
             "this","which","who","what","how","its","it","as","into"}
    _visual_words = [
        w.strip(".,;:'\"()") for w in (visual or "").lower().split()
        if w.strip(".,;:'\"()") and w.lower().strip(".,;:'\"()") not in _stop
        and not w[0].isdigit()
    ]
    query_generic = " ".join(_visual_words[:3]) if _visual_words else query

    log.info(f"Shot fetch | query={query!r} | generic_fallback={query_generic!r} | excerpt={premise[:60]!r}")

    best = None  # (score, source_dict_or_lazy)

    def consider(score, src_or_lazy):
        nonlocal best
        if best is None or score > best[0]:
            best = (score, src_or_lazy)

    # ── 1. Shutterstock ──
    if providers.get("shutterstock", True) and query:
        previews = _ss_search_previews(query, count=8, exclude_ids=used_ids)
        if previews and judge_on:
            scored = []
            for iid, url, _ in previews[:6]:
                s = nim.vision_score(url, fit_description=visual, premise=premise)
                if s >= 0:
                    scored.append((s, iid))
            scored.sort(reverse=True, key=lambda x: x[0])
            if scored:
                top_s, top_id = scored[0]
                log.info(f"  Shutterstock top: {top_s}/10 (id {top_id})")
                if top_s >= threshold:
                    path = _ss_license_download(top_id, output_dir)
                    if path:
                        used_ids.add(f"shutterstock:{top_id}")
                        F._remember_clip(f"shutterstock:{top_id}")
                        return {"type": "image", "path": path,
                                "origin": "shutterstock", "score": top_s}
                else:
                    consider(top_s, ("shutterstock-lazy", top_id))
        elif previews:
            iid = previews[0][0]
            path = _ss_license_download(iid, output_dir)
            if path:
                used_ids.add(f"shutterstock:{iid}")
                F._remember_clip(f"shutterstock:{iid}")
                return {"type": "image", "path": path,
                        "origin": "shutterstock", "score": -1}

    # ── 2. Pexels ──
    if providers.get("pexels", True) and query:
        previews = _pexels_search_previews(query, count=8, exclude_ids=used_ids)
        if previews and judge_on:
            scored = []
            for pid, preview, full in previews[:6]:
                s = nim.vision_score(preview, fit_description=visual, premise=premise)
                if s >= 0:
                    scored.append((s, pid, full))
            scored.sort(reverse=True, key=lambda x: x[0])
            if scored:
                top_s, top_id, full = scored[0]
                log.info(f"  Pexels top: {top_s}/10 (id {top_id})")
                if top_s >= threshold:
                    path = _pexels_download_full(top_id, full, output_dir)
                    if path:
                        used_ids.add(f"pexels_img:{top_id}")
                        F._remember_clip(f"pexels_img:{top_id}")
                        return {"type": "image", "path": path,
                                "origin": "pexels_img", "score": top_s}
                else:
                    consider(top_s, ("pexels-lazy", top_id, full))
        elif previews:
            pid, _, full = previews[0]
            path = _pexels_download_full(pid, full, output_dir)
            if path:
                used_ids.add(f"pexels_img:{pid}")
                F._remember_clip(f"pexels_img:{pid}")
                return {"type": "image", "path": path,
                        "origin": "pexels_img", "score": -1}

    # ── 3. AI image generation — priority-ordered, settings-driven ──
    # The user configures priority + toggles in settings.image_gen.
    # We walk providers in the declared order; each provider gets its
    # own ai_image_attempts_per_shot budget and returns on first
    # threshold-passing image. A disabled or key-less provider is
    # skipped with a log line so it's obvious in the output.
    ai_attempts = int(vid_cfg.get("ai_image_attempts_per_shot", 3))
    # If stock (Shutterstock + Pexels) returned literally nothing, this
    # shot has no fallback to below-threshold stock — every failed AI
    # attempt is a dropped shot. Bump the AI budget to 5 in that case
    # + drop the vision-judge threshold to 1 so an on-topic AI image
    # isn't rejected for being "not amazing enough". This turns 'niche
    # science shots' from '0-1 clips out of 15' into 'most shots
    # filled with an on-topic Flux/HF image'.
    stock_yielded_nothing = best is None
    if stock_yielded_nothing:
        ai_attempts = max(ai_attempts, 5)
        # Aggressively relax vision judging on the AI-fallback path.
        # Even threshold=1 was rejecting every SDXL generation live —
        # the judge scores 0/10 constantly (payload too big for NIM
        # vision, or fallback lands on a text-only model, or the
        # rubric is calibrated for stock photos not SDXL-turbo output).
        # Setting threshold to -1 accepts ANY image the provider
        # produced INCLUDING parse-failures — better a mediocre AI
        # shot than a dropped shot that dies the render. Confirmed
        # live 2026-07-09: SDXL was generating perfectly fine images
        # that the judge was rejecting for 30+ min per shot.
        threshold = -1
        log.info(
            f"  stock returned no candidates; boosting AI budget to "
            f"{ai_attempts} attempts + DISABLING vision-judge rejection "
            f"(threshold=-1) so first successful gen wins the shot"
        )
    ig_cfg = (load_settings().get("image_gen") or {})
    priority = ig_cfg.get("priority") or [
        "cloudflare", "local_flux2_klein", "agnes", "pollinations",
        "horde", "local_sdxl", "huggingface",
    ]
    ig_enabled = ig_cfg.get("enabled") or {}
    negative_prompt = str(ig_cfg.get("negative_prompt") or "").strip()

    def _provider_ready(name: str) -> tuple[bool, str]:
        """Return (ready, reason-if-not). Combines user toggle + key/GPU check."""
        # Master enable in settings.image_gen.enabled AND the legacy
        # providers.<name> toggle both count as "off". Either off → skip.
        if ig_enabled.get(name, True) is False:
            return False, "disabled in settings"
        if providers.get(name, True) is False:
            return False, "disabled in providers toggle"
        if name == "huggingface":
            if not os.getenv("HF_TOKEN", "").strip():
                return False, "no HF_TOKEN"
        if name == "cloudflare":
            # New: pool-aware readiness. The pool synthesises a single
            # entry from CLOUDFLARE_ACCOUNT_ID/_API_TOKEN when
            # CLOUDFLARE_ACCOUNTS_JSON is empty, so this check still
            # catches the "no CF creds at all" case + covers the new
            # multi-account path.
            _pool = _cf_account_pool()
            if not _pool:
                return False, "no CLOUDFLARE_ACCOUNTS_JSON / CLOUDFLARE_ACCOUNT_ID+TOKEN"
            # Every account in the pool marked burned for today? Skip
            # the tier — there's no point crafting prompts we can't
            # send. Auto-clears at 00:00 UTC.
            _today = _cf_today_key()
            _viable = [a for a in _pool if _CF_BURNED_TODAY.get(a["account_id"]) != _today]
            if not _viable:
                return False, f"all {len(_pool)} pool accounts exhausted for today"
            # Daily soft-cap on the CURRENT single-account counter is
            # kept for backwards compat with single-account setups. In
            # multi-account mode the per-account counter only tracks
            # the first-picked account until it burns and we rotate,
            # so this check is more of a guardrail than a hard cap.
            _used = _cf_quota_read()
            if _used >= _CF_DAILY_CAP and len(_viable) == 1:
                return False, f"daily soft-cap reached ({_used}/{_CF_DAILY_CAP})"
            # If the CF breaker tripped earlier in this render, skip
            # the WHOLE tier rather than paying 5× the "craft prompt →
            # POST → 429" round-trip.
            if _cf_breaker_skip():
                wait = int(_CF_OPEN_UNTIL - time.time())
                return False, f"breaker open ({wait}s remaining)"
        if name == "local_sdxl":
            if _LOCAL_SDXL_BROKEN:
                return False, f"local pipeline broken ({_LOCAL_SDXL_BROKEN_REASON})"
            # If every visible device has been marked broken, the
            # provider has nothing left to serve — skip to the next AI
            # provider instead of racking up per-shot failures.
            try:
                from modules import gpu_topology as _gt
                if _gt.sdxl_ready_devices and all(
                    d in _LOCAL_SDXL_DEVICE_BROKEN for d in _gt.sdxl_ready_devices
                ):
                    return False, "every GPU marked broken during load/gen"
            except Exception:
                pass
        if name == "local_flux2_klein":
            if _LOCAL_FLUX2_BROKEN:
                return False, f"local flux2 pipeline broken ({_LOCAL_FLUX2_BROKEN_REASON})"
            # Klein-4B needs the T4×2 split (device_map='balanced' can't
            # do its job on a single GPU that lacks room for both the
            # transformer and the Qwen3 text encoder). Colab (T4×1) and
            # Oracle (CPU-only) auto-skip here without even attempting
            # the model download.
            try:
                from modules import gpu_topology as _gt
                if not _gt.flux2_supported:
                    return False, (
                        f"needs >=2 GPUs, have {len(_gt.sdxl_ready_devices)} "
                        f"(Kaggle T4×2 only — Colab/Oracle skip)"
                    )
            except Exception:
                pass
        if name == "agnes":
            if not _agnes_key():
                return False, "no AGNES_API_KEY (channel agnes_source=off or no key)"
            if time.time() < _AGNES_COOLDOWN_UNTIL:
                wait = int(_AGNES_COOLDOWN_UNTIL - time.time())
                return False, f"cooling after auth/quota error ({wait}s remaining)"
        if name == "pollinations":
            if _pollinations_breaker_skip():
                wait = int(_POLL_OPEN_UNTIL - time.time())
                return False, f"breaker open ({wait}s remaining)"
        if name == "huggingface":
            try:
                if _huggingface_breaker_skip():
                    wait = int(_HF_OPEN_UNTIL - time.time())
                    return False, f"breaker open ({wait}s remaining)"
            except NameError:
                pass
        # 'horde' + 'together' have no required key (horde works anon).
        return True, ""

    _AI_PROVIDERS = {
        "cloudflare":         _cloudflare_generate,   # Flux 2 dev via Workers AI, ~150/day free
        "local_flux2_klein":  _local_flux2_klein_generate,  # Kaggle T4×2 only
        "agnes":              _agnes_generate,        # Agnes AI, per-channel key, big free quota
        "horde":              _horde_generate,        # real SDXL crowdsourced, works anon
        "huggingface":        _huggingface_generate,
        "local_sdxl":         _local_sdxl_generate,
        "pollinations":       _pollinations_generate,
    }

    for slot, provider_name in enumerate(priority):
        fn = _AI_PROVIDERS.get(provider_name)
        if fn is None:
            log.info(f"  [ai-{slot+1}] unknown provider {provider_name!r} — skipping")
            continue
        ready, reason = _provider_ready(provider_name)
        if not ready:
            # Log the full reason ONCE per provider per worker lifetime.
            # Subsequent skips (which happen on every shot of every render
            # if the provider is disabled) log a terse breadcrumb pointing
            # to the earlier detail. Before this the 200-char skip
            # message spammed the log ~200×/render on any worker where
            # klein-4B, SDXL, or an experimental provider was
            # unavailable.
            if provider_name not in _SKIP_REASON_LOGGED:
                _SKIP_REASON_LOGGED.add(provider_name)
                log.info(f"  [ai-{slot+1}] {provider_name}: skipped ({reason})")
            else:
                log.info(f"  [ai-{slot+1}] {provider_name}: skipped (see earlier log)")
            continue
        log.info(f"  [ai-{slot+1}] {provider_name}: trying ({ai_attempts} attempts)")
        for trial in range(ai_attempts):
            _rs.check_cancel()
            crafted = craft_image_prompt(
                narration_excerpt=premise,
                visual_description=visual,
                channel=channel,
                # Offset per provider so each gets a distinct seed pool.
                attempt=trial + (slot * 100),
                period=period,
                tone_override=tone_override,
                language=language,
            )
            prompt_to_use = crafted or ai_prompt
            log.info(f"    {provider_name} prompt (try {trial+1}): {(crafted or ai_prompt)[:90]}...")
            # Character anchor: only Agnes supports image-to-image, so
            # only it takes the reference. Everything else keeps the
            # signature it always had.
            if provider_name == "agnes" and _cast_ref:
                path, seed = fn(prompt_to_use, output_dir, trial,
                                negative_prompt, ref_image_path=_cast_ref)
            else:
                path, seed = fn(prompt_to_use, output_dir, trial, negative_prompt)
            if not path:
                continue
            # First image of a character becomes its anchor. setdefault
            # inside the store means a later shot never overwrites it,
            # so every appearance references the same frame rather than
            # drifting one hop at a time.
            if provider_name == "agnes" and not _cast_ref:
                _cast_anchor_put(shot.get("cast_names") or [], path)
            tag = f"{provider_name}:{seed}"
            if judge_on and threshold >= 0:
                # Only pay the vision-judge round-trip when threshold
                # is real (>=0). On the AI-fallback path we set
                # threshold=-1 above and take the first successful gen
                # without judging — the judge burns 30-90s per call and
                # was rejecting every SDXL image with score=0 live.
                s = _score_local_image(path, visual, premise)
                log.info(f"    {provider_name}: {s}/10 (seed {seed})")
                if s >= threshold:
                    used_ids.add(tag)
                    F._remember_clip(tag)
                    return {"type": "image", "path": path,
                            "origin": provider_name, "score": s}
                if s > 0:
                    consider(s, {"type": "image", "path": path,
                                 "origin": provider_name, "score": s})
            else:
                used_ids.add(tag)
                F._remember_clip(tag)
                return {"type": "image", "path": path,
                        "origin": provider_name, "score": -1}

    # ── 4. Last-resort: license the best below-threshold candidate ──
    if best is not None:
        score, payload = best
        if isinstance(payload, tuple):
            kind = payload[0]
            if kind == "shutterstock-lazy":
                _, top_id = payload
                path = _ss_license_download(top_id, output_dir)
                if path:
                    log.info(f"  Fallback Shutterstock id {top_id} (below threshold, score {score}/10)")
                    used_ids.add(f"shutterstock:{top_id}")
                    F._remember_clip(f"shutterstock:{top_id}")
                    return {"type": "image", "path": path,
                            "origin": "shutterstock", "score": score}
            elif kind == "pexels-lazy":
                _, top_id, full = payload
                path = _pexels_download_full(top_id, full, output_dir)
                if path:
                    log.info(f"  Fallback Pexels id {top_id} (below threshold, score {score}/10)")
                    used_ids.add(f"pexels_img:{top_id}")
                    F._remember_clip(f"pexels_img:{top_id}")
                    return {"type": "image", "path": path,
                            "origin": "pexels_img", "score": score}
        else:
            return payload  # already-completed Pollinations dict

    # LAST-DITCH: try again with a channel-generic query drawn from the
    # channel's own footage_keywords in CHANNEL_PRESETS. This kicks in
    # when every previous branch produced nothing — usually because the
    # LLM's search_query was too niche for stock providers AND the AI
    # providers all rate-limited or errored on this shot. Better to fill
    # the shot with an on-genre stock image than drop the shot entirely
    # (dropped shots are what turned a 10-shot storyboard into 1-2 clips).
    try:
        from modules import channels as _ch
        preset = _ch.CHANNEL_PRESETS.get(channel) or {}
        keywords = preset.get("footage_keywords") or []
    except Exception:
        keywords = []
    # Also add the shortened visual-description generic as an option.
    fallback_queries = []
    if query_generic and query_generic != query:
        fallback_queries.append(query_generic)
    fallback_queries.extend(keywords[:5])
    for fq in fallback_queries:
        log.info(f"  last-ditch fallback with generic query {fq!r}")
        if providers.get("pexels", True):
            previews = _pexels_search_previews(fq, count=4, exclude_ids=used_ids)
            if previews:
                pid, _, full = previews[0]
                path = _pexels_download_full(pid, full, output_dir)
                if path:
                    used_ids.add(f"pexels_img:{pid}")
                    F._remember_clip(f"pexels_img:{pid}")
                    log.info(f"  fallback filled shot with pexels id {pid} (query={fq!r})")
                    return {"type": "image", "path": path,
                            "origin": "pexels_img_fallback", "score": -1}
    log.warning(f"  No image found for shot {query!r} even after generic fallback")
    return None


# Per-channel footage modes.
#
# Motion is opt-in per channel rather than a global switch because the
# providers behind it are rate-limited and uneven: Agnes has generation
# quota, and the Internet Archive only sometimes has on-topic footage.
# Rolling it to every channel at once would spend that budget on
# channels the operator has not evaluated yet.
#
#   stills    AI images only. No generated clips, no archive footage.
#   standard  DEFAULT. What every channel did before real footage
#             existed: generated clips for the opening shots, stills
#             for the rest. Chosen as the default so enabling nothing
#             changes nothing.
#   motion    standard PLUS real public-domain archive footage, and
#             more shots eligible for motion.
#   full      EVERY shot is a generated clip. A 30s video is 6x5s of
#             real motion end to end. Costs 6 Agnes video generations
#             per render, so it is the most expensive mode by far —
#             which is exactly why it is opt-in per channel.
FOOTAGE_MODES = ("stills", "standard", "motion", "full")
DEFAULT_FOOTAGE_MODE = "standard"


def _normalise_footage_mode(mode) -> str:
    m = str(mode or "").strip().lower()
    return m if m in FOOTAGE_MODES else DEFAULT_FOOTAGE_MODE


def _motion_budget(mode: str, total_shots: int = 0) -> int:
    """How many opening shots may use motion, for this mode."""
    if mode == "stills":
        return 0
    if mode in ("motion", "full"):
        # EVERY shot. "motion" used to mean 4 of 6, with "full" as a
        # separate mode for all of them — a distinction that only made
        # sense from the inside. Setting a channel to motion should
        # produce a video made of motion, not a mix where a third of
        # the shots are quietly stills.
        #
        # "full" is kept as an accepted value so any channel already set
        # to it keeps working, but it now behaves identically.
        return max(1, int(total_shots or 6))
    base = _agnes_video_shots()
    if mode == "motion":
        # Motion channels get a wider window, since that is the whole
        # point of putting a channel in this mode.
        try:
            return max(base, int(os.getenv("MOTION_MODE_SHOTS", "4")))
        except Exception:
            return max(base, 4)
    return base


def fetch_shots(shots, output_dir, channel="horror", preset_sources=None,
                tone_override: str = "", language: str = "",
                footage_mode: str = DEFAULT_FOOTAGE_MODE):
    """For each shot, fetch one image (with vision validation). Returns the
    list of source dicts in shot order. Missing shots are simply skipped.

    `preset_sources`: when the user provided their own images via manual
    mode, drop them into the EARLIEST shots first (one per shot) and
    only call the provider chain for the remaining shots. Lets the user
    seed the story visually without throwing away the auto-fetcher.

    Reports per-shot progress to run_state so the dashboard bar moves
    smoothly during this long step (the footage stage owns 30%..60% of
    the bar). Checks for user cancellation between shots."""
    from pathlib import Path
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading as _threading
    from modules import run_state
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    reset_pollinations_breaker()
    reset_hf_breaker()
    # Drop the previous render's character anchors before this one
    # starts, or a worker that stays up would reference the last
    # video's protagonist in this video's shots.
    reset_cast_anchors()
    used_ids = set(F._load_used_clips())
    presets = list(preset_sources or [])
    total = max(1, len(shots))

    # Per-channel footage mode. Unknown/blank falls back to the
    # pre-existing behaviour, so a channel that has never been
    # configured renders exactly as it did before this setting existed.
    _mode = _normalise_footage_mode(footage_mode)
    # Reference portraits BEFORE any shot renders, so the very first
    # appearance already matches the sheet rather than defining it.
    if _mode != "stills":
        try:
            _n = build_cast_sheet(shots, output_dir)
            if _n:
                log.info(f"cast-sheet: {_n} character reference(s) ready")
        except Exception as _e:
            log.warning(f"cast-sheet skipped: {_e!r}")
    log.info(f"footage mode: {_mode} (motion budget: {_motion_budget(_mode, total)} of {total} shot(s))")

    # Parallelism: a single SDXL inference at 1024x576 uses ~4-5 GB
    # VRAM, so 3 concurrent shots fits comfortably on a 16 GB T4
    # (~12-15 GB peak). HF Inference API + Pollinations are HTTP calls
    # with no per-worker cost, so parallelism is a free speedup for
    # them too. Setting exposed under settings.image_gen.shot_parallelism
    # — default 3. On T4x2 (multi-GPU) the ceiling doubles to 12: each
    # card holds its own 3-shot batch and the round-robin dispatcher
    # below balances load across GPU 0 / GPU 1.
    ig_cfg = (load_settings().get("image_gen") or {})
    try:
        from modules import gpu_topology as _gt
        _sdxl_ceiling = 12 if _gt.supports_multi_gpu else 6
    except Exception:
        _sdxl_ceiling = 6
    max_workers = max(1, min(_sdxl_ceiling, int(ig_cfg.get("shot_parallelism", 3))))

    # used_ids is shared across threads; guard mutations with a lock so
    # two shots don't both burn the same pexels/shutterstock id and end
    # up with duplicated stock imagery.
    used_lock = _threading.Lock()

    # Round-robin GPU assignment: shot idx N lands on device_ids[N %
    # len]. Sticky per-shot so retries stay on the same GPU (keeps the
    # HF cache hot for that seed's prompt encoding). No-op on T4x1 —
    # every shot goes to cuda:0.
    try:
        from modules import gpu_topology as _gt
        _sdxl_devices = _gt.sdxl_ready_devices or [0]
    except Exception:
        _sdxl_devices = [0]

    def _fetch_one(idx: int, shot: dict, preset_src: dict | None):
        # Pin this worker thread to a specific CUDA device for any
        # local_sdxl call it makes. Read inside _local_sdxl_load /
        # _local_sdxl_generate via _current_sdxl_device().
        _LOCAL_SDXL_TLS.device = _sdxl_devices[idx % len(_sdxl_devices)]
        run_state.check_cancel()
        if preset_src is not None:
            src = dict(preset_src)
            log.info(f"Shot {idx+1}/{total}: preset image {src.get('path')}")
        else:
            log.info(f"Shot {idx+1}/{total}: fetching (cuda:{_LOCAL_SDXL_TLS.device})")
            src = None
            # Real motion for the opening shots, when enabled. Shorts
            # retention is decided in the first seconds, so a generated
            # clip earns more there than anywhere else in the video —
            # and capping it keeps the ~90 s/clip cost bounded instead
            # of adding half an hour to every render.
            if idx < _motion_budget(_mode, total):
                if _agnes_key():
                    # Same key bug as the archive path had: the
                    # storyboard emits visual_description / ai_prompt /
                    # search_query, never "visual"/"prompt"/"description".
                    # _vp was therefore ALWAYS empty and
                    # _agnes_video_generate was never once called in
                    # production — the motion slot looked configured and
                    # silently produced stills.
                    #
                    # ai_prompt first here: it is the fully-written
                    # diffusion prompt, which is what a generative video
                    # model wants (the opposite of the archive path,
                    # which wants the short search phrase).
                    _vp = (shot.get("ai_prompt") or shot.get("visual_description")
                           or shot.get("search_query") or "")
                    if _vp:
                        # Generate to the shot's real length. The default
                        # was a fixed 5s regardless of the shot, so a 3s
                        # shot wasted generation and an 8s shot had to be
                        # stretched or frozen to cover the gap.
                        try:
                            _dur = float(shot.get("end", 0)) - float(shot.get("start", 0))
                        except (TypeError, ValueError):
                            _dur = 0.0
                        # Drive the clip from this character's reference
                        # portrait when we have one. Motion mode now
                        # covers every shot, so text-to-video would
                        # re-invent the person on each of the six —
                        # which is precisely the drift the cast sheet
                        # exists to stop.
                        # Animate THIS SHOT'S OWN frame, not the cast
                        # portrait.
                        #
                        # image-to-video uses the supplied image as
                        # FRAME 1. Passing the character sheet therefore
                        # opened every single clip on a studio
                        # head-and-shoulders portrait against a plain
                        # background — visible in the output and plainly
                        # wrong. The portrait is a likeness reference,
                        # never a shot.
                        #
                        # Right order: render the shot's own still first
                        # (find_image_for_shot already applies the cast
                        # anchor, so the face is already consistent),
                        # then animate that. Frame 1 becomes the correct
                        # opening image for the shot AND the character
                        # still matches, which is what we were actually
                        # trying to achieve.
                        with used_lock:
                            _isnap = set(used_ids)
                        _still = find_image_for_shot(
                            shot, output_dir, _isnap, channel=channel,
                            tone_override=tone_override, language=language)
                        with used_lock:
                            used_ids.update(_isnap)
                        _init = ""
                        _sp = (_still or {}).get("path") or ""
                        if _sp and os.path.exists(_sp):
                            try:
                                import base64 as _b64
                                with open(_sp, "rb") as _rf:
                                    _init = ("data:image/jpeg;base64,"
                                             + _b64.b64encode(_rf.read()).decode("ascii"))
                            except Exception as _re:
                                log.warning(f"agnes-video: shot still unreadable: {_re}")
                        src = _agnes_video_generate(_vp, output_dir, idx,
                                                    seconds=_dur if _dur > 0 else 5.0,
                                                    init_image_url=_init)
                        # Animation failed but we already have a good
                        # still for this shot — use it rather than
                        # throwing the work away and re-fetching below.
                        if src is None and _still:
                            src = _still
                # Real archive footage — ONLY for channels explicitly
                # put in motion mode. Agnes has generation quota and
                # the Archive's coverage is uneven, so this stays
                # opt-in until the operator has judged the result on a
                # channel they chose.
                if src is None and _mode in ("motion", "full") and _archive_clips_enabled():
                    with used_lock:
                        _snap = set(used_ids)
                    src = _archive_clip_for_shot(shot, output_dir, idx, _snap)
                    with used_lock:
                        used_ids.update(_snap)
                if src is None:
                    log.info(f"Shot {idx+1}: no motion source, using a still instead")
            if src is None:
                # Snapshot used_ids under lock so the provider sees a
                # consistent view; merge new additions back under lock.
                with used_lock:
                    snap = set(used_ids)
                src = find_image_for_shot(shot, output_dir, snap, channel=channel,
                                          tone_override=tone_override, language=language)
                with used_lock:
                    used_ids.update(snap)
        if src:
            src["start"] = float(shot.get("start", 0.0))
            src["end"]   = float(shot.get("end", 0.0))
        return idx, src

    # If ANY preset is provided, respect the "earliest shots first" rule
    # by handing each preset to the corresponding shot index. Remaining
    # shots get None → falls through to the provider chain.
    preset_by_idx = {i: presets[i] for i in range(min(len(presets), len(shots)))}

    # Pre-warm local_sdxl on the main thread if it's enabled + first in
    # the priority list. Without this, thread 1 in the pool triggers a
    # 60-120 sec model download; thread 2+3 grab the load lock and wait
    # idle for that long, wasting their attempt budget. Warming here
    # means all N threads start with the pipeline ready and can gen
    # concurrently from the first attempt. No-op on CPU-only workers.
    try:
        _priority_head = (
            (load_settings().get("image_gen") or {}).get("priority")
            or ["local_flux2_klein", "huggingface", "local_sdxl", "pollinations"]
        )
        _ig_enabled = (load_settings().get("image_gen") or {}).get("enabled") or {}
        # Pre-warm klein-4B on Kaggle T4×2 if enabled — same rationale as
        # SDXL pre-warm: first-shot load is ~30-60s including model
        # download, and we don't want any of the parallel shot workers
        # idle-waiting on the load lock during their attempt budget.
        # Cheap no-op on Colab/Oracle (flux2_supported=False).
        if "local_flux2_klein" in _priority_head and _ig_enabled.get("local_flux2_klein", True):
            try:
                from modules import gpu_topology as _gt_f
                if _gt_f.flux2_supported:
                    log.info(
                        "shot fetch pre-warm: loading local_flux2_klein "
                        "via device_map=balanced (blocks pool start)"
                    )
                    _local_flux2_klein_load()
            except Exception as _fe:
                log.debug(f"local_flux2_klein pre-warm skipped: {_fe}")
        # Legacy SDXL pre-warm — keep for the fallback path when
        # klein-4B is disabled or broken.
        if "local_sdxl" in _priority_head and _ig_enabled.get("local_sdxl", False):
            # On T4x2 (multi-GPU), warm BOTH pipelines in parallel so
            # the shot pool starts with the second card already ready
            # instead of paying a serial ~1 min second-load on the
            # first shot that lands on cuda:1.
            try:
                from modules import gpu_topology as _gt2
                warm_devices = list(_gt2.sdxl_ready_devices) or [0]
            except Exception:
                warm_devices = [0]
            if len(warm_devices) > 1:
                log.info(
                    f"shot fetch pre-warm: loading local_sdxl on "
                    f"cuda:{warm_devices} in parallel (blocks pool start)"
                )
                from concurrent.futures import ThreadPoolExecutor as _TPE
                with _TPE(max_workers=len(warm_devices),
                          thread_name_prefix="sdxl-warm") as _wex:
                    list(_wex.map(_local_sdxl_load, warm_devices))
            else:
                log.info(
                    f"shot fetch pre-warm: loading local_sdxl on "
                    f"cuda:{warm_devices[0]} (blocks pool start)"
                )
                _local_sdxl_load(warm_devices[0])
    except Exception as _e:
        log.debug(f"local_sdxl pre-warm skipped: {_e}")

    results: list[dict | None] = [None] * len(shots)
    done_count = 0
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="shotfetch") as ex:
        futures = [
            ex.submit(_fetch_one, i, s, preset_by_idx.get(i))
            for i, s in enumerate(shots)
        ]
        for fut in as_completed(futures):
            # Bail immediately on cancel — otherwise as_completed()
            # blocks on the ThreadPoolExecutor's context exit, which
            # waits for every outstanding shot to finish (up to a full
            # minute per shot). Cancel appeared frozen for the user
            # even though the flag was set.
            if run_state.cancellation_requested():
                for _f in futures:
                    _f.cancel()
                ex.shutdown(wait=False, cancel_futures=True)
                raise run_state.Cancelled("shot fetch cancelled")
            try:
                idx, src = fut.result()
            except run_state.Cancelled:
                # A worker thread saw check_cancel() — propagate up so
                # the whole render unwinds instead of continuing to
                # collect partial results from other threads.
                ex.shutdown(wait=False, cancel_futures=True)
                raise
            except Exception as e:
                log.warning(f"shot fetch worker crashed: {e}")
                continue
            results[idx] = src
            done_count += 1
            run_state.tick("footage", done_count / total)

    sources = [s for s in results if s is not None]
    log.info(
        f"Storyboard fetch: {len(sources)}/{len(shots)} shots filled "
        f"({sum(1 for s in sources if s.get('origin') == 'manual_upload')} from user upload) "
        f"— parallelism={max_workers}"
    )
    return sources

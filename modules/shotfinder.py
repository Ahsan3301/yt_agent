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
import logging
import base64
import hashlib
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


def _pollinations_generate(prompt, output_dir, trial):
    """Generate one image via Pollinations, respecting the circuit breaker.
    Returns (path, seed) on success, (None, seed) on any failure."""
    seed = int(hashlib.md5(f"{prompt}|{trial}".encode()).hexdigest()[:8], 16)

    if _pollinations_breaker_skip():
        wait = int(_POLL_OPEN_UNTIL - time.time())
        log.info(f"Pollinations: breaker OPEN (skipping; reopens in {wait}s)")
        return None, seed

    encoded = urllib.parse.quote(prompt, safe="")
    url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=1080&height=1920&seed={seed}&model=flux&nologo=true&private=true"
        f"&safe={'true' if F._restrictions_on() else 'false'}"
    )
    dest = os.path.join(output_dir, f"pollinations_{seed:08x}.jpg")

    try:
        # Single attempt — we don't retry inside the breaker; the breaker
        # itself is the retry policy. A 429 trips it; a 5xx is one-shot.
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

def find_image_for_shot(shot, output_dir, used_ids, channel="horror"):
    vid_cfg = load_settings().get("video", {})
    providers = load_settings().get("providers", {}) or {}
    threshold = int(vid_cfg.get("vision_judge_threshold", 4))
    judge_on = bool(vid_cfg.get("vision_judge_enabled", True)) and nim.is_available()

    visual = shot.get("visual_description") or shot.get("search_query") or ""
    query = shot.get("search_query") or ""
    ai_prompt = shot.get("ai_prompt") or visual
    premise = shot.get("narration_excerpt") or ""

    log.info(f"Shot fetch | query={query!r} | excerpt={premise[:60]!r}")

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

    # ── 3. Pollinations AI generation (crafted per-shot prompt) ──
    if providers.get("pollinations", False):
        # Generate up to N attempts. Each attempt asks NIM to craft a FRESH
        # cinematic prompt for THIS shot with a different camera angle, so
        # the AI gen doesn't repeat the same composition twice.
        ai_attempts = int(vid_cfg.get("ai_image_attempts_per_shot", 3))
        for trial in range(ai_attempts):
            crafted = craft_image_prompt(
                narration_excerpt=premise,
                visual_description=visual,
                channel=channel,
                attempt=trial,
            )
            prompt_to_use = crafted or ai_prompt
            if crafted:
                log.info(f"  AI prompt (try {trial+1}): {crafted[:90]}...")
            else:
                log.info(f"  AI prompt (try {trial+1}, raw): {ai_prompt[:90]}...")
            path, seed = _pollinations_generate(prompt_to_use, output_dir, trial)
            if not path:
                continue
            if judge_on:
                s = _score_local_image(path, visual, premise)
                log.info(f"  Pollinations AI: {s}/10 (seed {seed})")
                if s >= threshold:
                    used_ids.add(f"pollinations:{seed}")
                    F._remember_clip(f"pollinations:{seed}")
                    return {"type": "image", "path": path,
                            "origin": "pollinations", "score": s}
                if s > 0:
                    consider(s, {"type": "image", "path": path,
                                 "origin": "pollinations", "score": s})
            else:
                used_ids.add(f"pollinations:{seed}")
                F._remember_clip(f"pollinations:{seed}")
                return {"type": "image", "path": path,
                        "origin": "pollinations", "score": -1}

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

    log.warning(f"  No image found for shot {query!r}")
    return None


def fetch_shots(shots, output_dir, channel="horror"):
    """For each shot, fetch one image (with vision validation). Returns the
    list of source dicts in shot order. Missing shots are simply skipped."""
    from pathlib import Path
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    reset_pollinations_breaker()
    used_ids = set(F._load_used_clips())
    sources = []
    for i, shot in enumerate(shots, 1):
        log.info(f"Shot {i}/{len(shots)}")
        src = find_image_for_shot(shot, output_dir, used_ids, channel=channel)
        if src:
            src["start"] = float(shot.get("start", 0.0))
            src["end"]   = float(shot.get("end", 0.0))
            sources.append(src)
    log.info(f"Storyboard fetch: {len(sources)}/{len(shots)} shots filled")
    return sources

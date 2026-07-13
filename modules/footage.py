"""
footage.py — Stock Footage & Background Music Module

Video providers (tried in order until clips_needed is met):
  1. Pexels   (200 req/hr, free)      — broad catalog, search + curated/popular
  2. Coverr   (1000 calls/month, key) — curated cinematic clips (best quality)
  3. Pixabay  (100 req/hr, free)      — fallback breadth

Music providers (tried until one returns a track):
  1. Pixabay   (key required)
  2. Openverse (no key, CC0/CC music aggregated from Freesound + others)

All providers gracefully skip when their key is missing.
"""
import os
import json
import random
import logging
import requests
from pathlib import Path
from dotenv import load_dotenv

from modules._net import retry
from modules.config import load_settings
from modules import nim

load_dotenv()
log = logging.getLogger(__name__)

PEXELS_KEY = os.getenv("PEXELS_API_KEY", "")
PIXABAY_KEY = os.getenv("PIXABAY_API_KEY", "")
COVERR_KEY = os.getenv("COVERR_API_KEY", "")
SHUTTERSTOCK_TOKEN = os.getenv("SHUTTERSTOCK_API_TOKEN", "")
SHUTTERSTOCK_SUBSCRIPTION_ID = os.getenv("SHUTTERSTOCK_SUBSCRIPTION_ID", "")
SHUTTERSTOCK_CLIENT_ID = os.getenv("SHUTTERSTOCK_CLIENT_ID", "")
SHUTTERSTOCK_CLIENT_SECRET = os.getenv("SHUTTERSTOCK_CLIENT_SECRET", "")

# Cache for the OAuth-derived bearer token (in-process only).
_SS_OAUTH_CACHE = {"token": None, "expires_at": 0.0}

USED_CLIPS_FILE = "data/used_clips.json"
USED_CLIPS_KEEP = 200  # cap history so it doesn't grow forever

# Words that, when present in a search query OR in a returned item's text
# fields (alt text / tags / user / url), indicate the result is suggestive
# or NSFW and must be rejected. Lowercase. Match is substring-based.
ADULT_DENY_TERMS = {
    "sex", "sexy", "sensual", "seductive", "erotic", "intimate", "boudoir",
    "nude", "naked", "topless", "undressed", "nsfw",
    "lingerie", "underwear", "thong", "bikini", "swimsuit", "cleavage",
    "porn", "pornographic", "fetish",
    "bare chest", "bare back", "model pose",
}


def _restrictions_on():
    """settings.video.content_restrictions — when False (default), the local
    adult denylist is disabled so the gothic-horror niche can search for
    things like 'naked branches', 'bare walls', etc. without false rejection.
    Server-side safe filters at each provider are still configurable per
    provider (Shutterstock 'safe', Pixabay 'safesearch', Openverse 'mature').
    """
    return bool(load_settings().get("video", {}).get("content_restrictions", False))


def _is_adult_query(query):
    if not _restrictions_on():
        return False
    q = (query or "").lower()
    return any(term in q for term in ADULT_DENY_TERMS)


def _is_adult_item(*text_fields):
    """True if any combined text field contains a denylisted term."""
    if not _restrictions_on():
        return False
    blob = " ".join(str(f) for f in text_fields if f).lower()
    return any(term in blob for term in ADULT_DENY_TERMS)

FOOTAGE_KEYWORDS = {
    "horror": ["dark forest night", "abandoned house", "fog night", "dark corridor", "storm night"],
    "wisdom": ["sunrise nature", "city timelapse", "ocean waves", "mountain peak", "people walking"],
}

MUSIC_KEYWORDS = {
    "horror": "dark ambient horror",
    "wisdom": "inspirational background music",
}


# ── used-clips state ──────────────────────────────────────────
# Cross-process file lock for the used_clips read-modify-write cycle
# (audit fix #9, 2026-07-13). Two concurrent renders on the same host
# used to lose an update when both loaded, appended, and saved
# in-flight — the later writer overwrote the earlier writer's addition
# and the "lost" clip id could be re-picked. filelock is a soft
# dep — a worker without it falls back to unlocked behaviour with a
# debug log (no crash).
try:
    from filelock import FileLock as _FileLock, Timeout as _FileLockTimeout
    _HAS_FILELOCK = True
except Exception:
    _HAS_FILELOCK = False
    _FileLockTimeout = Exception  # type: ignore


class _NullLock:
    def __enter__(self):  return self
    def __exit__(self, *a): return False


def _clips_lock(timeout: float = 15.0):
    if not _HAS_FILELOCK:
        return _NullLock()
    os.makedirs(os.path.dirname(USED_CLIPS_FILE), exist_ok=True)
    return _FileLock(USED_CLIPS_FILE + ".lock", timeout=timeout)


def _load_used_clips():
    if not os.path.exists(USED_CLIPS_FILE):
        return []
    try:
        with open(USED_CLIPS_FILE, "r") as f:
            return list(json.load(f))
    except (json.JSONDecodeError, OSError):
        return []


def _save_used_clips(ids):
    os.makedirs(os.path.dirname(USED_CLIPS_FILE), exist_ok=True)
    trimmed = list(ids)[-USED_CLIPS_KEEP:]
    tmp = USED_CLIPS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(trimmed, f)
    os.replace(tmp, USED_CLIPS_FILE)


def _remember_clip(clip_id):
    # Load + append + save under a single lock so concurrent renders
    # can't drop each other's newly-remembered clip.
    try:
        with _clips_lock():
            used = _load_used_clips()
            used.append(clip_id)
            _save_used_clips(used)
    except _FileLockTimeout:
        log.warning("_remember_clip: lock timeout — appending unguarded")
        used = _load_used_clips()
        used.append(clip_id)
        _save_used_clips(used)


# ── download ──────────────────────────────────────────────────
def download_file(url, dest_path):
    """Stream-download a file to disk, retrying on network errors."""
    def _do():
        r = requests.get(url, stream=True, timeout=60)
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        return dest_path

    try:
        return retry(_do, attempts=3, on=(requests.RequestException, OSError), desc="download")
    except Exception as e:
        log.warning(f"Download failed permanently ({url}): {e}")
        return None


def _pick_video_file(video_files):
    """Prefer HD portrait, then HD landscape, then SD, then anything."""
    if not video_files:
        return None
    # Pexels returns files with quality "hd"/"sd", width/height.
    def score(f):
        q = (f.get("quality") or "").lower()
        w = f.get("width", 0)
        h = f.get("height", 0)
        portrait = h >= w  # vertical preferred for Shorts
        return (q == "hd", portrait, w * h)
    return max(video_files, key=score)


def fetch_pexels_videos(query, output_dir, count, used_ids):
    if not PEXELS_KEY:
        return []
    if _is_adult_query(query):
        log.warning(f"skipping pexels-search for adult query: {query!r}")
        return []

    headers = {"Authorization": PEXELS_KEY}
    url = "https://api.pexels.com/videos/search"
    params = {"query": query, "per_page": count * 3, "size": "medium", "orientation": "portrait"}

    try:
        r = retry(
            lambda: requests.get(url, headers=headers, params=params, timeout=20),
            attempts=3, on=(requests.RequestException,), desc="pexels-search",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Pexels API error: {e}")
        return []

    videos = r.json().get("videos", [])
    paths = []
    for v in videos:
        if len(paths) >= count:
            break
        vid = f"pexels:{v.get('id')}"
        if vid in used_ids:
            continue
        # Skip suggestive results based on description / uploader / URL slug.
        if _is_adult_item(v.get("url"), v.get("user", {}).get("name"), v.get("alt"),
                          " ".join(v.get("tags", []) if isinstance(v.get("tags"), list) else [])):
            log.info(f"pexels {v.get('id')} skipped by adult filter")
            continue
        chosen = _pick_video_file(v.get("video_files", []))
        if not chosen:
            continue
        dest = os.path.join(output_dir, f"pexels_{v.get('id')}.mp4")
        log.info(f"Downloading Pexels {v.get('id')} ({chosen.get('quality')}, {chosen.get('width')}x{chosen.get('height')})")
        if download_file(chosen["link"], dest):
            paths.append(dest)
            used_ids.add(vid)
            _remember_clip(vid)
    return paths


def fetch_pexels_popular(output_dir, count, used_ids):
    """
    Fallback when keyword searches return nothing useful — Pexels' curated
    /videos/popular endpoint surfaces editor-picked clips that are usually
    much higher quality than long-tail search results.
    """
    if not PEXELS_KEY:
        return []

    headers = {"Authorization": PEXELS_KEY}
    url = "https://api.pexels.com/videos/popular"
    params = {"per_page": count * 4, "min_width": 720}

    try:
        r = retry(
            lambda: requests.get(url, headers=headers, params=params, timeout=20),
            attempts=3, on=(requests.RequestException,), desc="pexels-popular",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Pexels popular error: {e}")
        return []

    videos = r.json().get("videos", [])
    paths = []
    for v in videos:
        if len(paths) >= count:
            break
        vid = f"pexels:{v.get('id')}"
        if vid in used_ids:
            continue
        if _is_adult_item(v.get("url"), v.get("user", {}).get("name"), v.get("alt")):
            continue
        chosen = _pick_video_file(v.get("video_files", []))
        if not chosen:
            continue
        dest = os.path.join(output_dir, f"pexels_pop_{v.get('id')}.mp4")
        log.info(f"Downloading Pexels(popular) {v.get('id')} ({chosen.get('quality')}, {chosen.get('width')}x{chosen.get('height')})")
        if download_file(chosen["link"], dest):
            paths.append(dest)
            used_ids.add(vid)
            _remember_clip(vid)
    return paths


def fetch_coverr_videos(query, output_dir, count, used_ids):
    """
    Coverr: curated cinematic clips. 1000 calls/month on the free tier.
    Requires COVERR_API_KEY in .env. See https://coverr.co/developers
    """
    if not COVERR_KEY:
        return []
    if _is_adult_query(query):
        log.warning(f"skipping coverr-search for adult query: {query!r}")
        return []

    headers = {"Authorization": f"Bearer {COVERR_KEY}"}
    url = "https://api.coverr.co/videos"
    params = {"query": query, "page_size": max(count * 3, 3), "sort": "popular", "urls": "true"}

    try:
        r = retry(
            lambda: requests.get(url, headers=headers, params=params, timeout=20),
            attempts=3, on=(requests.RequestException,), desc="coverr-search",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Coverr API error: {e}")
        return []

    payload = r.json() or {}
    hits = payload.get("hits") or payload.get("videos") or []
    paths = []
    for h in hits:
        if len(paths) >= count:
            break
        vid_id = h.get("id") or h.get("_id")
        if not vid_id:
            continue
        vid = f"coverr:{vid_id}"
        if vid in used_ids:
            continue
        urls = h.get("urls") or {}
        mp4 = urls.get("mp4_download") or urls.get("mp4") or h.get("mp4")
        if not mp4:
            continue
        dest = os.path.join(output_dir, f"coverr_{vid_id}.mp4")
        log.info(f"Downloading Coverr {vid_id} ({h.get('aspect_ratio')}, {h.get('duration')}s)")
        if download_file(mp4, dest):
            paths.append(dest)
            used_ids.add(vid)
            _remember_clip(vid)
    return paths


def fetch_pixabay_videos(query, output_dir, count, used_ids):
    if not PIXABAY_KEY:
        return []

    if _is_adult_query(query):
        log.warning(f"skipping pixabay-videos for adult query: {query!r}")
        return []
    url = "https://pixabay.com/api/videos/"
    params = {"key": PIXABAY_KEY, "q": query, "per_page": max(count * 3, 3),
              "video_type": "film", "safesearch": ("true" if _restrictions_on() else "false")}

    try:
        r = retry(
            lambda: requests.get(url, params=params, timeout=20),
            attempts=3, on=(requests.RequestException,), desc="pixabay-search",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Pixabay API error: {e}")
        return []

    hits = r.json().get("hits", [])
    paths = []
    for h in hits:
        if len(paths) >= count:
            break
        vid = f"pixabay:{h.get('id')}"
        if vid in used_ids:
            continue
        if _is_adult_item(h.get("tags"), h.get("user"), h.get("pageURL")):
            continue
        # Prefer large > medium > small.
        files = h.get("videos", {}) or {}
        video_url = None
        for key in ("large", "medium", "small"):
            v = files.get(key)
            if v and v.get("url"):
                video_url = v["url"]
                break
        if not video_url:
            continue
        dest = os.path.join(output_dir, f"pixabay_{h.get('id')}.mp4")
        log.info(f"Downloading Pixabay {h.get('id')}")
        if download_file(video_url, dest):
            paths.append(dest)
            used_ids.add(vid)
            _remember_clip(vid)
    return paths


def fetch_pexels_photos(query, output_dir, count, used_ids):
    """Pexels stills — used to supplement video when we need more material."""
    if not PEXELS_KEY:
        return []
    if _is_adult_query(query):
        log.warning(f"skipping pexels-photos for adult query: {query!r}")
        return []

    headers = {"Authorization": PEXELS_KEY}
    url = "https://api.pexels.com/v1/search"
    params = {"query": query, "per_page": count * 3, "orientation": "portrait", "size": "large"}

    try:
        r = retry(
            lambda: requests.get(url, headers=headers, params=params, timeout=20),
            attempts=3, on=(requests.RequestException,), desc="pexels-photos",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Pexels photos error: {e}")
        return []

    photos = r.json().get("photos", [])
    paths = []
    for p in photos:
        if len(paths) >= count:
            break
        pid = f"pexels_img:{p.get('id')}"
        if pid in used_ids:
            continue
        if _is_adult_item(p.get("alt"), p.get("url"), p.get("photographer")):
            continue
        # src is a dict of sizes; prefer large2x > original > large.
        src = p.get("src") or {}
        img_url = src.get("large2x") or src.get("original") or src.get("large")
        if not img_url:
            continue
        dest = os.path.join(output_dir, f"pexels_img_{p.get('id')}.jpg")
        log.info(f"Downloading Pexels photo {p.get('id')}")
        if download_file(img_url, dest):
            paths.append(dest)
            used_ids.add(pid)
            _remember_clip(pid)
    return paths


def fetch_pixabay_photos(query, output_dir, count, used_ids):
    """Pixabay stills — used to supplement video when we need more material."""
    if not PIXABAY_KEY:
        return []
    if _is_adult_query(query):
        log.warning(f"skipping pixabay-photos for adult query: {query!r}")
        return []

    url = "https://pixabay.com/api/"
    params = {
        "key": PIXABAY_KEY, "q": query,
        "per_page": max(count * 3, 3),
        "image_type": "photo", "orientation": "vertical",
        "safesearch": ("true" if _restrictions_on() else "false"),
    }

    try:
        r = retry(
            lambda: requests.get(url, params=params, timeout=20),
            attempts=3, on=(requests.RequestException,), desc="pixabay-photos",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Pixabay photos error: {e}")
        return []

    hits = r.json().get("hits", [])
    paths = []
    for h in hits:
        if len(paths) >= count:
            break
        pid = f"pixabay_img:{h.get('id')}"
        if pid in used_ids:
            continue
        if _is_adult_item(h.get("tags"), h.get("user"), h.get("pageURL")):
            continue
        img_url = h.get("largeImageURL") or h.get("webformatURL")
        if not img_url:
            continue
        dest = os.path.join(output_dir, f"pixabay_img_{h.get('id')}.jpg")
        log.info(f"Downloading Pixabay photo {h.get('id')}")
        if download_file(img_url, dest):
            paths.append(dest)
            used_ids.add(pid)
            _remember_clip(pid)
    return paths


def _shutterstock_token():
    """
    Return a bearer token to use against Shutterstock's API.

    Preference order:
      1. SHUTTERSTOCK_API_TOKEN from .env — this is the long-lived USER token
         generated from the developer dashboard's "Generate token" button.
         It has the full scope including licenses.create (lets us download
         licensed full-res images).
      2. Fallback: client_credentials OAuth grant using
         SHUTTERSTOCK_CLIENT_ID/SECRET. The resulting token has scope
         "user.view" only — fine for /v2/images/search, NOT enough to
         create a license. Without the user token, we can't actually
         download usable images.
    """
    import time
    if SHUTTERSTOCK_TOKEN:
        return SHUTTERSTOCK_TOKEN, "user"

    if not (SHUTTERSTOCK_CLIENT_ID and SHUTTERSTOCK_CLIENT_SECRET):
        return None, None

    # Reuse cached OAuth token if still valid (with 60s headroom).
    if _SS_OAUTH_CACHE["token"] and time.time() < _SS_OAUTH_CACHE["expires_at"] - 60:
        return _SS_OAUTH_CACHE["token"], "oauth"

    try:
        r = retry(
            lambda: requests.post(
                "https://api.shutterstock.com/v2/oauth/access_token",
                data={
                    "client_id":     SHUTTERSTOCK_CLIENT_ID,
                    "client_secret": SHUTTERSTOCK_CLIENT_SECRET,
                    "grant_type":    "client_credentials",
                },
                timeout=15,
            ),
            attempts=2, on=(requests.RequestException,), desc="shutterstock-oauth",
        )
        r.raise_for_status()
        data = r.json()
        tok = data.get("access_token")
        if not tok:
            return None, None
        _SS_OAUTH_CACHE["token"] = tok
        _SS_OAUTH_CACHE["expires_at"] = time.time() + int(data.get("expires_in", 3600))
        log.info("Shutterstock OAuth token acquired (scope: user.view — search-only)")
        return tok, "oauth"
    except Exception as e:
        log.warning(f"Shutterstock OAuth failed: {e}")
        return None, None


def _shutterstock_subscription_id(token):
    """Return a Shutterstock subscription_id we can use for licensing.

    Prefers env-supplied SHUTTERSTOCK_SUBSCRIPTION_ID. Otherwise queries
    /v2/user/subscriptions once and caches the first active subscription's id.
    `token` must be a user-scoped token (the OAuth client-credentials token
    can't list subscriptions).
    """
    if SHUTTERSTOCK_SUBSCRIPTION_ID:
        return SHUTTERSTOCK_SUBSCRIPTION_ID
    cache_key = "_ss_sub_id"
    cached = globals().get(cache_key)
    if cached:
        return cached
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.get("https://api.shutterstock.com/v2/user/subscriptions",
                         headers=headers, timeout=15)
        r.raise_for_status()
        subs = r.json().get("data") or []
        for s in subs:
            sid = s.get("id")
            if sid:
                globals()[cache_key] = sid
                return sid
    except Exception as e:
        log.warning(f"Shutterstock subscription lookup failed: {e}")
    return None


def _shutterstock_preview_url(item):
    """Find the best free preview/thumbnail URL on a Shutterstock search item.
    These previews are watermarked — Shutterstock provides them for free
    on every search result, so vision-judging is zero-cost."""
    assets = item.get("assets") or {}
    for key in ("preview", "large_thumb", "huge_thumb", "small_thumb"):
        a = assets.get(key)
        if isinstance(a, dict):
            u = a.get("url")
            if u:
                return u
    return None


def fetch_shutterstock_images(query, output_dir, count, used_ids,
                              fit_description=None, premise=None):
    """
    Vision-gated Shutterstock search:
      1. Search returns N*multiplier WATERMARKED preview images (free).
      2. For each candidate, ask the NIM vision model to score 0-10 how
         well it fits the script's gothic-horror style.
      3. License + download ONLY the top-`count` images that score above
         the threshold — never burns quota on bad matches.

    Each licensed download still consumes 1 unit of the 500/month plan,
    but the vision filter dramatically improves the value per unit.

    `fit_description` is the visual style sentence (e.g. "gothic horror,
    candlelit, decaying, victorian, dread-soaked"). `premise` is the story
    premise — both help the vision model judge intent.

    If vision-judging is disabled or NIM isn't available, falls back to the
    old behaviour (license in search order).
    """
    if _is_adult_query(query):
        log.warning(f"skipping shutterstock for adult query: {query!r}")
        return []

    token, scope = _shutterstock_token()
    if not token:
        return []

    if scope != "user":
        log.warning(
            "Shutterstock: only an OAuth client-credentials token is available "
            "(scope=user.view). To license and download images, generate a "
            "user token from your developer dashboard and set SHUTTERSTOCK_API_TOKEN."
        )
        return []

    sub_id = _shutterstock_subscription_id(token)
    if not sub_id:
        log.warning("Shutterstock: no subscription_id available; skipping")
        return []

    headers = {"Authorization": f"Bearer {token}"}
    vid_cfg = load_settings().get("video", {})
    judge_on = bool(vid_cfg.get("vision_judge_enabled", True)) and nim.is_available()
    threshold = int(vid_cfg.get("vision_judge_threshold", 6))
    multiplier = max(2, int(vid_cfg.get("vision_judge_candidates_multiplier", 3)))

    # ── 1. Search ────────────────────────────────────────────
    # When vision-judging is on, pull a larger candidate pool so the model
    # has alternatives to pick from. Without judging, pull just enough.
    per_page = min((count * multiplier if judge_on else count * 2) + 2, 100)
    search_url = "https://api.shutterstock.com/v2/images/search"
    params = {
        "query": query,
        "per_page": per_page,
        "orientation": "vertical",
        "view": "full",
        "safe": "true" if _restrictions_on() else "false",
        "image_type": "photo",
    }
    try:
        r = retry(
            lambda: requests.get(search_url, headers=headers, params=params, timeout=15),
            attempts=3, on=(requests.RequestException,), desc="shutterstock-search",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Shutterstock search error: {e}")
        return []

    items = r.json().get("data", [])
    if not items:
        return []

    # Filter out already-used + adult-keyword items up front (cheap).
    candidates = []
    for it in items:
        img_id = it.get("id")
        sid = f"shutterstock:{img_id}"
        if not img_id or sid in used_ids:
            continue
        if _is_adult_item(it.get("description"),
                          " ".join(it.get("keywords", []) if isinstance(it.get("keywords"), list) else [])):
            continue
        candidates.append(it)

    if not candidates:
        return []

    # ── 2. Vision-judge (free; uses watermarked previews) ────
    if judge_on:
        log.info(f"Shutterstock: vision-judging {len(candidates)} candidates for {query!r} (threshold {threshold})")
        style = fit_description or (
            "gothic horror, dread-soaked, decaying, victorian, candlelit, fog-shrouded, occult, supernatural"
        )
        scored = []
        for it in candidates:
            preview = _shutterstock_preview_url(it)
            if not preview:
                continue
            score = nim.vision_score(preview, fit_description=style, premise=premise or "")
            if score < 0:
                # Vision call failed — assume neutral so we don't auto-reject.
                scored.append((5, it))
                continue
            log.debug(f"  ss {it.get('id')} score={score}")
            scored.append((score, it))
        # Keep only those at or above the threshold, ordered by score desc.
        scored.sort(key=lambda x: x[0], reverse=True)
        passing = [it for sc, it in scored if sc >= threshold][:count]
        if not passing:
            # No candidate cleared the bar. Take the best 1-2 we have instead
            # of returning nothing (Shutterstock results are typically good
            # enough that even a "5" beats most free-stock alternatives).
            passing = [it for _, it in scored[: min(count, 2)]]
            log.info(f"  Shutterstock: no candidates >= {threshold}; using top {len(passing)} anyway")
        candidates_to_license = passing
    else:
        candidates_to_license = candidates[:count]

    # ── 3. License + download chosen images ──────────────────
    paths = []
    for it in candidates_to_license:
        if len(paths) >= count:
            break
        img_id = it.get("id")
        sid = f"shutterstock:{img_id}"

        license_payload = {
            "images": [{"image_id": str(img_id), "subscription_id": sub_id}],
            "format": "jpg",
            "size": "huge",
        }
        try:
            lr = retry(
                lambda: requests.post(
                    "https://api.shutterstock.com/v2/images/licenses",
                    headers={**headers, "Content-Type": "application/json"},
                    json=license_payload, timeout=20,
                ),
                attempts=2, on=(requests.RequestException,), desc="shutterstock-license",
            )
            lr.raise_for_status()
        except Exception as e:
            log.warning(f"Shutterstock license failed for {img_id}: {e}")
            continue

        license_data = (lr.json().get("data") or [{}])[0]
        if license_data.get("error"):
            log.warning(f"Shutterstock license error for {img_id}: {license_data.get('error')}")
            continue
        download_url = (license_data.get("download") or {}).get("url")
        if not download_url:
            continue

        dest = os.path.join(output_dir, f"shutterstock_{img_id}.jpg")
        log.info(f"Downloading Shutterstock {img_id} (licensed, full-res){' [vision-vetted]' if judge_on else ''}")
        if download_file(download_url, dest):
            paths.append(dest)
            used_ids.add(sid)
            _remember_clip(sid)

    return paths


def fetch_pollinations_images(query, output_dir, count, used_ids,
                              style_suffix=None, model="flux"):
    """
    Generate atmospheric images from text via Pollinations (image.pollinations.ai).

    Free, no API key required. Each request returns a JPEG; we ask for
    1080x1920 portrait directly so it slots into the Ken-Burns segment
    renderer without rescaling artifacts.

    `style_suffix` is appended to every prompt — e.g. "cinematic horror,
    atmospheric, low light, film grain" — so the visual style matches the
    channel. Callers should pass channel-appropriate style.

    `model` picks the backend (flux, sdxl, etc — see /v1/models).
    """
    if _is_adult_query(query):
        log.warning(f"skipping pollinations for adult query: {query!r}")
        return []

    import urllib.parse, hashlib
    paths = []
    style = style_suffix or ""

    for i in range(count):
        prompt = f"{query}, {style}" if style else query
        # Each generation needs a unique seed so we don't get the same image
        # back twice for the same prompt. We derive one from query + index.
        seed = int(hashlib.md5(f"{prompt}|{i}".encode()).hexdigest()[:8], 16)

        # Build a stable id so cross-run dedup works.
        pid = f"pollinations:{seed}:{prompt[:60]}"
        if pid in used_ids:
            continue

        encoded = urllib.parse.quote(prompt, safe="")
        url = (
            f"https://image.pollinations.ai/prompt/{encoded}"
            f"?width=1080&height=1920&seed={seed}"
            f"&model={model}&nologo=true&private=true&safe=true"
        )
        dest = os.path.join(output_dir, f"pollinations_{seed:08x}.jpg")
        log.info(f"Generating AI image (Pollinations/{model}, seed={seed}): {prompt[:60]}...")

        # Pollinations can take 5-30s per image; bump the read timeout.
        def _do():
            r = requests.get(url, stream=True, timeout=90)
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            return dest

        try:
            result = retry(_do, attempts=2, on=(requests.RequestException, OSError), desc="pollinations")
        except Exception as e:
            log.warning(f"Pollinations generation failed for {prompt[:40]!r}: {e}")
            continue

        # Sanity check: tiny files = error/placeholder; skip.
        if not result or os.path.getsize(result) < 4096:
            log.warning(f"Pollinations returned suspiciously small file ({os.path.getsize(result) if result else 0} bytes); skipping")
            continue

        paths.append(result)
        used_ids.add(pid)
        _remember_clip(pid)

    return paths


def fetch_openverse_images(query, output_dir, count, used_ids):
    """
    Openverse image API: no key required, CC0/PDM/CC-BY photos aggregated
    from Wikimedia, Flickr, Smithsonian, etc. Last-resort image fallback
    when Pexels and Pixabay can't supply enough material.
    """
    if _is_adult_query(query):
        log.warning(f"skipping openverse-images for adult query: {query!r}")
        return []

    url = "https://api.openverse.org/v1/images/"
    params = {
        "q": query,
        "license": "cc0,pdm,by",
        "page_size": max(count * 3, 5),
        "mature": ("false" if _restrictions_on() else "true"),
        "aspect_ratio": "tall",
    }
    try:
        r = retry(
            lambda: requests.get(url, params=params, timeout=15),
            attempts=3, on=(requests.RequestException,), desc="openverse-images",
        )
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Openverse images error: {e}")
        return []

    results = r.json().get("results", [])
    paths = []
    for h in results:
        if len(paths) >= count:
            break
        ov_id = h.get("id")
        pid = f"openverse_img:{ov_id}"
        if pid in used_ids:
            continue
        if _is_adult_item(h.get("title"), h.get("creator"),
                          " ".join(t.get("name", "") for t in (h.get("tags") or []) if isinstance(t, dict))):
            continue
        img_url = h.get("url")  # full-res URL
        if not img_url:
            continue
        # Some Openverse sources return non-image URLs (PDFs etc) — skip them.
        ext = (h.get("filetype") or "jpg").lower()
        if ext not in ("jpg", "jpeg", "png", "webp"):
            continue
        dest = os.path.join(output_dir, f"openverse_img_{ov_id[:12]}.{ext}")
        log.info(f"Downloading Openverse image ({h.get('license')}, {h.get('source')})")
        if download_file(img_url, dest):
            paths.append(dest)
            used_ids.add(pid)
            _remember_clip(pid)
    return paths


def fetch_pixabay_music(query, output_dir):
    if not PIXABAY_KEY:
        return None

    url = "https://pixabay.com/api/"
    params = {"key": PIXABAY_KEY, "q": query, "media_type": "music",
              "per_page": 5, "safesearch": ("true" if _restrictions_on() else "false")}

    try:
        r = retry(
            lambda: requests.get(url, params=params, timeout=20),
            attempts=3, on=(requests.RequestException,), desc="pixabay-music",
        )
        r.raise_for_status()
        hits = r.json().get("hits", [])
        if not hits:
            return None
        # Random pick so we don't reuse the same track every run.
        random.shuffle(hits)
        for hit in hits:
            audio = hit.get("audio") or {}
            inner = audio.get("audio") or {}
            music_url = inner.get("url")
            if music_url:
                dest = os.path.join(output_dir, "background_music.mp3")
                return download_file(music_url, dest)
    except Exception as e:
        log.warning(f"Pixabay music fetch failed: {e}")
    return None


def fetch_openverse_music(query, output_dir):
    """
    Openverse: public CC0/CC music aggregator (Freesound, ccMixter, Wikimedia).
    No API key required. Filter to CC0 + 'sampling+' licenses (safe for monetized
    YouTube without attribution headaches).
    """
    url = "https://api.openverse.org/v1/audio/"
    params = {
        "q": query,
        "license": "cc0,pdm,by",
        "page_size": 8,
        "mature": ("false" if _restrictions_on() else "true"),
    }
    try:
        r = retry(
            lambda: requests.get(url, params=params, timeout=15),
            attempts=3, on=(requests.RequestException,), desc="openverse-music",
        )
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            return None
        random.shuffle(results)
        for hit in results:
            audio_url = hit.get("url")
            if not audio_url:
                continue
            # Pick a reasonable duration (>= 30s) so we have material to loop.
            dur_ms = hit.get("duration") or 0
            if dur_ms and dur_ms < 30_000:
                continue
            ext = (hit.get("filetype") or "mp3").lower()
            dest = os.path.join(output_dir, f"background_music.{ext}")
            log.info(f"Downloading Openverse music ({hit.get('license')}, {int(dur_ms/1000)}s)")
            path = download_file(audio_url, dest)
            if path:
                return path
    except Exception as e:
        log.warning(f"Openverse music fetch failed: {e}")
    return None


def get_music(query, output_dir):
    """Try Pixabay first, then Openverse as a no-key fallback."""
    return fetch_pixabay_music(query, output_dir) or fetch_openverse_music(query, output_dir)


def get_footage(channel_type, output_dir, sources_needed=8, extra_keywords=None,
                allow_images=None, premise=""):
    # If caller didn't override, read from settings.
    if allow_images is None:
        allow_images = bool(load_settings().get("video", {}).get("allow_images", True))
    """
    Fetch enough UNIQUE visual sources (video clips and/or images) to cover a
    voiceover without any source ever being shown twice. There is no hard cap:
    we keep widening the keyword pool and fall back to images if the video
    APIs don't return enough material.

    Returns:
        {
          "sources": [
            {"type": "video"|"image", "path": "...", "origin": "pexels|coverr|..."},
            ...
          ],
          "music": "<path>" | None,
        }
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    # Keyword pools come from settings.json so the GUI can edit them. Fall
    # back to module defaults if a channel isn't configured.
    pools = load_settings().get("keywords") or {}
    channel_pool = list(pools.get(channel_type) or FOOTAGE_KEYWORDS.get(channel_type, FOOTAGE_KEYWORDS["horror"]))
    random.shuffle(channel_pool)

    # Story-specific keywords (from the script) take priority.
    story_queries = []
    for kw in (extra_keywords or []):
        kw = (kw or "").strip()
        if kw and kw.lower() not in [q.lower() for q in story_queries]:
            story_queries.append(kw)

    # No upper bound on query breadth — we want as many distinct sources as
    # the providers will give us. We start with the story keywords, then add
    # the entire channel pool for variety.
    queries = list(story_queries)
    for kw in channel_pool:
        if kw.lower() not in [q.lower() for q in queries]:
            queries.append(kw)

    # Provider on/off toggles from settings.
    enabled = (load_settings().get("providers") or {})
    def ON(name):  # default True so brand-new providers don't silently break.
        return enabled.get(name, True)

    used_ids = set(_load_used_clips())
    sources = []                       # final list of {type, path, origin}
    seen_paths = set()                 # belt-and-braces dedup by local path
    origin_counts = {}

    def add(paths, origin, kind):
        for p in paths:
            if p in seen_paths:
                continue
            seen_paths.add(p)
            sources.append({"type": kind, "path": p, "origin": origin})
            origin_counts[origin] = origin_counts.get(origin, 0) + 1

    def need():
        return sources_needed - len(sources)

    # ── VIDEO PASSES ──────────────────────────────────────────
    # Master switch: when use_video_clips is off, skip every video provider
    # and let the pipeline run as a pure animated-stills montage.
    use_video = bool(load_settings().get("video", {}).get("use_video_clips", True))
    if use_video:
        if ON("pexels"):
            for q in queries:
                if need() <= 0:
                    break
                add(fetch_pexels_videos(q, output_dir, count=need(), used_ids=used_ids),
                    f"pexels:{q}", "video")

        if ON("coverr") and need() > 0:
            for q in queries:
                if need() <= 0:
                    break
                add(fetch_coverr_videos(q, output_dir, count=need(), used_ids=used_ids),
                    f"coverr:{q}", "video")

        if ON("pixabay") and need() > 0:
            for q in queries:
                if need() <= 0:
                    break
                add(fetch_pixabay_videos(q, output_dir, count=need(), used_ids=used_ids),
                    f"pixabay:{q}", "video")

        if ON("pexels") and need() > 0:
            add(fetch_pexels_popular(output_dir, count=need(), used_ids=used_ids),
                "pexels:popular", "video")
    else:
        log.info("Video clips disabled — using image sources only (animated stills mode)")

    # ── PREMIUM IMAGES (Shutterstock — vision-gated for quality) ─
    if ON("shutterstock") and allow_images and need() > 0:
        ss_fit = (
            "gothic horror, dread-soaked, decaying, victorian-gothic, "
            "candlelit, fog-shrouded, occult, supernatural, chilling"
            if channel_type == "horror" else
            "cinematic, professional photography, on-brand"
        )
        for q in queries:
            if need() <= 0:
                break
            add(fetch_shutterstock_images(
                    q, output_dir, count=need(), used_ids=used_ids,
                    fit_description=ss_fit, premise=premise,
                ),
                f"shutterstock:{q}", "image")

    # ── AI-GENERATED IMAGES (Pollinations, free) ──────────────
    # Run BEFORE the rest of the stock-image fallbacks so the visuals match
    # the story exactly (the LLM's keywords go straight into the image
    # prompt). Gated on settings.video.ai_image_count — default 0 means off.
    vid_cfg = load_settings().get("video", {})
    ai_quota = int(vid_cfg.get("ai_image_count", 0))
    if ON("pollinations") and allow_images and ai_quota > 0 and need() > 0:
        ai_style = vid_cfg.get("ai_image_style") or (
            "cinematic, atmospheric horror, low light, film grain, "
            "moody, shadowed, photoreal" if channel_type == "horror" else
            "cinematic, golden hour, professional photography, depth of field"
        )
        # Spread the quota across distinct keywords for visual variety.
        per_query = max(1, ai_quota // max(1, len(queries[:ai_quota])))
        generated = 0
        for q in queries:
            if generated >= ai_quota or need() <= 0:
                break
            new = fetch_pollinations_images(
                q, output_dir,
                count=min(per_query, ai_quota - generated, need()),
                used_ids=used_ids, style_suffix=ai_style,
            )
            if new:
                add(new, f"pollinations:{q}", "image")
                generated += len(new)

    # ── STOCK IMAGE FALLBACKS ────────────────────────────────
    if allow_images and ON("pexels") and need() > 0:
        for q in queries:
            if need() <= 0:
                break
            add(fetch_pexels_photos(q, output_dir, count=need(), used_ids=used_ids),
                f"pexels_img:{q}", "image")
    if allow_images and ON("pixabay") and need() > 0:
        for q in queries:
            if need() <= 0:
                break
            add(fetch_pixabay_photos(q, output_dir, count=need(), used_ids=used_ids),
                f"pixabay_img:{q}", "image")
    if allow_images and ON("openverse_image") and need() > 0:
        for q in queries:
            if need() <= 0:
                break
            add(fetch_openverse_images(q, output_dir, count=need(), used_ids=used_ids),
                f"openverse_img:{q}", "image")

    if not sources:
        log.error("No footage downloaded. Check API keys.")
    else:
        vid = sum(1 for s in sources if s["type"] == "video")
        img = sum(1 for s in sources if s["type"] == "image")
        log.info(f"Footage: {vid} videos + {img} images ({len(sources)} total). Origins: {origin_counts}")

    music_kw_map = load_settings().get("music_keywords") or {}
    music_query = music_kw_map.get(channel_type) or MUSIC_KEYWORDS.get(channel_type, "background music")
    music = get_music(music_query, output_dir)

    return {"sources": sources, "music": music}

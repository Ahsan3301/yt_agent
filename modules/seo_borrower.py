"""
seo_borrower.py — borrow title / description / tags from a viral YouTube
video on the same topic, lightly remix to preserve SEO weight while
staying compliant.

Why:
  YouTube's search ranking heavily favors titles + descriptions that
  match how viewers actually search. Our LLM-written titles read clean
  but often miss the exact phrases that drive watch-time on this topic.
  By searching YouTube for the top-performing recent video on the same
  topic and remixing its metadata, we ride its SEO signal without being
  a verbatim copy (which would risk YouTube's duplicate-content filters
  + viewer "I've seen this before" bounce).

How:
  1. yt_search(query) — YouTube Data API v3 'search.list' for the topic.
     Filter to last 90 days + min 50K views (configurable). Return top 3
     by view-count.
  2. fetch_metadata(video_ids) — videos.list to grab actual title /
     description / tags (search.list doesn't return tags).
  3. remix(meta, our_script) — keep the viral structure (front-loaded
     keywords, hashtags, hook line), substitute the SECOND-half phrasing
     with our LLM's version. Add 1-2 fresh tags from our script. Keep
     the # hashtags from the viral version verbatim.

API cost:
  - search.list: 100 units (same as 1 upload)
  - videos.list: 1 unit per id
  Default quota = 10,000 units/day; 1 SEO borrow = ~103 units.

Falls back to the script's own metadata if:
  - YouTube API key missing
  - No matching viral video found
  - API quota hit (logged, not raised)
"""
from __future__ import annotations
import logging
import re
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

log = logging.getLogger(__name__)


# Minimum views in the look-back window to count as "viral enough" to
# borrow from. Tuned for Shorts where 50K is solid mid-tail.
MIN_VIEWS = 50_000
LOOKBACK_DAYS = 90
TOP_N = 3


def _api_key() -> Optional[str]:
    """The YouTube Data API key — stored as a normal Firestore key
    alongside the other secrets, OR read from env for local dev."""
    k = os.getenv("YOUTUBE_API_KEY", "").strip()
    if k:
        return k
    try:
        # Lazy import to avoid forcing firestore on environments that
        # don't need this module (e.g. local dry-runs).
        from backend import keys
        k = keys.get("YOUTUBE_API_KEY") or ""
        return k.strip() or None
    except Exception:
        return None


def _http_get(url: str, params: dict) -> dict:
    """Single-purpose JSON GET. Standard requests dependency already
    installed via uploader.py."""
    import requests
    r = requests.get(url, params=params, timeout=15)
    if r.status_code == 403:
        # Quota exhausted or key revoked — treat as a soft failure.
        log.warning(f"YouTube API 403: {r.text[:200]}")
        return {}
    r.raise_for_status()
    return r.json()


def yt_search(query: str, max_results: int = 10) -> list[dict]:
    """Return search hits ordered by viewCount, filtered to recent Shorts.
    `query` is the topic — we'll also append " #shorts" to bias results."""
    key = _api_key()
    if not key:
        log.info("seo_borrower: no YOUTUBE_API_KEY configured")
        return []

    published_after = (
        datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    params = {
        "key": key,
        "part": "snippet",
        "q": query + " #shorts",
        "type": "video",
        "order": "viewCount",
        "publishedAfter": published_after,
        "maxResults": min(50, max_results),
        "videoDuration": "short",  # < 4 min — matches Shorts shape
        "relevanceLanguage": "en",
    }
    data = _http_get(
        "https://www.googleapis.com/youtube/v3/search",
        params=params,
    )
    items = data.get("items") or []
    return [
        {
            "video_id":   it["id"]["videoId"],
            "title":      it["snippet"]["title"],
            "channel":    it["snippet"]["channelTitle"],
            "published":  it["snippet"]["publishedAt"],
        }
        for it in items if it.get("id", {}).get("videoId")
    ]


def fetch_metadata(video_ids: list[str]) -> list[dict]:
    """videos.list to get title + description + tags + viewCount per id.
    Search.list doesn't return tags."""
    if not video_ids:
        return []
    key = _api_key()
    if not key:
        return []
    params = {
        "key": key,
        "id": ",".join(video_ids[:50]),
        "part": "snippet,statistics",
    }
    data = _http_get(
        "https://www.googleapis.com/youtube/v3/videos",
        params=params,
    )
    out = []
    for it in (data.get("items") or []):
        sn = it.get("snippet") or {}
        st = it.get("statistics") or {}
        out.append({
            "video_id":    it.get("id"),
            "title":       sn.get("title") or "",
            "description": sn.get("description") or "",
            "tags":        sn.get("tags") or [],
            "views":       int(st.get("viewCount") or 0),
        })
    return out


def find_viral(topic: str) -> Optional[dict]:
    """End-to-end: find the highest-viewed recent Shorts video matching
    the topic. Returns None if nothing meets MIN_VIEWS."""
    hits = yt_search(topic, max_results=10)
    if not hits:
        return None
    meta = fetch_metadata([h["video_id"] for h in hits[:TOP_N]])
    qualifying = [m for m in meta if m["views"] >= MIN_VIEWS]
    if not qualifying:
        log.info(
            f"seo_borrower: no Shorts past {MIN_VIEWS} views in last "
            f"{LOOKBACK_DAYS} days for topic={topic!r}"
        )
        return None
    qualifying.sort(key=lambda m: m["views"], reverse=True)
    winner = qualifying[0]
    log.info(
        f"seo_borrower: borrowing from {winner['video_id']} "
        f"({winner['views']:,} views) — title: {winner['title'][:60]!r}"
    )
    return winner


# Phrases that have to be tweaked or they read as obvious copies.
# Picked from "Top 5 things you didn't know" / "POV:" / "When X happens"
# patterns common in viral Shorts — kept as a curated list rather than
# regexed because the goal is FREQUENCY-MATCHED variation, not removal.
_HOOK_REPLACEMENTS = [
    (r"\bdid you know\b",          ["here's what nobody tells you", "this will surprise you"]),
    (r"\bPOV:\s*",                 ["What happens when ", "Watch what happens when "]),
    (r"\bwhen X happens\b",        ["when this happens", "the moment this happens"]),
    (r"\bI tried\b",               ["This person tried", "What happens when you try"]),
    (r"\byou won't believe\b",     ["you have to see", "the wildest part is"]),
]


def _light_remix_title(viral_title: str, our_title: str) -> str:
    """Keep the viral structure (length, emojis, hashtags) but swap a
    handful of trigger phrases for fresher equivalents. If the viral
    title is already < 30 chars or all-emoji, fall back to our title
    (those are usually channel-specific brand titles, not topic SEO)."""
    if len(viral_title) < 30:
        return our_title[:100]
    out = viral_title
    for pattern, replacements in _HOOK_REPLACEMENTS:
        if re.search(pattern, out, flags=re.I):
            # Pick one rotation slot — for now the first; future work can
            # use a hash of our_title to vary deterministically.
            out = re.sub(pattern, replacements[0], out, count=1, flags=re.I)
    # Add a freshness token at the end if neither title has hashtags.
    if "#" not in out and "#" in our_title:
        out += " " + " ".join(re.findall(r"#\w+", our_title))[:30]
    return out[:100]


def _light_remix_description(viral_desc: str, our_desc: str) -> str:
    """First line of the viral description (the all-important first ~150
    chars YouTube indexes) stays. Body gets OUR script's description for
    freshness. Hashtags block at the end of the viral desc gets preserved
    + augmented with any new ones from our_desc."""
    if not viral_desc:
        return our_desc[:5000]
    viral_lines = viral_desc.splitlines()
    viral_first = viral_lines[0].strip() if viral_lines else ""
    # Hashtags block — typically a line of #s near the end.
    viral_hashtags = set(re.findall(r"#\w+", viral_desc))
    our_hashtags   = set(re.findall(r"#\w+", our_desc))
    combined_hashtags = viral_hashtags | our_hashtags
    parts = [
        viral_first,
        "",
        our_desc.strip(),
    ]
    if combined_hashtags:
        parts.append("")
        parts.append(" ".join(sorted(combined_hashtags))[:200])
    return "\n".join(parts)[:5000]


def _merge_tags(viral_tags: list[str], our_tags: list[str]) -> list[str]:
    """Viral tags first (preserve YouTube's existing topic graph
    association), then OUR script's tags (channel/freshness signal),
    deduped case-insensitively. Cap at 30 — YouTube allows ~500 chars
    of tags total, ~30 short tags fit comfortably."""
    seen = set()
    out: list[str] = []
    for t in list(viral_tags) + list(our_tags):
        if not t:
            continue
        key = t.lower().strip()
        if key in seen or len(out) >= 30:
            continue
        seen.add(key)
        out.append(t.strip()[:50])
    return out


def borrow_seo(topic: str, script_data: dict) -> dict:
    """Public entry point. Given a topic + the LLM's draft metadata,
    returns a NEW script_data dict with title/description/tags remixed
    from the top viral Shorts video on that topic.

    Falls back to the original script_data on any failure.
    """
    if not topic or not isinstance(script_data, dict):
        return script_data
    try:
        viral = find_viral(topic)
    except Exception as e:
        log.warning(f"seo_borrower failed (returning original): {e}")
        return script_data
    if not viral:
        return script_data

    out = dict(script_data)
    out["youtube_title"] = _light_remix_title(
        viral["title"], script_data.get("youtube_title") or "",
    )
    out["description"] = _light_remix_description(
        viral["description"], script_data.get("description") or "",
    )
    out["tags"] = _merge_tags(
        viral.get("tags") or [],
        script_data.get("tags") or [],
    )
    out["_seo_borrowed_from"] = {
        "video_id": viral["video_id"],
        "views":    viral["views"],
        "title":    viral["title"],
    }
    return out

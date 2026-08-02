"""
performance.py — feed a channel's OWN results back into what it writes next.

Why this exists
---------------
The pipeline published videos and never looked at them again. Every
title was written from first principles, as if the channel had no
history, when in fact the history is the single most relevant signal
available: on 2026-08-02 one upload had 600 views and 17 likes while a
sibling published the same night had 1 view. Same pipeline, same
channel, 500x apart — and nothing in the system noticed.

Competitor titles (seo_borrower) are useful but weaker: they come from
a different channel with a different audience. A title that worked on
THIS channel worked on this channel's actual viewers.

Deliberately conservative
-------------------------
Small samples lie. A video's view count is dominated by how long it has
been up and by YouTube's own distribution lottery, not just by its
title. So this module:

  * refuses to report anything until MIN_SAMPLE videos have stats,
  * ignores videos younger than MIN_AGE_HOURS, which have not had time
    to accumulate views and would otherwise always look like failures,
  * only returns titles that beat the channel's own median, so "what
    worked" means "better than this channel's normal", not "the least
    bad of three",
  * returns view counts alongside the titles so the writer — and anyone
    reading a prompt dump — can see the evidence rather than trusting
    a claim of "top performing".
"""
from __future__ import annotations
import logging
import time
from typing import Optional

log = logging.getLogger(__name__)

# Below this many measured videos, "top performers" is noise.
MIN_SAMPLE = 5
# A video needs time on the platform before its view count means
# anything. Anything fresher is excluded from BOTH the median and the
# winners, so a batch published an hour ago cannot drag the bar down.
MIN_AGE_HOURS = 48
# How many winners to hand the writer. More than a handful stops being
# a signal and starts being the whole back catalogue.
TOP_N = 5


def _rows_for(niche: str) -> list[dict]:
    """runs_index rows for one niche that have real, settled stats."""
    try:
        from backend import runs_db
        rows = runs_db.list_index(limit=500) or []
    except Exception as e:
        log.debug(f"performance: runs_index unavailable: {e}")
        return []

    cutoff = time.time() - MIN_AGE_HOURS * 3600
    out = []
    for r in rows:
        if niche and str(r.get("channel") or "").strip().lower() != niche.strip().lower():
            continue
        if not r.get("youtube_video_id"):
            continue
        views = r.get("view_count")
        if views is None:
            continue                      # never measured
        title = str(r.get("title") or "").strip()
        if not title:
            continue                      # nothing to learn from
        fin = r.get("published_at") or r.get("finished_at") or 0
        try:
            fin = float(fin)
        except Exception:
            fin = 0.0
        if fin and fin > cutoff:
            continue                      # too fresh to judge
        out.append({"title": title, "views": int(views), "at": fin})
    return out


def top_titles(niche: str) -> list[dict]:
    """This channel's above-median titles, best first.

    Returns [] when there is not enough evidence — an empty list is the
    honest answer to "what works here" on a young channel, and the
    caller simply omits the section rather than inventing guidance.
    """
    rows = _rows_for(niche)
    if len(rows) < MIN_SAMPLE:
        log.info(
            "performance: only %d settled video(s) for niche=%r — need %d "
            "before past results mean anything",
            len(rows), niche, MIN_SAMPLE,
        )
        return []

    views = sorted(r["views"] for r in rows)
    mid = len(views) // 2
    median = views[mid] if len(views) % 2 else (views[mid - 1] + views[mid]) / 2

    winners = [r for r in rows if r["views"] > median]
    winners.sort(key=lambda r: r["views"], reverse=True)
    log.info(
        "performance: niche=%r sample=%d median=%.0f views, %d above-median title(s)",
        niche, len(rows), median, len(winners),
    )
    return winners[:TOP_N]


def summary_for_prompt(niche: str) -> Optional[str]:
    """A prompt block describing what has actually worked, or None.

    None rather than an empty string so the caller can skip the section
    entirely — an empty heading reads as "nothing works here", which is
    not what a small sample means.
    """
    winners = top_titles(niche)
    if not winners:
        return None
    lines = "\n".join(
        f"- {w['title']}  ({w['views']:,} views)" for w in winners
    )
    return (
        "TITLES THAT ACTUALLY PERFORMED ON THIS CHANNEL (real view counts, "
        "not guesses). These beat this channel's own median, so they reflect "
        "what its real audience clicks. Study what they have in common — the "
        "specificity, the kind of hook, the sentence shape — and apply that "
        "pattern to the new title. Do NOT reuse their wording or their "
        "subject:\n" + lines
    )

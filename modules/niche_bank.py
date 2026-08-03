"""
niche_bank.py — read the accumulated niche keyword bank on the worker.

The daily niche-intel sweep (web/app/api/maintenance/niche-intel) pools
what is currently ranking in each niche: which tags the winners share,
and how their titles are shaped. That data was being collected and
never read, which is the same shape of waste as an API key nobody wires
up.

This is the read side. It gives the SEO writer the keywords a niche's
top performers ACTUALLY rank for, pooled over weeks rather than the
three competitor videos a single render can afford to look up.

Fails quiet and returns nothing when the bank is thin — an empty list
is the honest answer before enough sweeps have run, and the writer
simply omits the section.
"""
from __future__ import annotations
import json
import logging

log = logging.getLogger(__name__)

# Below this many observed videos the tag counts are one or two
# uploaders' habits rather than a property of the niche.
MIN_SAMPLE = 60


def _row(niche: str) -> dict:
    try:
        from backend import db
        if not db.is_configured():
            return {}
        snap = db.client().collection("niche_intel").document(niche.strip().lower()).get()
        if not snap.exists:
            return {}
        return snap.to_dict() or {}
    except Exception as e:
        log.debug(f"niche_bank: read failed for {niche!r}: {e}")
        return {}


def _as_obj(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return {}
    return v if isinstance(v, dict) else {}


def top_tags(niche: str, limit: int = 25) -> list[str]:
    """Tags shared by the niche's current top performers, most-common
    first. [] when the sample is too small to mean anything."""
    d = _row(niche)
    if not d:
        return []
    sample = int(d.get("sample_size") or 0)
    if sample < MIN_SAMPLE:
        log.info(
            "niche_bank: %r has only %d observed video(s) — need %d before "
            "its tags are worth borrowing", niche, sample, MIN_SAMPLE,
        )
        return []
    counts = _as_obj(d.get("tag_counts"))
    if not counts:
        return []
    ranked = sorted(counts.items(), key=lambda kv: (-int(kv[1] or 0), kv[0]))
    out = [t for t, _ in ranked[:limit]]
    log.info("niche_bank: %r contributing %d proven tag(s) from %d video(s)",
             niche, len(out), sample)
    return out

"""
researcher.py — Content Research Module

Horror: generates an original story premise by combining a random setting +
        hook (no Reddit, no network dependency at all). scriptwriter.py then
        has NIM/Groq/OpenRouter expand that premise into a full nosleep-style
        narration. Used combos are tracked per (niche, language) in
        data/used_premises_<niche>_<lang>.json so an English channel and a
        German channel don't fight over the same pool.

        Additionally, on every call we seed the used-set from PocketBase
        runs_index (recent titles for the same channel niche+language) so
        the pool survives ephemeral-worker reboots (Kaggle, Colab). Without
        that seeding, a fresh Kaggle boot would start with an empty local
        file and re-pick premises already published elsewhere.

Wisdom / generic niches: uses `_generic_research` which asks NIM for a
        one-sentence topic. If NIM times out (very common under quota),
        the fallback picks a RANDOM footage keyword plus a random flavor
        modifier so successive fallbacks don't return the same string.
"""

import os
import json
import random
import logging
import re
import feedparser
from pytrends.request import TrendReq
from dotenv import load_dotenv

from modules.config import load_settings

# filelock: cross-platform file locks. Used to serialise the
# read-modify-write cycle on used_premises files so two concurrent
# renders on the same worker (Oracle typically) can't pick the same
# combo. Cross-worker races (Kaggle + Oracle rendering at the same
# time) are separately mitigated by the PB-seed in _load_used.
# Import guarded — a worker without filelock installed just skips the
# lock (returns to pre-audit behaviour, which is "usually fine" given
# the 225-combo pool). Ships in requirements.txt >= 3.12.
try:
    from filelock import FileLock, Timeout as _FileLockTimeout
    _HAS_FILELOCK = True
except Exception:
    _HAS_FILELOCK = False
    _FileLockTimeout = Exception  # type: ignore

load_dotenv()
log = logging.getLogger(__name__)

USED_PREMISES_DIR = "data"


def _used_file(niche: str, language: str) -> str:
    """Per (niche, language) file so an English horror channel and a
    German horror channel don't fight over the same pool. Slugified to
    survive weird channel niche names typed by users."""
    slug_n = re.sub(r"[^a-z0-9]+", "_", (niche or "generic").lower()).strip("_") or "generic"
    slug_l = re.sub(r"[^a-z0-9]+", "_", (language or "en").lower()).strip("_") or "en"
    return os.path.join(USED_PREMISES_DIR, f"used_premises_{slug_n}_{slug_l}.json")


HORROR_SETTINGS = [
    "an abandoned summer camp deep in the woods",
    "a 24-hour gas station off a remote highway",
    "a college dorm during finals week",
    "a rural farmhouse inherited from a relative",
    "an apartment building where one neighbor has never been seen",
    "a hiking trail that was officially closed years ago",
    "a hospital during the overnight shift",
    "a small town with only one road in and out",
    "a last-minute Airbnb booking in an unfamiliar city",
    "a basement that isn't on the house's original blueprints",
    "a long-haul overnight bus route",
    "an old elevator in a building that's mostly empty after 6pm",
    "a childhood home revisited after years away",
    "a campsite at a lake with a local legend attached to it",
    "a babysitting job in an unfamiliar neighborhood",
]

HORROR_HOOKS = [
    "a knocking sound that happens at the exact same time every night",
    "a figure in the distance that mimics every move you make",
    "text messages arriving from your own phone number",
    "a door that locks itself from the inside",
    "the same stranger appearing in the background of every photo taken that day",
    "a voice on the phone that sounds exactly like someone who already died",
    "footsteps that match yours, one step behind, even when you stop",
    "a neighbor who insists they've met you before, somewhere you've never been",
    "an object that keeps returning to the same spot no matter how many times it's thrown away",
    "a video call that keeps cutting back to a frame of someone standing perfectly still, watching",
    "a smell that only appears right before something happens",
    "a reflection that takes a half-second too long to copy your movement",
    "handwriting in a journal that isn't yours, describing your day before it happens",
    "a power outage that only ever affects one specific room",
    "a song playing faintly from somewhere with no speakers nearby",
]

# Random flavor modifiers appended to the fallback keyword so successive
# NIM-timeout fallbacks don't return identical topic strings. Non-horror
# niches previously always returned `footage_keywords[0]` — the German
# language rendered videos on 3 consecutive days with the exact same
# script because of this.
GENERIC_FALLBACK_FLAVORS = [
    "explained in 60 seconds",
    "you probably didn't know",
    "hidden history",
    "surprising origins",
    "quick facts",
    "one strange fact",
    "the untold story",
    "misunderstood truth",
    "one lesson",
    "an unexpected angle",
    "what most people miss",
    "why it matters today",
]


def _load_used(niche: str, language: str) -> set:
    path = _used_file(niche, language)
    used: set = set()
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                data = json.load(f)
            if isinstance(data, list):
                used = set(data)
        except (json.JSONDecodeError, OSError) as e:
            log.warning(f"{path} unreadable ({e}); starting fresh")

    # Seed from PocketBase / Firestore so the pool survives ephemeral
    # worker reboots. If we're on Kaggle and the local file was wiped
    # by a fresh git clone, this pulls the recently-published titles
    # for this (niche, language) so we don't re-pick a premise that's
    # already live on YouTube. Best-effort — swallow any failure.
    try:
        seeded = _seed_from_db(niche, language, limit=30)
        if seeded:
            used |= seeded
    except Exception as e:
        log.debug(f"_load_used: DB seed skipped ({e})")

    return used


def _seed_from_db(niche: str, language: str, limit: int = 30) -> set:
    """Read recent runs_index entries and return the set of PREMISE-KEYS
    matching this channel niche+language. Premise-key is the same
    "setting|hook" tuple stored by _save_used, extracted from the
    completed run's summary payload where available.

    Returns an empty set if the DB is unreachable, if no runs match,
    or if the summaries don't expose a premise field (older runs). The
    fallback is safe — we just get slightly weaker dedup, not corrupted
    behavior."""
    seeded: set = set()
    try:
        from backend import runs_db
    except Exception:
        return seeded
    try:
        idx = runs_db.list_index(limit=limit * 4) or []
    except Exception:
        return seeded
    lang = (language or "en").lower()
    for row in idx[:limit]:
        try:
            if not row.get("ok"):
                continue
            row_channel = str(row.get("channel") or "").lower()
            if niche and row_channel and row_channel != niche.lower():
                continue
            summary = None
            try:
                summary = runs_db.fetch_summary(row.get("run_id") or "")
            except Exception:
                summary = None
            if not isinstance(summary, dict):
                continue
            row_lang = str(summary.get("language") or "en").lower()[:2]
            if row_lang != lang:
                continue
            # Prefer explicit premise key when the run stored one. Falls
            # back to raw_title / topic if the older run didn't. Both
            # get added — cheap and belt-and-braces.
            for key in ("premise_key", "premise", "raw_title", "topic", "title"):
                v = summary.get(key)
                if isinstance(v, str) and v.strip():
                    seeded.add(v.strip())
        except Exception:
            continue
    return seeded


class _NullLock:
    """No-op context manager used when filelock isn't installed. Keeps
    the with-statement shape identical so callers don't branch on
    _HAS_FILELOCK."""
    def __enter__(self):  return self
    def __exit__(self, *a): return False


def _lock_for(niche: str, language: str, timeout: float = 30.0):
    """Return a file-lock context manager guarding the used_premises file
    for (niche, language). Waits up to `timeout` sec for the lock; if
    it times out, returns a no-op lock and logs — better to risk a rare
    race than block the whole pipeline. Falls back to no-op on workers
    without filelock installed."""
    if not _HAS_FILELOCK:
        return _NullLock()
    path = _used_file(niche, language)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lock_path = path + ".lock"
    try:
        return FileLock(lock_path, timeout=timeout)
    except Exception as e:
        log.debug(f"_lock_for({niche}, {language}) failed to construct: {e}")
        return _NullLock()


def _write_used_file(path: str, used: set) -> None:
    """Atomic write: temp file + replace, so a crash mid-write can't
    corrupt the file. Caller is responsible for holding the lock."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(list(used), f)
    os.replace(tmp, path)


def _save_used(combo_id: str, niche: str, language: str):
    """Convenience: load + add + save, all under the file lock. Kept for
    call sites that don't already hold the lock (the tone/topic paths).
    generate_horror_premise + _generic_research pick and reserve inside
    the SAME lock to prevent two concurrent workers on the same
    filesystem from picking the identical combo (audit fix #9)."""
    lock = _lock_for(niche, language)
    try:
        with lock:
            path = _used_file(niche, language)
            used = _load_used(niche, language)
            used.add(combo_id)
            _write_used_file(path, used)
    except _FileLockTimeout:
        # Lock contention timeout — proceed WITHOUT the lock rather
        # than fail the whole render. Worst case is a single duplicate
        # premise, not a broken pipeline.
        log.warning(f"_save_used({niche}/{language}): lock timeout — writing unguarded")
        path = _used_file(niche, language)
        used = _load_used(niche, language)
        used.add(combo_id)
        _write_used_file(path, used)


def generate_horror_premise(language: str = "en") -> tuple[str, str]:
    """Combines a random setting + hook. Language-scoped dedup so
    English horror and German horror have separate pools.

    Returns (premise_text, premise_key). The key is the stable
    "setting|hook" tuple — scriptwriter should stash it on the run
    summary as `premise_key` so future DB-seed reads can pick it up.

    Load + pick + save happens under a single per-(niche, language)
    file lock (audit fix #9). Two concurrent workers on the same
    filesystem can no longer pick the identical combo through a TOCTOU
    race in the read-modify-write cycle.
    """
    lock = _lock_for("horror", language)
    all_combos = [(s, h) for s in HORROR_SETTINGS for h in HORROR_HOOKS]
    try:
        with lock:
            path = _used_file("horror", language)
            used = _load_used("horror", language)
            unused = [c for c in all_combos if f"{c[0]}|{c[1]}" not in used]
            if not unused:
                log.info(f"All horror premise combinations used for lang={language!r} — resetting pool")
                unused = all_combos
            setting, hook = random.choice(unused)
            key = f"{setting}|{hook}"
            used.add(key)
            _write_used_file(path, used)
    except _FileLockTimeout:
        # Lock contention (rare — normally < 30 ms). Fall through to a
        # lock-free pick; the DB seed on the next call will re-dedup.
        log.warning(f"horror premise pick: lock timeout for lang={language!r} — picking unguarded")
        used = _load_used("horror", language)
        unused = [c for c in all_combos if f"{c[0]}|{c[1]}" not in used]
        if not unused:
            unused = all_combos
        setting, hook = random.choice(unused)
        key = f"{setting}|{hook}"
        _save_used(key, "horror", language)

    return f"Someone experiences {hook}, while at {setting}.", key


def get_trending_topics():
    """
    Get trending topics from Google Trends for the wisdom niche.
    Returns list of topic strings.
    """
    try:
        pt = TrendReq(hl="en-US", tz=360)
        trending_df = pt.trending_searches(pn="united_states")
        topics = trending_df[0].tolist()[:10]
        log.info(f"Got {len(topics)} trending topics")
        return topics
    except Exception as e:
        log.warning(f"Pytrends failed: {e}")
        return []


def get_rss_topics(feeds=None):
    """
    Pull recent headlines from RSS feeds.
    Returns list of topic strings.
    """
    if feeds is None:
        feeds = [
            "https://feeds.feedburner.com/TechCrunch",
            "https://rss.cnn.com/rss/edition.rss",
        ]
    topics = []
    for url in feeds:
        try:
            parsed = feedparser.parse(url)
            for entry in parsed.entries[:5]:
                topics.append(entry.get("title", ""))
        except Exception as e:
            log.warning(f"RSS feed failed ({url}): {e}")
    return [t for t in topics if t]


def research(channel_type: str, language: str = "en"):
    """
    Main entry point. Returns a content dict ready for the script writer.
    channel_type: any channel niche name (horror / wisdom / science / ...).
    language:     ISO-2 code. Used to scope premise dedup so an English
                  channel and a German channel with the same niche don't
                  step on each other's used-pool. Also passed through to
                  the generic fallback so its LLM prompt has language
                  awareness.

    If settings.content.manual_premise is set, it overrides the auto-
    generated premise (so users can run a specific story idea from
    the GUI).
    """
    lang = (language or "en").lower()[:2]

    manual = (load_settings().get("content") or {}).get("manual_premise", "").strip()
    if manual:
        # This global override forces the SAME premise across EVERY
        # channel + language on every render. Flagged as HIGH-4 in the
        # 2026-07-13 audit — the /settings knob can silently make all
        # channels publish the same script if set and forgotten. Loud
        # WARNING so the operator sees it in the log stream every time.
        log.warning(
            f"⚠️  GLOBAL manual_premise from /settings is overriding "
            f"channel={channel_type!r} lang={lang!r} auto-research. "
            f"Premise={manual[:80]!r}. Clear settings.content.manual_premise "
            f"if you want per-channel auto-generated premises back."
        )
        return {
            "type": channel_type,
            "raw_title": manual,
            "raw_body": "",
            "source_url": "",
            "keywords": [channel_type, "manual override"],
            "language": lang,
            "premise_key": manual[:200],
        }

    if channel_type == "horror":
        premise, key = generate_horror_premise(language=lang)
        return {
            "type": "horror",
            "raw_title": premise,
            "raw_body": "",
            "source_url": "",
            "keywords": ["horror", "scary story", "creepy", "true horror"],
            "language": lang,
            "premise_key": key,
        }

    elif channel_type == "wisdom":
        topics = get_trending_topics() or get_rss_topics()
        if not topics:
            topics = ["life lessons", "mindset", "productivity"]
        # Shuffle so we don't pick the same trend twice in a row on a
        # slow news day — same fix as the generic path.
        random.shuffle(topics)
        chosen = topics[0]
        return {
            "type": "wisdom",
            "raw_title": chosen,
            "raw_body": "",
            "source_url": "",
            "keywords": topics[:5],
            "language": lang,
            "premise_key": chosen[:200],
        }

    return _generic_research(channel_type, language=lang)


def _generic_research(channel_type: str, language: str = "en") -> dict | None:
    """LLM-suggest a topic for an arbitrary channel, using the niche's
    own tone + visual style as context.

    On NIM failure the fallback used to be `footage_keywords[0]` —
    always the FIRST keyword — which meant on any NIM-quota day, every
    render on this niche returned the identical topic string.
    Confirmed live 2026-07-11: a German-language channel published 3
    videos with the same script because of this. New behavior:
      - Pool: NIM-live topics accumulate in a per-(niche, language)
        used-set. Successive calls pick a fresh topic each time.
      - Fallback (NIM down): random footage_keyword + random flavor
        modifier. Language-aware — the fallback text is stamped
        with the target language so scriptwriter still writes in
        the right language.
    """
    lang = (language or "en").lower()[:2]
    try:
        from modules import channels as _ch, nim as _nim
        cfg = _ch.get_channel(channel_type)

        # Seed the used-set so a Kaggle re-boot doesn't re-pick a topic
        # already published on YouTube.
        used = _load_used(channel_type, lang)
        recent_hint = ""
        if used:
            # Cap to a compact list — LLM doesn't need 200 titles, 8 is enough.
            sample = list(used)[-8:]
            recent_hint = (
                f"\n\nRECENTLY USED (do NOT pick anything close to these):\n  - "
                + "\n  - ".join(sample[:8])
            )

        prompt = (
            f"Suggest ONE specific, surprising topic for a 60-second YouTube Short "
            f"on the {cfg.get('display_name') or channel_type} channel.\n\n"
            f"Channel tone: {cfg.get('tone')}\n"
            f"Hook style: {cfg.get('hook_style')}\n"
            f"Language of the finished video: {lang}\n\n"
            f"Reply with ONLY the topic — one short sentence, no preamble, no markdown. "
            f"Make it concrete enough that a scriptwriter could write 200 words about it. "
            f"Pick something fresh — avoid the obvious top-of-mind subject for this niche."
            f"{recent_hint}"
        )
        premise = ""
        try:
            raw = _nim.chat(
                messages=[{"role": "user", "content": prompt}],
                model="meta/llama-3.3-70b-instruct",
                max_tokens=200,
                temperature=0.9,
                stream=False,
                timeout=90,
                attempts=1,
            )
            cleaned = (raw or "").strip().strip('"').strip()
            cleaned = cleaned.split("\n")[0][:280].strip()
            if len(cleaned) < 20 or cleaned.count(":") > 1 or cleaned.count(". ") > 3:
                log.warning(
                    f"researcher: rejecting garbled NIM topic {cleaned!r} "
                    f"(short/colon-soup — likely reasoning fragment)"
                )
                cleaned = ""
            # Reject collisions with recent topics.
            if cleaned and cleaned in used:
                log.warning(
                    f"researcher: NIM returned a topic we already published "
                    f"({cleaned[:60]!r}); forcing keyword fallback for variety"
                )
                cleaned = ""
            premise = cleaned
        except Exception as e:
            log.warning(f"researcher._generic_research: NIM call failed ({e})")

        if not premise:
            # RANDOMIZED fallback: pick a random footage keyword AND
            # a random flavor modifier so 3 consecutive NIM-timeout
            # renders don't publish the same script.
            kws = list(cfg.get("footage_keywords") or [])
            if not kws:
                kws = [channel_type]
            # Bias picks toward keywords we haven't used yet.
            unused_kws = [k for k in kws if f"kw:{k}" not in used] or kws
            base = random.choice(unused_kws)
            flavor = random.choice(GENERIC_FALLBACK_FLAVORS)
            premise = f"{base} — {flavor}"
            # Save the KEYWORD key so subsequent fallbacks avoid this one.
            _save_used(f"kw:{base}", channel_type, lang)
            log.warning(
                f"researcher._generic_research: NIM path unavailable — "
                f"randomized keyword fallback: {premise!r}"
            )
        else:
            _save_used(premise, channel_type, lang)
            log.info(f"researcher._generic_research: NIM-suggested topic: {premise!r}")

        return {
            "type":       channel_type,
            "raw_title":  premise,
            "raw_body":   "",
            "source_url": "",
            "keywords":   (cfg.get("footage_keywords") or [])[:5],
            "language":   lang,
            "premise_key": premise[:200],
        }
    except Exception as e:
        log.error(f"researcher._generic_research crashed for {channel_type}: {e}")
        # Absolute last-resort fallback. Still randomized so an infinite
        # crash-loop doesn't publish the same script forever.
        seed_terms = [channel_type, "explained", "hidden facts", "what to know", "quick guide"]
        random.shuffle(seed_terms)
        return {
            "type":       channel_type,
            "raw_title":  f"{seed_terms[0]}: {seed_terms[1]}",
            "raw_body":   "",
            "source_url": "",
            "keywords":   [channel_type],
            "language":   lang,
            "premise_key": f"crash:{seed_terms[0]}",
        }

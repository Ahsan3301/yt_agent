"""Boot-time capability self-check.

Every expensive bug in this pipeline has been the same shape: a
capability that is silently dead while appearing configured. Agnes was
disabled on every render ever because a "no override" branch popped the
API key. Playwright was absent on the worker that serves most renders,
so research logged one debug line and did nothing. Both motion providers
read shot keys that do not exist, so Agnes video had never once run. The
publish deferral keyed on a tier value that lies on Oracle.

None of these raised. They were found by burning renders and reading
logs afterwards, which is the expensive way.

The common property is that the failure is only visible at the
CONSUMER's read path — a key holding a value proves nothing, because the
consumer may read a different row, a different env var, or a field that
was never written. So this module probes the way the consumer does, at
boot, and shouts when a capability that is supposed to be on is off.

It never raises. A self-check that can take down a worker is worse than
the bugs it finds. Everything is reported at ERROR (dead) or WARNING
(degraded) and the caller decides.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

# Narration speed of the niche voices, measured with ffprobe on real
# edge-tts renders. Every word-budget decision derives from this.
#
# 2.02, not the earlier 2.26, because PUNCTUATION DENSITY dominates this
# number and the scriptwriter's style changed. Same voice, same 30s cap,
# measured back to back:
#
#     flowing prose, few full stops   66 words / 19.1s = 3.46 w/s
#     clipped, many full stops        57 words / 28.2s = 2.02 w/s
#
# The prompt now REQUIRES short sentences and full stops over commas —
# that is what stops edge-tts sounding monotone, since it takes all its
# pacing from punctuation. Every full stop buys a pause. So the fix for
# the flat voiceover directly slowed delivery, and a budget carried over
# from the old style overran the cap by ~3s and got its ending trimmed.
#
# If the script style changes again, RE-MEASURE. Do not carry this
# number forward.
_WORDS_PER_SEC = 2.02

# (label, callable) -> (ok: bool, detail: str)
# Each probe returns a two-tuple. A probe that throws is reported as
# dead with the exception text, never propagated.
_PROBES = []


def probe(label: str, critical: bool = False):
    """Register a capability probe. `critical` ones log at ERROR."""
    def _wrap(fn):
        _PROBES.append((label, fn, critical))
        return fn
    return _wrap


@probe("browser research (playwright)", critical=False)
def _check_playwright():
    from modules import browser_agent
    if browser_agent.is_available():
        return True, "chromium launches"
    # is_available() launches and closes a real browser, so a missing
    # shared library reports the same as a missing package. Say which.
    try:
        import playwright  # noqa: F401
        return False, ("playwright installed but chromium will not launch — "
                       "run `python -m playwright install --with-deps chromium`. "
                       "If this appeared after a container recreate, the image "
                       "is missing the install step.")
    except ImportError:
        return False, "playwright not installed — research silently does nothing"


@probe("LLM chain", critical=True)
def _check_llm():
    from modules import nim
    order = (os.getenv("LLM_PRIORITY", "") or "").strip()
    if not order:
        return False, ("LLM_PRIORITY is empty — a caller popped it. Pooled "
                       "provider order is wiped for this render.")
    live = []
    for name in [p.strip() for p in order.split(",") if p.strip()]:
        env = {"agnes": "AGNES_API_KEY", "groq": "GROQ_API_KEY",
               "openrouter": "OPENROUTER_API_KEY", "nim": "NIM_API_KEY"}.get(name)
        if env and (os.getenv(env) or "").strip():
            live.append(name)
    if not live:
        return False, f"priority is {order!r} but not one provider has a key"
    if live[0] != order.split(",")[0].strip():
        return True, (f"DEGRADED: primary {order.split(',')[0].strip()!r} has no "
                      f"key; first live provider is {live[0]!r}")
    return True, f"{len(live)} provider(s) keyed, primary={live[0]}"


@probe("Agnes (text/image/video primary)", critical=False)
def _check_agnes():
    if not (os.getenv("AGNES_API_KEY") or "").strip():
        return False, ("AGNES_API_KEY absent. If the channel's agnes_source is "
                       "not 'off', a caller popped it — this is the bug class "
                       "that disabled Agnes on every render.")
    return True, f"keyed, timeout={os.getenv('AGNES_TIMEOUT_SECONDS', '150')}s"


@probe("word budget vs video length", critical=False)
def _check_word_budget():
    from modules import config
    c = config.load_settings().get("content", {}) or {}
    wmin, wmax = c.get("target_word_min"), c.get("target_word_max")
    if not wmin or not wmax:
        return True, "unset — provider defaults apply"
    # See _WORDS_PER_SEC above for how that number was measured and why
    # it moved twice. Both directions have now bitten: too low made
    # scripts a third shorter than the slot, too high overran the cap and
    # got the ending trimmed. This probe checks BOTH.
    cap = float(os.getenv("MAX_VIDEO_SECONDS", "30") or 30)
    worst_words = round(wmax * 1.12)
    worst_secs = worst_words / _WORDS_PER_SEC
    if worst_secs > cap:
        return False, (f"target {wmin}-{wmax} words -> worst case {worst_words} "
                       f"words = {worst_secs:.1f}s against a {cap:.0f}s cap. The "
                       f"editor will trim the ending off every render. Lower "
                       f"target_word_max to <= {int(cap * _WORDS_PER_SEC / 1.12)}.")
    typical = wmax / _WORDS_PER_SEC
    if typical < cap * 0.75:
        return True, (f"DEGRADED: a full {wmax}-word script runs only "
                      f"{typical:.1f}s in a {cap:.0f}s slot — {cap - typical:.0f}s "
                      f"of the video carries no narration. Raise target_word_max "
                      f"toward {int(cap * _WORDS_PER_SEC / 1.12)}.")
    return True, f"{wmin}-{wmax} words -> worst case {worst_secs:.1f}s (cap {cap:.0f}s)"


@probe("YouTube research quota", critical=False)
def _check_yt_keys():
    from modules import seo_borrower as sb
    keys = sb._api_keys()
    if not keys:
        return False, "no YOUTUBE_API_KEY — topic research falls back to the pool"
    spent = len(getattr(sb, "_SPENT_KEYS", set()))
    if spent >= len(keys):
        return False, (f"all {len(keys)} key(s) quota-spent this process — topics "
                       f"come from the pool until midnight Pacific. Add another "
                       f"key (YOUTUBE_API_KEY accepts a comma-separated list).")
    if len(keys) == 1:
        return True, ("1 key — the daily search quota is per-key, so one heavy "
                      "day takes research down entirely. A second key doubles it.")
    return True, f"{len(keys)} keys, {spent} spent this process"


@probe("ranking tag harvest", critical=False)
def _check_tag_harvest():
    # The creator-vs-niche tag filter counts DISTINCT CHANNELS, so it
    # depends on fetch_metadata returning channel_id. It did not, and the
    # failure was invisible: every tag collapsed to one anonymous owner,
    # the threshold passed everything, and creator brand tags would have
    # shipped on your videos. Assert the field exists rather than trust it.
    from modules import seo_borrower as sb
    import inspect
    src = inspect.getsource(sb.fetch_metadata)
    if "channel_id" not in src:
        return False, ("fetch_metadata does not return channel_id — the tag "
                       "filter cannot tell a creator's brand tag from a niche "
                       "tag and will keep both")
    from modules import researcher as rs
    c = {}
    rs._harvest_tags("#brandtag #nichetag", c, owner="a")
    rs._harvest_tags("#brandtag", c, owner="a")
    rs._harvest_tags("#nichetag", c, owner="b")
    kept = rs._select_tags(c)
    if "brandtag" in kept:
        return False, "filter kept a single-channel tag — threshold is not applying"
    return True, "single-channel tags dropped, multi-channel tags kept"


@probe("publish deferral routing", critical=False)
def _check_deferral():
    label = (os.getenv("INSTANCE_LABEL", "") or "").lower()
    tier = (os.getenv("INSTANCE_TIER", "") or "").strip().lower()
    if not label and not tier:
        return False, ("neither INSTANCE_LABEL nor INSTANCE_TIER is set — the "
                       "worker cannot tell if it is the publisher. INSTANCE_TIER "
                       "alone is not trusted: it reports 'gpu' on Oracle, which "
                       "would make the publisher defer to itself and publish "
                       "nothing.")
    return True, f"label={label or '(unset)'} tier={tier or '(unset)'}"


def run(fail_loudly: bool = True) -> dict:
    """Run every probe. Returns {label: (ok, detail)}. Never raises."""
    results = {}
    dead_critical = []
    for label, fn, critical in _PROBES:
        try:
            ok, detail = fn()
        except Exception as e:                      # noqa: BLE001 — see docstring
            ok, detail = False, f"probe itself failed: {type(e).__name__}: {e}"
        results[label] = (ok, detail)
        if ok:
            if detail.startswith("DEGRADED"):
                log.warning(f"selfcheck: {label}: {detail}")
            else:
                log.info(f"selfcheck: {label}: OK — {detail}")
        else:
            if critical:
                dead_critical.append(label)
                log.error(f"selfcheck: {label}: DEAD — {detail}")
            else:
                log.warning(f"selfcheck: {label}: DEAD — {detail}")

    ok_n = sum(1 for ok, _ in results.values() if ok)
    if dead_critical and fail_loudly:
        log.error(f"selfcheck: {ok_n}/{len(results)} capabilities OK; "
                  f"CRITICAL dead: {', '.join(dead_critical)}")
    else:
        log.info(f"selfcheck: {ok_n}/{len(results)} capabilities OK")
    return results

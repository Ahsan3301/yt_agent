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
#
# Imported rather than redeclared: the scriptwriter sizes its budget
# from this same number, and a probe that validates the budget using a
# private copy would keep passing after the real one moved. That is
# exactly how the 70-85 target survived while overrunning a 30s cap.
from modules.word_budget import BASE_WORDS_PER_SEC as _WORDS_PER_SEC

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
    from modules import config, channels as _ch, word_budget as _wb
    _s = config.load_settings()

    # Check the budget the scriptwriter will ACTUALLY use, per channel,
    # rather than the raw setting. The setting is now an input to the
    # derivation, not the answer — checking it directly reported a
    # problem the renderer no longer has, and would miss a real one on
    # the slowest channel.
    _worst = None
    for _name in _ch.CHANNEL_PRESETS:
        _cfg = _ch.get_channel(_name)
        _lo, _hi, _ = _wb.budget(_cfg, _s)
        _secs = (_hi * _wb.VALIDATOR_MARGIN) / _wb.words_per_sec(_cfg)
        if _worst is None or _secs > _worst[1]:
            _worst = (_name, _secs, _lo, _hi)
    _cap = _wb.cap_seconds(_s)
    if _worst and _worst[1] > _cap:
        return False, (f"channel '{_worst[0]}' budgets {_worst[2]}-{_worst[3]} words "
                       f"-> worst case {_worst[1]:.1f}s against a {_cap:.0f}s cap; "
                       f"its ending will be trimmed")

    if not _worst:
        return True, "no channel presets to check"

    c = _s.get("content", {}) or {}
    wmin, wmax = c.get("target_word_min"), c.get("target_word_max")
    if not wmin or not wmax:
        return True, (f"derived per channel; slowest is '{_worst[0]}' at "
                      f"{_worst[2]}-{_worst[3]} words = {_worst[1]:.1f}s "
                      f"(cap {_cap:.0f}s)")
    # Overrun is already ruled out above. What is left to check is the
    # other direction — a budget so conservative that the slot carries
    # silence. Both have bitten before: too low made scripts a third
    # shorter than the slot, too high overran the cap and got the ending
    # trimmed.
    #
    # Measured on the TYPICAL script (word_max), not the worst accepted
    # one, because that is what a normal render produces.
    _thin = None
    for _name in _ch.CHANNEL_PRESETS:
        _cfg = _ch.get_channel(_name)
        _lo, _hi, _ = _wb.budget(_cfg, _s)
        _typ = _hi / _wb.words_per_sec(_cfg)
        if _thin is None or _typ < _thin[1]:
            _thin = (_name, _typ, _lo, _hi)
    if _thin and _thin[1] < _cap * 0.70:
        return True, (f"DEGRADED: a full {_thin[3]}-word script on '{_thin[0]}' runs "
                      f"only {_thin[1]:.1f}s in a {_cap:.0f}s slot — "
                      f"{_cap - _thin[1]:.0f}s carries no narration. Raise "
                      f"video.max_video_seconds or check the channel rate.")

    _cfg_note = ""
    if wmin and wmax:
        _fits = int((_cap * _wb.words_per_sec(_ch.get_channel(_worst[0]))) / _wb.VALIDATOR_MARGIN)
        if wmax > _fits:
            _cfg_note = (f"; configured {wmin}-{wmax} is overridden on slower "
                         f"channels (only <= {_fits} fits '{_worst[0]}')")
    return True, (f"slowest '{_worst[0]}' {_worst[2]}-{_worst[3]}w -> worst case "
                  f"{_worst[1]:.1f}s (cap {_cap:.0f}s){_cfg_note}")


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

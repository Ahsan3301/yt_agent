"""How many words fit in the video slot, per channel.

WHY THIS EXISTS
---------------
The word target was configured independently of the duration cap, and
the two disagreed. Measured against the live settings:

    cap                 30.0s
    target min  70 words -> 34.7s    OVER
    target max  85 words -> 42.1s    OVER
    validator ceiling 95 -> 47.0s    OVER

Every value in the accepted range overshot. The editor trims narration
to the cap, so every render lost its ending — the recontextualising last
line that the prompt works hardest to produce and that the hook-echo
guard exists to protect. Scripts landing at 72-74 words were not the
model being lazy at the bottom of its range; that was the only part of
the range that came close to fitting, and it still did not.

A fixed word count cannot be right in the first place, because the
speaking rate is per channel. Each preset carries an edge-tts prosody
rate from -12% (horror, deliberate) to +11% (comedy, quick) — a 26%
spread. One global budget is necessarily wrong for both ends: sized for
horror it wastes seconds of a comedy slot, sized for comedy it gets
horror trimmed.

So the budget is DERIVED from the things that actually determine it —
the cap, the measured base rate, and the channel's own prosody — rather
than configured beside them and left to drift.

RESPECTING CONFIGURATION
------------------------
An operator's target_word_min/max is honoured whenever it fits. It is
only overridden when it cannot physically fit the cap, and that
override is logged with the arithmetic. Silently ignoring configuration
would be its own bug; silently trimming every video was the one we had.
"""

from __future__ import annotations

import logging
import os
import re

log = logging.getLogger(__name__)

# Words per second at a channel rate of 0%, measured from real renders.
# Single source of truth: modules/selfcheck.py imports this rather than
# keeping its own copy, because two constants that must agree will not.
BASE_WORDS_PER_SEC = 2.02

# The scriptwriter's validator accepts word_max * this before rejecting,
# so the WORST accepted script — not the target — is what has to fit.
# Budgeting against the target alone is what let 85 become 95 became 47s.
VALIDATOR_MARGIN = 1.12

_DEFAULT_CAP_SECONDS = 30.0


def parse_rate(rate: str | None) -> float:
    """edge-tts prosody rate ("-12%", "+7%") as a multiplier."""
    if not rate:
        return 1.0
    m = re.search(r"([+-]?\d+(?:\.\d+)?)\s*%", str(rate))
    if not m:
        return 1.0
    pct = float(m.group(1))
    # Clamp: edge-tts accepts extreme values but they stop being
    # linear, and a typo like "-900%" should not produce a 3-word script.
    pct = max(-50.0, min(100.0, pct))
    return 1.0 + pct / 100.0


def words_per_sec(channel_cfg: dict | None = None) -> float:
    """Speaking rate for this channel, in words per second."""
    rate = (channel_cfg or {}).get("rate") if isinstance(channel_cfg, dict) else None
    return BASE_WORDS_PER_SEC * parse_rate(rate)


def cap_seconds(settings: dict | None = None) -> float:
    """The video duration cap the editor will trim to."""
    try:
        v = ((settings or {}).get("video") or {})
        cap = float(v.get("max_video_seconds") or 0)
    except Exception:
        cap = 0.0
    if cap <= 0:
        try:
            cap = float(os.getenv("MAX_VIDEO_SECONDS", "") or 0)
        except ValueError:
            cap = 0.0
    return cap if cap > 0 else _DEFAULT_CAP_SECONDS


def budget(channel_cfg: dict | None = None,
           settings: dict | None = None) -> tuple[int, int, str]:
    """Return (word_min, word_max, explanation) for one channel.

    The configured target wins when its worst accepted case fits the cap.
    Otherwise the derived budget wins and the reason is in the string.
    """
    cap = cap_seconds(settings)
    wps = words_per_sec(channel_cfg)

    # Largest target whose worst accepted case still fits the slot.
    fits = int((cap * wps) / VALIDATOR_MARGIN)
    derived_max = max(20, fits)
    # A band, not a point: 12% under the max leaves the model somewhere
    # to land without every script being the same length.
    derived_min = max(15, int(round(derived_max * 0.88)))

    content = ((settings or {}).get("content") or {})
    try:
        cfg_min = int(content.get("target_word_min") or 0)
        cfg_max = int(content.get("target_word_max") or 0)
    except (TypeError, ValueError):
        cfg_min = cfg_max = 0

    if cfg_max and cfg_max <= fits and cfg_min and cfg_min < cfg_max:
        return cfg_min, cfg_max, (
            f"configured {cfg_min}-{cfg_max} words fits {cap:.0f}s at "
            f"{wps:.2f} w/s"
        )

    why = (
        f"derived {derived_min}-{derived_max} words for a {cap:.0f}s cap at "
        f"{wps:.2f} w/s (channel rate {(channel_cfg or {}).get('rate') or '0%'})"
    )
    if cfg_max:
        worst = int(cfg_max * VALIDATOR_MARGIN)
        why += (
            f" — OVERRIDES configured {cfg_min}-{cfg_max}, whose worst accepted "
            f"case is {worst} words = {worst / wps:.1f}s and would be trimmed"
        )
        log.warning(f"word budget: {why}")
    return derived_min, derived_max, why

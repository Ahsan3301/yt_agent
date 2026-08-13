"""Pollinations — free Flux, no key required.

The safety net of the image chain: no credentials, no quota to exhaust,
so it is usually the last provider that can still produce something.
Its only failure mode is the upstream being down, which the breaker
covers.

Note it has no native negative_prompt — shotfinder folds negatives into
the positive prompt for this backend, which is weaker than a real
negative but better than dropping them. That behaviour lives with the
generate body and moves with it.
"""

from __future__ import annotations

from modules.providers.base import Provider, register
from modules.providers._shared import breaker_reason, shotfinder


def _ready() -> "tuple[bool, str]":
    # No key check: that is the point of this provider. Anything that
    # required credentials here would defeat its role as the fallback
    # that still works when every keyed provider is exhausted.
    r = breaker_reason("_pollinations_breaker_skip", "_POLL_OPEN_UNTIL")
    if r:
        return r
    return True, ""


def _generate(prompt, output_dir, trial, negative_prompt="", **_):
    return shotfinder()._pollinations_generate(
        prompt, output_dir, trial, negative_prompt=negative_prompt,
    )


register(Provider(
    name="pollinations",
    kind="image",
    generate=_generate,
    ready=_ready,
    supports_reference=False,
    blurb="Free Flux via Pollinations. No key and no quota, so it is the "
          "fallback that still works when every keyed provider is spent.",
))

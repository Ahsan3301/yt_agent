"""Stable Horde — crowdsourced SDXL.

Works anonymously, so like Pollinations it has no credential gate.
STABLEHORDE_API_KEY is optional and only buys queue priority; its
absence makes generation slower, not impossible, so it must NOT be a
readiness condition. Treating an optional key as required would remove
a working provider from the chain.

No breaker either. Horde's characteristic failure is a job sitting in a
volunteer queue for minutes rather than an error, and the generate path
already bounds that with its own timeout. A breaker keyed on failures
would not fire on the slow case, which is the case that actually
happens.
"""

from __future__ import annotations

from modules.providers.base import Provider, register
from modules.providers._shared import shotfinder


def _ready() -> "tuple[bool, str]":
    # Always available. Kept as an explicit function rather than
    # ready=None so the reason for having no conditions is written down
    # next to the provider, instead of looking like an oversight.
    return True, ""


def _generate(prompt, output_dir, trial, negative_prompt="", **_):
    return shotfinder()._horde_generate(
        prompt, output_dir, trial, negative_prompt=negative_prompt,
    )


register(Provider(
    name="horde",
    kind="image",
    generate=_generate,
    ready=_ready,
    supports_reference=False,
    # Static string on purpose. An earlier draft interpolated whether
    # STABLEHORDE_API_KEY was set — but blurbs are built at IMPORT time
    # and keys_sync populates the environment per JOB, so it would have
    # frozen whatever was true when the worker booted and then reported
    # it forever. That is the same import-time capture that disabled
    # Agnes on every render. Anything env-dependent belongs in ready().
    blurb="Real SDXL via the crowdsourced Stable Horde. Works anonymously; "
          "STABLEHORDE_API_KEY is optional and only buys queue priority.",
))

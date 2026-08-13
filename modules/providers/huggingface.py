"""Hugging Face Inference — SDXL with a real negative prompt.

Two readiness conditions: a token, and a closed breaker. Unlike Horde
the token is genuinely required — without HF_TOKEN the endpoint refuses
every request, so skipping early saves five useless round trips per
shot.

HF_INFERENCE_PROVIDER can route this through replicate/fal instead of
hf-inference. That is read inside the generate body, not here: it
changes WHERE the request goes, not WHETHER it can be made.
"""

from __future__ import annotations

import os

from modules.providers.base import Provider, register
from modules.providers._shared import breaker_reason, shotfinder


def _ready() -> "tuple[bool, str]":
    # Read at call time, never cached at import — keys_sync rewrites the
    # environment per job.
    if not (os.getenv("HF_TOKEN", "") or "").strip():
        return False, "no HF_TOKEN"
    r = breaker_reason("_huggingface_breaker_skip", "_HF_OPEN_UNTIL")
    if r:
        return r
    return True, ""


def _generate(prompt, output_dir, trial, negative_prompt="", **_):
    return shotfinder()._huggingface_generate(
        prompt, output_dir, trial, negative_prompt=negative_prompt,
    )


register(Provider(
    name="huggingface",
    kind="image",
    generate=_generate,
    ready=_ready,
    supports_reference=False,
    blurb="SDXL via Hugging Face Inference. Takes a real negative_prompt "
          "rather than folding negatives into the positive one, so it is "
          "the better choice when a shot needs specific exclusions.",
))

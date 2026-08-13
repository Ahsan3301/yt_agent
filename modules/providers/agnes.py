"""Agnes AI — image and video generation.

MIGRATION NOTE (read before assuming this file is the whole provider)
--------------------------------------------------------------------
The READINESS rules live here. The generate BODIES still live in
modules/shotfinder.py and are called through a lazy import below.

That split is deliberate for this first migration, not laziness:

  * Readiness is what the modular structure is actually for. It was an
    if/elif chain in a 3,000-line file, and a provider missing from that
    chain is silently treated as always-ready — it then fails per-shot
    at call time instead of being skipped once. Co-locating the rule
    with the provider makes that class of mistake impossible.

  * The generate bodies share helpers with every other provider
    (`_distill_prompt_for_flux` in particular). Moving them before
    those helpers have a home would either drag half of shotfinder
    along or create a circular import. They move when the shared
    prompt helpers do.

The import is inside the functions rather than at module scope because
shotfinder imports this package — a top-level import here would be a
cycle that fails at boot.
"""

from __future__ import annotations

import os
import time

from modules.providers.base import Provider, register


def _agnes_key() -> str:
    """The key, read at CALL time.

    Not cached: channel_agnes rewrites AGNES_API_KEY per job, so a value
    captured at import would belong to whichever channel happened to
    render first. That exact pattern — a "no override" branch popping
    the key — disabled Agnes on every render for months.
    """
    return (os.getenv("AGNES_API_KEY", "") or "").strip()


def _cooldown_remaining() -> int:
    """Seconds left on the post-401/402/429 cooldown, 0 if clear.

    The cooldown itself is still owned by shotfinder (it is set from
    inside the generate path). Read through a lazy import so this
    module has no import-time dependency on it.
    """
    try:
        from modules import shotfinder as _sf
        until = float(getattr(_sf, "_AGNES_COOLDOWN_UNTIL", 0) or 0)
    except Exception:
        return 0
    return max(0, int(until - time.time()))


def _ready_image() -> "tuple[bool, str]":
    if not _agnes_key():
        return False, "no AGNES_API_KEY (channel agnes_source=off, or no key in the pool)"
    wait = _cooldown_remaining()
    if wait:
        return False, f"cooling after an auth/quota error ({wait}s remaining)"
    return True, ""


def _ready_video() -> "tuple[bool, str]":
    ok, why = _ready_image()
    if not ok:
        return ok, why
    # The video endpoint rate-limits at 2 requests/minute and returns
    # 503 video_queue_full under load. Both are handled with retries in
    # the generate path rather than gating here — a busy queue is
    # transient, and refusing the provider for it would silently
    # downgrade the shot to a still, which is the failure this was
    # built to stop.
    return True, ""


def _generate_image(prompt, output_dir, trial, negative_prompt="", ref_image_path="", **_):
    from modules.shotfinder import _agnes_generate
    return _agnes_generate(
        prompt, output_dir, trial,
        negative_prompt=negative_prompt,
        ref_image_path=ref_image_path,
    )


def _generate_video(prompt, output_dir, idx, seconds=5.0, init_image_url="", **_):
    from modules.shotfinder import _agnes_video_generate
    return _agnes_video_generate(
        prompt, output_dir, idx,
        seconds=seconds,
        init_image_url=init_image_url,
    )


register(Provider(
    name="agnes",
    kind="image",
    generate=_generate_image,
    ready=_ready_image,
    supports_reference=True,
    blurb="Agnes AI image model. Primary provider — accepts a character "
          "reference image, which is what keeps a face stable across the "
          "shots of one video.",
))

register(Provider(
    name="agnes_video",
    kind="video",
    generate=_generate_video,
    ready=_ready_video,
    supports_reference=True,
    blurb="Agnes AI video model. Generates a real moving clip per shot at "
          "1080x1920 instead of panning a still. Rate-limited to 2 "
          "requests/minute upstream, paced and retried in the generate path.",
))

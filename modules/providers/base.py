"""Provider interface and registry.

Deliberately small. The registry holds objects and hands them back; it
does not decide order, does not read settings, and does not retry. Those
belong to the caller, which already has the operator's configuration in
hand and is the only place that can sensibly own them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Optional

log = logging.getLogger(__name__)

# (prompt, output_dir, trial, negative_prompt, **extras) -> (path|None, seed)
#
# The pair, not a bare path. The SEED is load-bearing: image providers
# derive it deterministically from the prompt so the same character can
# be re-rolled consistently across the shots of one video, and the
# caller stamps it onto the shot. Returning only the path would quietly
# drop character consistency — verified against _agnes_generate, which
# returns (dest, seed) on success and (None, seed) on every failure
# path, so the seed survives even when the image does not.
GenerateFn = Callable[..., "tuple[Optional[str], int]"]

# () -> (ready, reason_if_not)
#
# The reason string is not decoration. Provider skips are the single
# most common thing to debug in a render log, and "cloudflare: skipped"
# has cost real time compared with "cloudflare: all 3 pool accounts
# exhausted for today". Every implementation must give one.
ReadyFn = Callable[[], "tuple[bool, str]"]


@dataclass(frozen=True)
class Provider:
    """One image or video backend."""

    name: str
    generate: GenerateFn
    #: Why this provider exists / when it is the right choice. Shown in
    #: operator-facing listings, so write it for a human.
    blurb: str = ""
    #: Answers "could I work right now?" — key present, breaker closed,
    #: GPU available. NOT "should I be used", which is the operator's
    #: call via settings and priority order.
    ready: Optional[ReadyFn] = None
    #: "image" | "video". Kept explicit so a video backend can never be
    #: picked up by the still-image chain by accident.
    kind: str = "image"
    #: Accepts a reference image for character consistency.
    supports_reference: bool = False

    def is_ready(self) -> "tuple[bool, str]":
        if self.ready is None:
            return True, ""
        try:
            return self.ready()
        except Exception as e:
            # A readiness check that throws must not take the render
            # down — treat it as "not ready" and say why. This is the
            # conservative direction: skipping a usable provider costs
            # one fallback, while crashing costs the whole render.
            return False, f"readiness check failed: {type(e).__name__}: {e}"


_REGISTRY: "dict[str, Provider]" = {}


def register(p: Provider) -> Provider:
    """Add a provider. Re-registering the same name replaces it.

    Replacement is allowed on purpose: module reloads during
    development would otherwise raise, and a duplicate name is a
    programming error that shows up immediately in the log below rather
    than silently running two implementations.
    """
    if p.name in _REGISTRY:
        log.debug("providers: replacing existing registration for %r", p.name)
    _REGISTRY[p.name] = p
    return p


def get(name: str) -> Optional[Provider]:
    return _REGISTRY.get(name)


def is_ready(name: str) -> "tuple[bool, str]":
    """Readiness for a registered provider. Unknown name -> not ready."""
    p = _REGISTRY.get(name)
    if p is None:
        return False, "not registered"
    return p.is_ready()


def registered_names(kind: str = "") -> "list[str]":
    """Registered provider names, optionally filtered by kind."""
    return sorted(n for n, p in _REGISTRY.items() if not kind or p.kind == kind)

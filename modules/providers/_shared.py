"""Helpers shared by more than one provider.

Only things genuinely common to several providers belong here. A helper
used by exactly one provider belongs in that provider's file, where it
can be deleted along with it.
"""

from __future__ import annotations

import time
from typing import Optional


def shotfinder():
    """The shotfinder module, imported lazily.

    Every provider needs this and every provider must import it late:
    shotfinder imports the providers package, so a module-scope import
    here is a cycle that fails at boot rather than at call time.
    """
    from modules import shotfinder as _sf
    return _sf


def breaker_reason(
    skip_attr: str,
    until_attr: str,
    label: str = "breaker open after repeated failures",
) -> Optional["tuple[bool, str]"]:
    """(False, reason) when the named circuit breaker is open, else None.

    Now used only by huggingface, whose breaker state still lives in
    shotfinder. pollinations and horde own their state outright and
    check it directly, which is the end state for all of them.

    Three providers implemented the identical pattern — a `_X_breaker_skip()`
    predicate plus a `_X_OPEN_UNTIL` epoch — and each had its own copy of
    the same four lines in the readiness chain. One of those copies was
    additionally wrapped in `except NameError`, defending against its own
    helper not existing, which is the shape of a bug being worked around
    rather than fixed. getattr with a default handles that case honestly.

    Returns None (not a tuple) when the breaker is CLOSED so callers can
    write `r = breaker_reason(...); if r: return r` and continue.
    """
    sf = shotfinder()
    skip = getattr(sf, skip_attr, None)
    if not callable(skip):
        # Helper genuinely absent — treat the breaker as closed rather
        # than blocking the provider. A missing breaker means no failure
        # history, which is the permissive case.
        return None
    try:
        if not skip():
            return None
    except Exception:
        return None
    wait = int(float(getattr(sf, until_attr, 0) or 0) - time.time())
    return False, f"{label} ({max(0, wait)}s remaining)"

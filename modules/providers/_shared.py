"""Helpers shared by more than one provider.

Only things genuinely common to several providers belong here. A helper
used by exactly one provider belongs in that provider's file, where it
can be deleted along with it.

HISTORY — breaker_reason() lived here and is gone.
--------------------------------------------------
It existed to de-duplicate a breaker check that three providers made
against state living in shotfinder. Once pollinations, horde and
huggingface each took ownership of their own breaker state, every one
of them could check it directly in two lines, and the shared indirection
had nothing left to share.

It is recorded rather than silently deleted because the shape is worth
recognising: a helper that only exists to reach ACROSS a boundary is
usually a sign the boundary is in the wrong place. Fixing the ownership
made the helper redundant. Adding a fourth caller would have entrenched
it instead.
"""

from __future__ import annotations


def shotfinder():
    """The shotfinder module, imported lazily.

    Providers that still read state owned by shotfinder need this, and
    they must import late: shotfinder imports the providers package, so
    a module-scope import is a cycle that fails at boot rather than at
    call time.

    Fewer providers need this with each migration. When none do, this
    file goes too.
    """
    from modules import shotfinder as _sf
    return _sf

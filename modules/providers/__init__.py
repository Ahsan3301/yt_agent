"""Image/video generation providers.

WHY THIS PACKAGE EXISTS
-----------------------
Adding a provider used to mean editing modules/shotfinder.py (3,046
lines) in four separate places:

  1. the default priority list
  2. the `_provider_ready` if/elif chain
  3. the `_AI_PROVIDERS` dispatch dict
  4. the generate function itself

Miss one and the failure is quiet in a specific way: a provider present
in the dispatch dict but absent from `_provider_ready` is treated as
always-ready and fails per-shot at call time instead of being skipped;
one in the priority list but not the dict logs "unknown provider" on
every shot of every render. Both cost a render to notice.

Here a provider is ONE object in ONE file that carries its own name,
its own readiness rule, and its own generate function. Registering it
is a single call. Removing it is deleting a file and one import.

WHAT THIS PACKAGE DOES NOT DO
-----------------------------
It does not own priority order or user toggles. Those are operator
settings that live in `settings.image_gen`, and shotfinder still
resolves them — a provider should not get to decide it goes first.
`is_ready` answers only "could I work right now", never "should I be
used".

MIGRATION STATE
---------------
Providers move here one at a time, each verified against a real
generation before the next. shotfinder consults the registry first and
falls back to its in-file implementation for anything not yet moved, so
the two can coexist without a flag day.
"""

from modules.providers.base import (       # noqa: F401
    Provider,
    register,
    get,
    is_ready,
    registered_names,
)

# Importing a provider module is what registers it. Keep these imports
# explicit rather than scanning the directory: an implicit loader makes
# "why is this provider active?" much harder to answer, and the failure
# mode of a bad auto-import is a worker that will not boot.
from modules.providers import agnes        # noqa: F401,E402
from modules.providers import cloudflare   # noqa: F401,E402

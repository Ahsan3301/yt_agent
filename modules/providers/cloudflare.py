"""Cloudflare Workers AI — Flux 2 dev image generation.

The most involved readiness rule of any provider, which is exactly why
it was worth moving second. Four independent things can make Cloudflare
unusable, and each has a different remedy:

  1. no credentials at all
  2. every account in the rotation pool burned for today
  3. the single-account daily soft cap reached
  4. the circuit breaker open after consecutive failures

The old if/elif chain checked all four in one branch of a 3,000-line
function. Collapsing any of them to a bare "skipped" would send the
operator hunting for a key that is present, or waiting on a breaker that
is not open. Each returns its own sentence, including the number that
matters — how many accounts, how long left.

STATE OWNERSHIP
---------------
The pool, the burn map, the quota counter and the breaker all still
live in shotfinder, because the GENERATE path is what mutates them
(it burns an account on 429, trips the breaker on repeated failure).
This module reads that state; it does not own it. Splitting the reader
from the writer would be worse than the current arrangement, so the
state moves when the generate body does.

Reads go through a lazy import: shotfinder imports this package, so a
top-level import here would be a cycle that fails at boot.
"""

from __future__ import annotations

import time

from modules.providers.base import Provider, register


def _sf():
    """The shotfinder module, imported lazily to avoid an import cycle."""
    from modules import shotfinder
    return shotfinder


def _ready() -> "tuple[bool, str]":
    sf = _sf()

    # 1. Credentials. The pool synthesises a single entry from
    #    CLOUDFLARE_ACCOUNT_ID/_API_TOKEN when CLOUDFLARE_ACCOUNTS_JSON
    #    is empty, so an empty pool genuinely means "no CF creds", not
    #    "multi-account mode not configured".
    try:
        pool = sf._cf_account_pool()
    except Exception as e:                     # noqa: BLE001
        return False, f"account pool unreadable: {type(e).__name__}: {e}"
    if not pool:
        return False, "no CLOUDFLARE_ACCOUNTS_JSON / CLOUDFLARE_ACCOUNT_ID+TOKEN"

    # 2. Pool exhaustion. Accounts are marked burned per UTC day and
    #    clear themselves at 00:00 UTC — say how many, because "3 of 3
    #    exhausted" and "no credentials" need very different responses.
    today = sf._cf_today_key()
    viable = [a for a in pool if sf._CF_BURNED_TODAY.get(a["account_id"]) != today]
    if not viable:
        return False, f"all {len(pool)} pool account(s) exhausted for today (resets 00:00 UTC)"

    # 3. Single-account soft cap. Only meaningful with one viable
    #    account: in multi-account mode the counter tracks whichever
    #    account was picked first, so enforcing it across a pool would
    #    stop the whole tier because one member is busy.
    if len(viable) == 1:
        try:
            used = sf._cf_quota_read()
        except Exception:
            used = 0
        cap = getattr(sf, "_CF_DAILY_CAP", 150)
        if used >= cap:
            return False, f"daily soft-cap reached ({used}/{cap}) on the only viable account"

    # 4. Breaker. Checked last because it is the most transient — no
    #    point reporting a 60s breaker when the real problem is that
    #    there are no credentials at all.
    try:
        if sf._cf_breaker_skip():
            wait = int(getattr(sf, "_CF_OPEN_UNTIL", 0) - time.time())
            return False, f"breaker open after repeated failures ({max(0, wait)}s remaining)"
    except Exception:
        pass

    return True, ""


def _generate(prompt, output_dir, trial, negative_prompt="", **_):
    return _sf()._cloudflare_generate(
        prompt, output_dir, trial, negative_prompt=negative_prompt,
    )


register(Provider(
    name="cloudflare",
    kind="image",
    generate=_generate,
    ready=_ready,
    supports_reference=False,
    blurb="Flux 2 dev via Cloudflare Workers AI. Rotates across a pool of "
          "accounts, ~150 images/day free per account, with a per-account "
          "daily burn marker that clears at 00:00 UTC.",
))

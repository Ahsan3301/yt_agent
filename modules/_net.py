"""
_net.py — Shared networking helpers.

retry(): exponential backoff with jitter for any flaky external call
         (Groq, Pexels, Pixabay, edge-tts, YouTube upload).
"""
import logging
import random
import time

log = logging.getLogger(__name__)


def retry(fn, attempts=4, base=1.5, max_delay=30.0, on=(Exception,), desc=""):
    """
    Call fn() with exponential backoff + jitter.

    fn       — zero-arg callable. Wrap with lambda if it takes args.
    attempts — total tries, including the first.
    base     — backoff base in seconds (delay = base * 2**i + jitter).
    on       — tuple of exception types that trigger a retry.
    """
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except on as e:
            last_err = e
            if i == attempts - 1:
                break
            delay = min(max_delay, base * (2 ** i)) + random.uniform(0, 0.5)
            tag = f" [{desc}]" if desc else ""
            log.warning(f"retry{tag} attempt {i+1}/{attempts} failed: {e!r} — sleeping {delay:.1f}s")
            time.sleep(delay)
    raise last_err

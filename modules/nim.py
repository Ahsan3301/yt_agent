"""
nim.py — NVIDIA NIM client (OpenAI-compatible) for script writing + vision judging.

Two endpoints:
  - chat(messages, model)            — text completion
  - vision_score(image_url, prompt)  — multimodal: looks at the image and
                                       returns an integer 0-10 fitness score

Both share a token-bucket rate limiter capped at the free tier's 40 RPM.
"""
import os
import re
import json
import time
import random
import threading
import logging
import requests
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)


def _is_transient(exc):
    """5xx and timeouts are transient; 4xx (auth, bad-request) are not."""
    if isinstance(exc, (requests.ConnectionError, requests.Timeout, TimeoutError)):
        return True
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return 500 <= exc.response.status_code < 600
    return False


def _retry(fn, attempts=3, base=2.0, desc="nim"):
    """Exponential backoff with jitter, used for all NIM HTTP calls."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            last = e
            if not _is_transient(e) or i == attempts - 1:
                raise
            delay = base * (2 ** i) + random.uniform(0, 0.5)
            log.warning(f"NIM {desc} attempt {i+1}/{attempts} failed ({e}); sleeping {delay:.1f}s")
            time.sleep(delay)
    raise last  # unreachable

NIM_BASE = "https://integrate.api.nvidia.com/v1"


# ── Multi-key pool (audit fix #12, 2026-07-13) ─────────────────
# Each LLM provider (NIM / Groq / OpenRouter) accepts EITHER:
#   - <PROVIDER>_API_KEY           (single key, legacy — still works)
#   - <PROVIDER>_API_KEYS_JSON     (JSON array of keys, new)
# When the JSON array is present, we rotate across keys: a 401/403/429
# on one key puts it in a 5-min cooldown and the next call picks the
# healthiest remaining key. When only the singular env is set, the
# pool is a size-1 pool and behaviour is identical to pre-audit.
#
# Env fingerprint (both vars) is snapshotted so a key rotation via
# /keys → keys_sync flushes the pool and gets picked up next call.
class _KeyPool:
    def __init__(self, provider: str, single_env: str, json_env: str):
        self.provider = provider
        self.single_env = single_env
        self.json_env = json_env
        self._keys: list[str] = []
        self._cooling: dict[str, tuple[float, str]] = {}  # key → (available_at, reason)
        self._fingerprint = ""
        self._lock = threading.Lock()

    def _refresh_if_env_changed(self):
        fp = f"{os.getenv(self.json_env, '')}|{os.getenv(self.single_env, '')}"
        if fp == self._fingerprint:
            return
        self._fingerprint = fp
        parsed: list[str] = []
        raw_json = (os.getenv(self.json_env, "") or "").strip()
        if raw_json:
            try:
                arr = json.loads(raw_json)
                if isinstance(arr, list):
                    parsed = [str(k).strip() for k in arr if str(k or "").strip()]
            except Exception as e:
                log.warning(f"{self.provider} pool: {self.json_env} not valid JSON list ({e}) — falling back to single key")
        if not parsed:
            single = (os.getenv(self.single_env, "") or "").strip()
            if single:
                parsed = [single]
        # Drop cooldowns for keys no longer in the pool.
        self._keys = parsed
        current = set(parsed)
        self._cooling = {k: v for k, v in self._cooling.items() if k in current}

    def pick(self) -> str:
        """Return the healthiest key. Priority:
          1. Any key never marked cooling.
          2. Otherwise, key whose cooldown expired earliest ago.
        Returns "" if no keys configured at all (caller raises).
        """
        with self._lock:
            self._refresh_if_env_changed()
            if not self._keys:
                return ""
            now = time.time()
            never_cooled = [k for k in self._keys if k not in self._cooling]
            if never_cooled:
                return never_cooled[0]
            # All cooled. Prefer keys whose cooldown has expired.
            available = [k for k in self._keys if self._cooling.get(k, (0, ""))[0] <= now]
            if available:
                # Clear their cooldowns so they aren't perma-flagged.
                for k in available:
                    self._cooling.pop(k, None)
                return available[0]
            # Everyone is still cooling. Return whoever cools soonest.
            soonest = min(self._keys, key=lambda k: self._cooling[k][0])
            return soonest

    def mark_cooling(self, key: str, seconds: float = 300.0, reason: str = ""):
        if not key:
            return
        with self._lock:
            if key not in self._keys:
                return
            # Never punish the ONLY key in a pool — cooldown would just
            # break every future call. Still log so operator knows.
            if len(self._keys) <= 1:
                log.warning(f"{self.provider} pool: only 1 key, cannot rotate ({reason})")
                return
            self._cooling[key] = (time.time() + seconds, reason)
            healthy = len([k for k in self._keys if k not in self._cooling
                           or self._cooling[k][0] <= time.time()])
            log.warning(
                f"{self.provider} pool: key ending …{key[-4:]} cooling {seconds:.0f}s "
                f"({reason}); {healthy}/{len(self._keys)} keys healthy"
            )

    def size(self) -> int:
        with self._lock:
            self._refresh_if_env_changed()
            return len(self._keys)


_NIM_POOL = _KeyPool("nim", "NVIDIA_NIM_API_KEY", "NVIDIA_NIM_API_KEYS_JSON")
_GROQ_POOL = _KeyPool("groq", "GROQ_API_KEY", "GROQ_API_KEYS_JSON")
_OR_POOL = _KeyPool("openrouter", "OPENROUTER_API_KEY", "OPENROUTER_API_KEYS_JSON")


def _mark_key_cooling_from_exc(pool: "_KeyPool", key: str, exc: Exception) -> bool:
    """If the exception is a 401/403/429, cool the key and return True
    (caller should retry with next key). Otherwise return False (caller
    should raise / retry with same key per its own backoff)."""
    if not key:
        return False
    status = None
    try:
        resp = getattr(exc, "response", None)
        if resp is not None:
            status = getattr(resp, "status_code", None)
    except Exception:
        pass
    if status in (401, 403, 429):
        pool.mark_cooling(key, seconds=300.0, reason=f"HTTP {status}")
        return True
    return False


def _nim_key() -> str:
    """Read the NIM key from env at CALL time — not import time.

    Uses the multi-key pool (audit fix #12); returns the current healthy
    key or "" if none configured. keys_sync.pull_into_env() may fire
    after this module is first imported (e.g. dashboard set the key
    AFTER worker boot); the pool re-reads env on every call, so a
    late-arrived key is picked up transparently."""
    return _NIM_POOL.pick()

# Backwards-compat property — older code paths that still reference
# `nim.NIM_KEY` see whatever the env currently has.
class _KeyProxy:
    def __bool__(self): return bool(_nim_key())
    def __str__(self):  return _nim_key()
    def __eq__(self, other): return _nim_key() == other
    def __repr__(self): return f"<NIM_KEY set={bool(_nim_key())}>"

NIM_KEY = _KeyProxy()

# Model picks (all verified working on NVIDIA NIM free tier):
#
#   TEXT — used for script writing, storyboard planning, image prompt
#   crafting. Nemotron 3 Super 120B (a12b MoE, ~12B active/token) is a
#   reasoning model that thinks then writes; strong on structured JSON.
#   Fallback llama-3.3-70b is the classic dense workhorse — very clean
#   instruction following, no reasoning trace to strip.
#
#   VISION — 90B llama vision is 8x larger than the previous 11B pick
#   and dramatically better at spatial reasoning + composition
#   judgement. The 11B was accepting too many 'kinda maybe on-topic'
#   images (root of the user's 'clips are irrelevant' report). Falls
#   back to 11B if 90B is briefly unavailable so scoring never fully
#   breaks.
# Nemotron 3 Super 120B promoted to PRIMARY (2026-07-10). Live logs
# showed llama-3.3-70b timing out on nearly every call — the render
# always ate 20-30s waiting for it before falling to Nemotron. Nemotron
# has been the actual worker for months. Making it primary drops that
# wasted wall-clock. Fallback chain keeps llama-3.3 (as legit backup),
# adds Qwen 2.5 72B (very stable + strong at JSON), and drops the
# chronically-429ing minimax.
TEXT_MODEL_PRIMARY   = os.getenv("NIM_TEXT_MODEL",   "nvidia/nemotron-3-super-120b-a12b")
TEXT_MODEL_FALLBACKS = [
    # Qwen 2.5 72B Instruct — very stable on NIM, excellent JSON
    # adherence (helps storyboard + SEO calls).
    "qwen/qwen2.5-72b-instruct",
    # Llama-3.3-70b — was primary; keep as fallback because it does
    # respond during off-peak hours and has a slightly different
    # style-fingerprint if Nemotron's is overplayed.
    "meta/llama-3.3-70b-instruct",
    # Llama-3.1-70b — last-resort classic dense fallback.
    "meta/llama-3.1-70b-instruct",
]

VISION_MODEL_PRIMARY   = os.getenv("NIM_VISION_MODEL", "meta/llama-3.2-90b-vision-instruct")
VISION_MODEL_FALLBACKS = [
    "meta/llama-3.2-11b-vision-instruct",
]

# Backwards-compat aliases — older code paths may still import these.
TEXT_MODEL   = TEXT_MODEL_PRIMARY
VISION_MODEL = VISION_MODEL_PRIMARY

# ── Rate limiter ──────────────────────────────────────────────
# NVIDIA free tier is 40 RPM. Dropping our ceiling to 30 gives a
# 10-request safety margin — the burstiness of the pipeline (research
# + script + storyboard + vision judge scoring multiple images per
# shot) was pushing right up against 40 and hitting 429s. 30 RPM is
# still enough to keep the pipeline unblocked and avoids the retry
# storms 429s trigger.
_RATE_LIMIT = int(os.getenv("NIM_RATE_LIMIT_PER_MIN", "30"))
_WINDOW = 60.0
_request_log = []
_rate_lock = threading.Lock()

# ── Groq-primary switch ──────────────────────────────────────
# NIM's llama-3.3-70b times out on ~every call in the current free-tier
# state, forcing a 20s wait before Nemotron picks up — 30-60s wasted per
# LLM step, 20+ steps per render = 10-20 min per render lost.
# Groq's llama-3.3-70b-versatile is the same model behind a fast
# Azure/Groq backend (~1-2s response). Env flag lets us flip back if
# Groq's daily quota is ever bitten.
GROQ_PRIMARY_FIRST = os.getenv("NIM_GROQ_PRIMARY", "true").lower() != "false"

# ── LLM provider priority chain ──────────────────────────────
# Read at every chat() call so a per-render env override from
# backend.channel_llm.apply_from_job takes effect without a restart.
# Format: comma-separated provider names.
#   nim         → run the full NIM model chain (llama-3.3 → nemotron)
#   groq        → Groq llama-3.3-70b-versatile (fastest, strict quota)
#   openrouter  → OpenRouter's free-tier llama-3.3 (rate-limited)
# Absent providers are OFF for this render.
_DEFAULT_LLM_PRIORITY = "nim,openrouter,groq"


def _llm_priority() -> list[str]:
    raw = os.getenv("LLM_PRIORITY", "").strip() or _DEFAULT_LLM_PRIORITY
    known = {"nim", "groq", "openrouter"}
    out: list[str] = []
    for tok in raw.split(","):
        t = tok.strip().lower()
        if t in known and t not in out:
            out.append(t)
    return out or ["nim"]


def _try_provider(name: str, messages, max_tokens, temperature,
                  response_format):
    """Dispatch to a non-NIM provider. Returns content string on success,
    None on skip (missing key / breaker open / empty). Raises on network
    failure so the caller can record the exception for the last-err path."""
    if name == "groq":
        if _GROQ_POOL.size() == 0:
            return None
        if _groq_open():
            return None
        try:
            c = _groq_chat_fallback(messages, max_tokens=max_tokens,
                                    temperature=temperature,
                                    response_format=response_format,
                                    timeout=30)
        except Exception as e:
            _groq_record(False)
            log.warning(f"LLM: Groq failed ({e}); falling to next provider")
            raise
        if c and c.strip():
            _groq_record(True)
            return c
        _groq_record(False)
        return None
    if name == "openrouter":
        if _OR_POOL.size() == 0:
            return None
        _or_model = os.getenv("OPENROUTER_MODEL", "").strip() or "meta-llama/llama-3.3-70b-instruct:free"
        try:
            c = _openrouter_chat_fallback(messages, max_tokens=max_tokens,
                                          temperature=temperature,
                                          response_format=response_format,
                                          timeout=30)
        except Exception as e:
            log.warning(f"LLM: OpenRouter ({_or_model}) failed ({e}); falling to next provider")
            raise
        if c and c.strip():
            log.debug(f"LLM: OpenRouter ({_or_model}) responded")
            return c
        return None
    return None


# ── Groq per-worker circuit breaker ──────────────────────────
# Groq's free tier has a strict per-minute rate limit; hitting 429 on
# every single call for a whole render (one call per shot × 2 threads
# × 5 providers = ~50 Groq round-trips) burned ~300ms each = ~15s
# wasted per render on a provider we already knew was throttling.
# Trip after 3 consecutive 429s, cool down for 3 min then retry.
_GROQ_CONSECUTIVE_FAILS = 0
_GROQ_OPEN_UNTIL = 0.0
_GROQ_FAILS_TO_TRIP = 3
_GROQ_COOLDOWN_SEC = 180


def _groq_open() -> bool:
    return time.time() < _GROQ_OPEN_UNTIL


def _groq_record(success: bool) -> None:
    global _GROQ_CONSECUTIVE_FAILS, _GROQ_OPEN_UNTIL
    if success:
        if _GROQ_CONSECUTIVE_FAILS:
            log.info("Groq: breaker reset after successful call")
        _GROQ_CONSECUTIVE_FAILS = 0
        _GROQ_OPEN_UNTIL = 0.0
        return
    _GROQ_CONSECUTIVE_FAILS += 1
    if _GROQ_CONSECUTIVE_FAILS >= _GROQ_FAILS_TO_TRIP:
        _GROQ_OPEN_UNTIL = time.time() + _GROQ_COOLDOWN_SEC
        log.warning(
            f"Groq: breaker OPEN — {_GROQ_CONSECUTIVE_FAILS} consecutive 429/errors; "
            f"skipping for {_GROQ_COOLDOWN_SEC}s. Going straight to NIM chain."
        )


# ── NIM primary-model circuit breaker ────────────────────────
# When llama-3.3 starts consistently timing out, skip it entirely for
# a cooldown window instead of eating a 10-20s failure every call.
# In-process, non-persistent — resets on worker restart.
_NIM_PRIMARY_CONSECUTIVE_FAILS = 0
_NIM_PRIMARY_OPEN_UNTIL = 0.0
_NIM_PRIMARY_FAILS_TO_TRIP = 3
_NIM_PRIMARY_COOLDOWN_SEC = 600   # 10 min — matches how long free-tier
                                  # queue congestion tends to last.


def _nim_primary_open() -> bool:
    return time.time() < _NIM_PRIMARY_OPEN_UNTIL


def _nim_primary_record(success: bool) -> None:
    global _NIM_PRIMARY_CONSECUTIVE_FAILS, _NIM_PRIMARY_OPEN_UNTIL
    if success:
        if _NIM_PRIMARY_CONSECUTIVE_FAILS:
            log.info("NIM primary llama-3.3: breaker reset after successful call")
        _NIM_PRIMARY_CONSECUTIVE_FAILS = 0
        return
    _NIM_PRIMARY_CONSECUTIVE_FAILS += 1
    if _NIM_PRIMARY_CONSECUTIVE_FAILS >= _NIM_PRIMARY_FAILS_TO_TRIP:
        _NIM_PRIMARY_OPEN_UNTIL = time.time() + _NIM_PRIMARY_COOLDOWN_SEC
        log.warning(
            f"NIM primary llama-3.3: breaker OPEN — {_NIM_PRIMARY_CONSECUTIVE_FAILS} "
            f"consecutive failures; skipping for {_NIM_PRIMARY_COOLDOWN_SEC}s. "
            f"Going straight to Nemotron on subsequent calls."
        )


def _wait_for_slot():
    """Block until we have room under the RPM ceiling."""
    while True:
        with _rate_lock:
            now = time.time()
            # Drop entries older than the window.
            cutoff = now - _WINDOW
            while _request_log and _request_log[0] < cutoff:
                _request_log.pop(0)
            if len(_request_log) < _RATE_LIMIT:
                _request_log.append(now)
                return
            # Sleep until the oldest entry falls off the window.
            sleep_for = _request_log[0] + _WINDOW - now + 0.05
        log.info(f"NIM rate-limit reached ({_RATE_LIMIT}/min) — waiting {sleep_for:.1f}s")
        time.sleep(max(0.1, sleep_for))


# ── Core call ─────────────────────────────────────────────────
def is_available():
    return bool(_nim_key())


def _post_chat(payload, timeout=60, attempts=3):
    # Rotate across the NIM pool on 401/403/429. Each _once call captures
    # the current pool.pick() so a failed key is replaced BEFORE the
    # backoff sleep in _retry. Non-auth errors still go through _retry's
    # transient-error backoff logic on the same key.
    def _once():
        k = _nim_key()
        if not k:
            raise RuntimeError("no NIM key configured (set NVIDIA_NIM_API_KEY or NVIDIA_NIM_API_KEYS_JSON)")
        headers = {"Authorization": f"Bearer {k}", "Content-Type": "application/json"}
        _wait_for_slot()
        try:
            r = requests.post(f"{NIM_BASE}/chat/completions", headers=headers, json=payload, timeout=timeout)
            r.raise_for_status()
            r.encoding = "utf-8"
            return r.json()
        except requests.HTTPError as e:
            if _mark_key_cooling_from_exc(_NIM_POOL, k, e):
                # Immediate retry on the next healthy key — but only if
                # the pool has one. Skips the _retry backoff to avoid a
                # 3-attempt storm on the same-cooled key.
                if _NIM_POOL.size() > 1:
                    k2 = _nim_key()
                    if k2 and k2 != k:
                        headers["Authorization"] = f"Bearer {k2}"
                        r = requests.post(f"{NIM_BASE}/chat/completions", headers=headers, json=payload, timeout=timeout)
                        r.raise_for_status()
                        r.encoding = "utf-8"
                        return r.json()
            raise

    return _retry(_once, attempts=attempts, desc="chat")


def _post_chat_streamed_pair(payload, read_timeout=20, total_timeout=60):
    """
    Stream the response and return (content, reasoning) separately so
    callers can decide which to use. Read timeout is per-chunk; total
    cap is absolute wall-clock. Retries the WHOLE stream on transient
    errors (5xx, connection drops, partial-content interruptions).

    read_timeout was 60s but NIM's free tier stalls between chunks
    constantly — a stuck stream would burn 3 attempts × 60s = 180s
    per model × 4 models = 12 min worst case before the render moved
    on. Now 20s per chunk × 2 attempts + Groq escape = ~1-2 min
    absolute worst case. Confirmed live 2026-07-09.
    """
    payload = dict(payload)
    payload["stream"] = True

    def _once():
        k = _nim_key()
        if not k:
            raise RuntimeError("no NIM key configured (set NVIDIA_NIM_API_KEY or NVIDIA_NIM_API_KEYS_JSON)")
        headers = {
            "Authorization": f"Bearer {k}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        _wait_for_slot()
        try:
            return _stream_once(payload, headers, read_timeout, total_timeout)
        except requests.HTTPError as e:
            if _mark_key_cooling_from_exc(_NIM_POOL, k, e) and _NIM_POOL.size() > 1:
                k2 = _nim_key()
                if k2 and k2 != k:
                    headers["Authorization"] = f"Bearer {k2}"
                    return _stream_once(payload, headers, read_timeout, total_timeout)
            raise

    return _retry(_once, attempts=2, desc="chat-stream")


def _stream_once(payload, headers, read_timeout, total_timeout):
    started = time.time()
    content_parts = []
    reasoning_parts = []

    with requests.post(
        f"{NIM_BASE}/chat/completions",
        headers=headers, json=payload,
        timeout=(15, read_timeout),  # (connect, read-per-chunk)
        stream=True,
    ) as r:
        r.raise_for_status()
        # Force UTF-8 on the SSE stream. NIM's response has
        # Content-Type: text/event-stream WITHOUT a charset, and
        # requests then defaults to Latin-1 (HTTP RFC), which
        # mangles every non-ASCII byte — bullets (•), em-dashes (—),
        # curly quotes, hashtags in non-ASCII niches, etc. Setting
        # r.encoding='utf-8' BEFORE iter_lines makes decode_unicode=True
        # use UTF-8. Symptom before this fix: descriptions on YouTube
        # displayed 'â ¢' where a bullet should be.
        r.encoding = "utf-8"
        for raw_line in r.iter_lines(decode_unicode=True):
            if time.time() - started > total_timeout:
                raise TimeoutError(f"stream exceeded total_timeout={total_timeout}s")
            if not raw_line:
                continue
            line = raw_line.strip()
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if data_str == "[DONE]":
                break
            try:
                evt = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            choices = evt.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            if delta.get("content"):
                content_parts.append(delta["content"])
            if delta.get("reasoning_content"):
                reasoning_parts.append(delta["reasoning_content"])

    return "".join(content_parts), "".join(reasoning_parts)


def chat(messages, model=None, max_tokens=2048, temperature=0.7,
         response_format=None, timeout=20, stream=None, thinking=False,
         tools=None, tool_choice=None, attempts=2):
    """
    OpenAI-compatible chat completion. Returns the assistant message string.

    Streaming is auto-enabled for long-output calls (max_tokens > 1024) so
    NIM's slow free-tier inference doesn't trip read timeouts on the full
    response. Pass stream=False to force non-streaming.

    thinking=False (default) sends `chat_template_kwargs={"thinking": false}`
    so Nemotron-class reasoning models skip the verbose think-trace and
    produce the final answer directly. Set thinking=True only when you
    actually want the reasoning trace (debugging, transparency).

    tools=None / tool_choice=None: standard chat. To enable function-
    calling agentic loops use chat_with_tools() instead — it parses
    tool_calls from the response. Passing tools= directly here also
    works but you get the raw string and must parse yourself.
    """
    # Per-render LLM priority chain. LLM_PRIORITY env is populated by
    # backend.channel_llm.apply_from_job from the channel's own setting.
    # Format: comma-separated provider names. Absent providers are skipped
    # entirely (channel opted them off). NIM is a sentinel meaning "run
    # the full NIM model chain"; the walk defers to the existing NIM
    # code below when it hits nim.
    last_err: Exception | None = None
    priority = _llm_priority()
    tried_nim = False
    if model:
        # Caller pinned a specific NIM model — respect that intent, run
        # only the NIM path.
        priority = ["nim"]
    for prov in priority:
        if prov == "nim":
            tried_nim = True
            break  # fall through to existing NIM chain below
        try:
            content = _try_provider(prov, messages, max_tokens, temperature,
                                    response_format)
        except Exception as e:
            last_err = e
            continue
        if content and content.strip():
            return content

    # NIM chain only runs if "nim" was in the per-render priority list
    # (or the caller pinned a specific NIM model). If the channel toggled
    # NIM off, skip straight to the post-NIM provider loop below.
    if not tried_nim and not model:
        # No NIM run scheduled — walk any providers listed AFTER what
        # would have been the nim slot (there are none since we broke
        # on 'nim' above), then raise.
        if last_err:
            raise last_err
        raise RuntimeError(f"all LLM providers exhausted (priority={priority})")

    # Model fallback chain — caller-supplied model wins alone; otherwise
    # walk the configured primary + fallbacks so a transient outage on
    # any one model doesn't kill the whole render.
    model_chain = [model] if model else [TEXT_MODEL_PRIMARY, *TEXT_MODEL_FALLBACKS]

    # If the llama-3.3 breaker is open, skip it entirely — go straight
    # to Nemotron etc. Only applies to the default chain, not caller-pinned.
    if not model and _nim_primary_open():
        model_chain = [m for m in model_chain if m != TEXT_MODEL_PRIMARY]

    for m_name in model_chain:
        payload = {
            "model": m_name,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if response_format:
            payload["response_format"] = response_format
        if tools:
            payload["tools"] = tools
            if tool_choice is not None:
                payload["tool_choice"] = tool_choice
        if not thinking:
            # Reasoning models eat the entire token budget on internal
            # monologue otherwise. With thinking off they go straight to
            # the answer — same quality, ~5x fewer tokens, ~3x faster.
            payload["chat_template_kwargs"] = {"thinking": False}

        # Decide stream mode inside the loop — same rule, but tools disable it.
        if stream is None:
            use_stream = (max_tokens > 1024) and not tools
        else:
            use_stream = stream

        # Tighter timeout on the flaky primary — 10s beats 20s when
        # llama-3.3 is dead anyway; Nemotron picks up faster.
        _is_primary = (m_name == TEXT_MODEL_PRIMARY)
        _per_call_timeout = 10 if _is_primary else timeout
        _per_read_timeout = 10 if _is_primary else 20
        try:
            if use_stream:
                content, reasoning = _post_chat_streamed_pair(
                    payload, read_timeout=_per_read_timeout,
                    total_timeout=max(30, _per_call_timeout * 3)
                )
            else:
                data = _post_chat(payload, timeout=_per_call_timeout, attempts=attempts)
                # Defensive unpacking — NIM occasionally returns a
                # malformed body with no choices array (was crashing
                # with 'list index out of range' and killing the
                # fallback loop). Treat empty-shape as a retry signal.
                choices = (data or {}).get("choices") or []
                if not choices:
                    raise RuntimeError(f"NIM {m_name}: empty choices in response")
                msg = choices[0].get("message") or {}
                content = msg.get("content") or ""
                reasoning = msg.get("reasoning_content") or ""
        except Exception as e:
            log.warning(f"NIM chat {m_name} failed: {e}; trying next model in chain")
            if _is_primary:
                _nim_primary_record(success=False)
            last_err = e
            continue

        if content.strip():
            if _is_primary:
                _nim_primary_record(success=True)
            if m_name != model_chain[0]:
                log.info(f"NIM chat: succeeded on fallback model {m_name}")
            return content
        # Empty content but reasoning present = model ran out of budget
        # mid-reasoning. Warn + surface it anyway.
        if reasoning.strip():
            log.warning(
                f"NIM {m_name} returned reasoning but no final content "
                f"(max_tokens={max_tokens} may be too low for a reasoning model). "
                f"Using reasoning trace."
            )
            return reasoning
        # Empty everything — retry on next model (some free-tier models
        # transiently return no content under load).
        log.warning(f"NIM {m_name} returned empty response; trying next model")

    # ── POST-NIM PROVIDER FALLBACK ──
    # NIM chain exhausted. Walk any providers listed AFTER 'nim' in the
    # per-channel priority chain — e.g. priority='nim,openrouter,groq'
    # → try OpenRouter then Groq. Providers before 'nim' were already
    # tried in the pre-loop above.
    try:
        _post_nim = priority[priority.index("nim") + 1:] if "nim" in priority else []
    except Exception:
        _post_nim = []
    for prov in _post_nim:
        try:
            content = _try_provider(prov, messages, max_tokens, temperature,
                                    response_format)
        except Exception as e:
            last_err = e
            continue
        if content and content.strip():
            log.info(f"NIM chat: succeeded on post-NIM fallback provider {prov}")
            return content

    if last_err:
        raise last_err
    return ""


def _groq_chat_fallback(messages, max_tokens=2048, temperature=0.7,
                       response_format=None, timeout=45):
    """Call Groq's llama-3.3-70b-versatile as a last-ditch fallback
    when the entire NIM chain has failed. OpenAI-compatible endpoint.

    Reads GROQ_API_KEY at call time (like _nim_key) so a key added
    after the process started is picked up on the next call.

    Returns the content string on success, or empty string / raises
    on failure — same shape as chat().
    """
    _g = _GROQ_POOL.pick()
    if not _g:
        raise RuntimeError("no Groq key configured (set GROQ_API_KEY or GROQ_API_KEYS_JSON)")

    payload = {
        "model": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if response_format:
        payload["response_format"] = response_format

    def _do(key: str) -> str:
        r = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload, timeout=timeout,
        )
        r.raise_for_status()
        data = r.json() or {}
        choices = data.get("choices") or []
        if not choices:
            return ""
        return (choices[0].get("message") or {}).get("content", "") or ""

    try:
        return _do(_g)
    except requests.HTTPError as e:
        if _mark_key_cooling_from_exc(_GROQ_POOL, _g, e) and _GROQ_POOL.size() > 1:
            _g2 = _GROQ_POOL.pick()
            if _g2 and _g2 != _g:
                return _do(_g2)
        raise


def _openrouter_chat_fallback(messages, max_tokens=2048, temperature=0.7,
                              response_format=None, timeout=30):
    """Call OpenRouter's OpenAI-compatible chat endpoint. Model is
    configurable via OPENROUTER_MODEL env; default is the free-tier
    llama-3.3-70b-instruct which is generous but rate-limited."""
    _k = _OR_POOL.pick()
    if not _k:
        raise RuntimeError("no OpenRouter key configured (set OPENROUTER_API_KEY or OPENROUTER_API_KEYS_JSON)")
    _model = os.getenv("OPENROUTER_MODEL", "").strip() or "meta-llama/llama-3.3-70b-instruct:free"
    # Sanity-check the model string. OpenRouter IDs always have a
    # provider/name shape (e.g. meta-llama/llama-3.3-70b-instruct:free,
    # google/gemma-2-9b-it:free). Values like "openrouter/free" or a
    # bare "free" won't resolve on OpenRouter's side — warn loudly.
    if "/" not in _model or _model.count("/") > 2:
        log.warning(
            f"OpenRouter model {_model!r} looks malformed — expected "
            f"'<vendor>/<name>[:variant]'. Common examples: "
            f"'meta-llama/llama-3.3-70b-instruct:free', "
            f"'google/gemma-2-9b-it:free'. Set OPENROUTER_MODEL on /keys "
            f"to a valid id from https://openrouter.ai/models."
        )
    payload = {
        "model": _model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if response_format:
        payload["response_format"] = response_format
    def _do(key: str) -> str:
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # OpenRouter recommends these for attribution + rate-limit tiers
            "HTTP-Referer": os.getenv("OPENROUTER_REFERER", "https://yt-agent.thyker.online"),
            "X-Title": "yt-agent",
        }
        r = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers, json=payload, timeout=timeout,
        )
        r.raise_for_status()
        data = r.json() or {}
        choices = data.get("choices") or []
        if not choices:
            return ""
        return (choices[0].get("message") or {}).get("content", "") or ""

    try:
        return _do(_k)
    except requests.HTTPError as e:
        if _mark_key_cooling_from_exc(_OR_POOL, _k, e) and _OR_POOL.size() > 1:
            _k2 = _OR_POOL.pick()
            if _k2 and _k2 != _k:
                return _do(_k2)
        raise


def chat_with_tools(messages, tools, model=None, max_tokens=2048,
                    temperature=0.4, timeout=60, tool_choice="auto"):
    """
    Function-calling variant of chat(). Returns the full assistant message
    dict (with `content` AND `tool_calls` keys) so the caller can route
    tool_calls into actual function invocations.

    Used by modules/research_agent.py to drive a multi-step browser
    research loop with the tool defs in modules/browser_agent.TOOL_DEFS.

    Returns:
        {
          "content":    str | None,
          "tool_calls": [{
              "id":       "call_xxx",
              "function": {"name": "search", "arguments": "{...}"},
              "type":     "function",
          }, ...] | None,
        }
    """
    payload = {
        "model": model or TEXT_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "tools": tools,
        "tool_choice": tool_choice,
        # thinking=False — let the model commit to a tool call quickly.
        "chat_template_kwargs": {"thinking": False},
    }
    data = _post_chat(payload, timeout=timeout)
    msg = data["choices"][0]["message"]
    return {
        "content":    msg.get("content"),
        "tool_calls": msg.get("tool_calls") or None,
    }


# ── Vision judge ──────────────────────────────────────────────
_INT_RE = re.compile(r"\b(10|[0-9])\b")


def vision_score(image_url, fit_description, premise="", model=None, timeout=30):
    """
    Score how well `image_url` matches `fit_description` (the per-shot
    visual description the storyboard produced) and, optionally, the
    story premise. Returns an int 0-10, or -1 on parse/network failure
    (caller treats -1 as 'unknown, fall through').

    Channel-agnostic: previously the prompt hard-coded a gothic-horror
    rubric and rejected e.g. bright science-lab shots for the Orbitarium
    channel. Now the rubric is expressed in terms of the shot's own
    visual_description + narration excerpt, so 'a clean lab with glass
    beakers' scores highly for a science channel and low for a horror one.

    Vision model fallback chain: tries VISION_MODEL_PRIMARY first
    (llama-3.2-90b-vision-instruct), falls back to 11b if the 90b is
    temporarily unavailable — scoring never silently disables.

    Watermarked previews are fine — the model judges composition, and
    Shutterstock previews contain the full image just under a diagonal
    watermark we tell the model to ignore.
    """
    prompt_parts = [
        "You are a rigorous stock-footage editor picking the ONE image "
        "that best illustrates a specific line of narration for a "
        "vertical short-form video. Be strict: most candidates you see "
        "will NOT fit and should score below 6.",
    ]
    prompt_parts.append(
        f"\n\nTHE SHOT WE WANT:\n{fit_description.strip()}"
    )
    if premise:
        prompt_parts.append(
            f"\n\nOVERALL STORY (for tone/setting context only):\n{premise.strip()}"
        )
    prompt_parts.append(
        "\n\nRUBRIC — score 0 to 10 for how well the image supports THIS shot:\n"
        "  0-2 = wrong subject or wrong genre entirely (e.g. sunny beach for "
        "a night-time horror shot; office desk for a wilderness shot; cartoon "
        "for a live-action premise; text-heavy graphic; unrelated object)\n"
        "  3-4 = right rough category but missing the specific subject the shot "
        "asks for (e.g. shot wants 'a lab with beakers', image is 'a generic "
        "office')\n"
        "  5-6 = correct subject and setting but composition is average, "
        "cluttered, or lit differently than the shot asks for\n"
        "  7-8 = correct subject + setting + tone; visually strong and could "
        "cut into the video as-is\n"
        "  9-10 = exceptional match — the image is essentially what the shot "
        "description describes, no compromise\n"
        "\n"
        "HARD RULES:\n"
        "  • Cartoon/illustration when the shot implies photorealism → max 2.\n"
        "  • Wrong time-of-day (day vs night, indoor vs outdoor) → max 4.\n"
        "  • Wrong subject entirely → max 2.\n"
        "  • Ignore any Shutterstock / iStock / Getty watermark.\n"
        "\n"
        "Reply with ONLY the integer 0-10. No words, no explanation, no "
        "punctuation. Just the number."
    )
    prompt = "".join(prompt_parts)

    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": image_url}},
        ],
    }]

    # Try the primary model then the fallback chain. Note we treat parse
    # failures (returning -1) as retriable too since a bigger model may
    # comply with 'integer only' formatting where a smaller one waffled.
    models = [model] if model else [VISION_MODEL_PRIMARY, *VISION_MODEL_FALLBACKS]
    last_err: Exception | None = None
    for m_name in models:
        try:
            text = chat(messages, model=m_name,
                        max_tokens=16, temperature=0.0, timeout=timeout)
        except Exception as e:
            log.warning(f"vision_score: {m_name} error: {e}")
            last_err = e
            continue
        m = _INT_RE.search(text or "")
        if not m:
            log.debug(f"vision_score: {m_name} unparseable output {text!r}; trying next model")
            continue
        score = max(0, min(10, int(m.group(1))))
        return score

    # ── GROQ VISION FALLBACK ──
    # All NIM vision models failed. Groq's llama-4-scout-17b-16e-
    # instruct is multimodal + fast. Only fires when NIM's whole
    # vision chain is down — Groq's free-tier vision TPM would blow
    # inside one render if used as primary (60 calls × ~200KB images
    # = way over the daily cap).
    try:
        text = _groq_vision_score_fallback(messages, timeout=30)
        m = _INT_RE.search(text or "")
        if m:
            score = max(0, min(10, int(m.group(1))))
            log.info(f"vision_score: succeeded on Groq fallback (llama-4-scout) → {score}")
            return score
    except Exception as e:
        log.warning(f"vision_score: Groq fallback also failed: {e}")

    if last_err:
        log.warning(f"vision_score: all models failed; last error {last_err}")
    return -1


def _groq_vision_score_fallback(messages, timeout=30):
    """Score an image via Groq's llama-4-scout vision model as a
    last-ditch fallback when NIM's vision chain has failed.
    OpenAI-compatible endpoint. Returns raw text; caller parses.
    """
    _g = _GROQ_POOL.pick()
    if not _g:
        raise RuntimeError("no Groq key configured (set GROQ_API_KEY or GROQ_API_KEYS_JSON)")
    payload = {
        "model": os.getenv("GROQ_VISION_MODEL",
                           "meta-llama/llama-4-scout-17b-16e-instruct"),
        "messages": messages,
        "max_tokens": 16,
        "temperature": 0.0,
    }

    def _do(key: str) -> str:
        r = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload, timeout=timeout,
        )
        r.raise_for_status()
        data = r.json() or {}
        choices = data.get("choices") or []
        if not choices:
            return ""
        return (choices[0].get("message") or {}).get("content", "") or ""

    try:
        return _do(_g)
    except requests.HTTPError as e:
        if _mark_key_cooling_from_exc(_GROQ_POOL, _g, e) and _GROQ_POOL.size() > 1:
            _g2 = _GROQ_POOL.pick()
            if _g2 and _g2 != _g:
                return _do(_g2)
        raise

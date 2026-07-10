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

def _nim_key() -> str:
    """Read the NIM key from env at CALL time — not import time.

    keys_sync.pull_into_env() may fire after this module is first
    imported (e.g. dashboard set the key AFTER worker boot). A
    module-level constant would snapshot the empty pre-pull value and
    is_available() would report False forever."""
    return os.getenv("NVIDIA_NIM_API_KEY", "") or ""

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
TEXT_MODEL_PRIMARY   = os.getenv("NIM_TEXT_MODEL",   "meta/llama-3.3-70b-instruct")
TEXT_MODEL_FALLBACKS = [
    # Nemotron 3 Super 120B (MoE, ~12B active/token) — big reasoning
    # model, second-most-reliable in prod when llama-3.3 times out.
    # Its reasoning trace was a problem in earlier prompts but current
    # prompts either strip it or benefit from it (SEO metadata, storyboard).
    "nvidia/nemotron-3-super-120b-a12b",
    # Minimax-m3 — was primary but rate-limits heavily (429s constantly
    # per prod logs) and read-timeouts often. Kept as third fallback so
    # its throughput still helps under sudden burst load.
    "minimaxai/minimax-m3",
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
    _k = _nim_key()
    if not _k:
        raise RuntimeError("NVIDIA_NIM_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {_k}",
        "Content-Type": "application/json",
    }

    def _once():
        _wait_for_slot()
        r = requests.post(f"{NIM_BASE}/chat/completions", headers=headers, json=payload, timeout=timeout)
        r.raise_for_status()
        # Same charset fix as the streaming path — requests defaults to
        # Latin-1 for JSON without a charset, which turns • / — / curly
        # quotes into mojibake before r.json() sees them. Force UTF-8.
        r.encoding = "utf-8"
        return r.json()

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
    _k = _nim_key()
    if not _k:
        raise RuntimeError("NVIDIA_NIM_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {_k}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    payload = dict(payload)
    payload["stream"] = True

    def _once():
        _wait_for_slot()
        return _stream_once(payload, headers, read_timeout, total_timeout)

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
    # Groq-first priority. Skip only when:
    #   • caller pinned a specific NIM model (respect their intent)
    #   • GROQ_PRIMARY_FIRST env is false
    #   • GROQ_API_KEY isn't set
    # Same content contract as the NIM path — return content string on
    # success, fall through to NIM on any failure so no render dies
    # because Groq's daily cap bit.
    last_err: Exception | None = None
    if (not model and GROQ_PRIMARY_FIRST
            and os.getenv("GROQ_API_KEY", "").strip()
            and not _groq_open()):
        try:
            groq_content = _groq_chat_fallback(
                messages, max_tokens=max_tokens, temperature=temperature,
                response_format=response_format, timeout=30,
            )
            if groq_content and groq_content.strip():
                _groq_record(True)
                # Only log the tier one when it succeeded on the FIRST call
                # of the render — otherwise noisy. Track via module-level flag.
                global _GROQ_LOGGED_PRIMARY
                try:
                    if not _GROQ_LOGGED_PRIMARY:
                        log.info("NIM chat: Groq primary (llama-3.3-70b-versatile) responded — subsequent calls suppressed from log")
                        _GROQ_LOGGED_PRIMARY = True
                except NameError:
                    _GROQ_LOGGED_PRIMARY = True
                return groq_content
            _groq_record(False)
            log.warning("NIM chat: Groq primary returned empty; falling to NIM chain")
        except Exception as e:
            last_err = e
            _groq_record(False)
            log.warning(f"NIM chat: Groq primary failed ({e}); falling to NIM chain")

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

    # ── GROQ LAST-DITCH FALLBACK ──
    # All NIM models exhausted. Groq is much faster + more reliable
    # (Azure/Groq backend vs NIM's free-tier queue) but has a stricter
    # daily cap (~100k tokens/day on llama-3.3-70b-versatile). Kept
    # as LAST resort so we don't burn the Groq budget on every render;
    # NIM's chain succeeds most of the time. Confirmed live 2026-07-09.
    try:
        content = _groq_chat_fallback(
            messages, max_tokens=max_tokens, temperature=temperature,
            response_format=response_format, timeout=45,
        )
        if content and content.strip():
            log.info("NIM chat: succeeded on Groq fallback (llama-3.3-70b-versatile)")
            return content
    except Exception as e:
        log.warning(f"Groq fallback also failed: {e}")

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
    _g = os.getenv("GROQ_API_KEY", "") or ""
    if not _g:
        raise RuntimeError("GROQ_API_KEY not set (add via /keys)")

    payload = {
        "model": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if response_format:
        payload["response_format"] = response_format
    headers = {
        "Authorization": f"Bearer {_g}",
        "Content-Type": "application/json",
    }
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers=headers, json=payload, timeout=timeout,
    )
    r.raise_for_status()
    data = r.json() or {}
    choices = data.get("choices") or []
    if not choices:
        return ""
    return (choices[0].get("message") or {}).get("content", "") or ""


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
    _g = os.getenv("GROQ_API_KEY", "") or ""
    if not _g:
        raise RuntimeError("GROQ_API_KEY not set")
    payload = {
        "model": os.getenv("GROQ_VISION_MODEL",
                           "meta-llama/llama-4-scout-17b-16e-instruct"),
        "messages": messages,
        "max_tokens": 16,
        "temperature": 0.0,
    }
    headers = {
        "Authorization": f"Bearer {_g}",
        "Content-Type": "application/json",
    }
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers=headers, json=payload, timeout=timeout,
    )
    r.raise_for_status()
    data = r.json() or {}
    choices = data.get("choices") or []
    if not choices:
        return ""
    return (choices[0].get("message") or {}).get("content", "") or ""

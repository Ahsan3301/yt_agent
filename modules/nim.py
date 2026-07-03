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
TEXT_MODEL_PRIMARY   = os.getenv("NIM_TEXT_MODEL",   "nvidia/nemotron-3-super-120b-a12b")
TEXT_MODEL_FALLBACKS = [
    "meta/llama-3.3-70b-instruct",
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
# NVIDIA's free tier is 40 RPM. We give a 2-request safety margin so a
# burst doesn't trip the limit. Implementation: a sliding window of
# request timestamps; before each call we wait until <38 fall in the
# last 60s.
_RATE_LIMIT = int(os.getenv("NIM_RATE_LIMIT_PER_MIN", "38"))
_WINDOW = 60.0
_request_log = []
_rate_lock = threading.Lock()


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


def _post_chat(payload, timeout=60):
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
        return r.json()

    return _retry(_once, attempts=3, desc="chat")


def _post_chat_streamed_pair(payload, read_timeout=60, total_timeout=240):
    """
    Stream the response and return (content, reasoning) separately so
    callers can decide which to use. Read timeout is per-chunk; total cap
    is absolute wall-clock. Retries the WHOLE stream on transient errors
    (5xx, connection drops, partial-content interruptions).
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

    return _retry(_once, attempts=3, desc="chat-stream")


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
         response_format=None, timeout=60, stream=None, thinking=False,
         tools=None, tool_choice=None):
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
    # Model fallback chain — caller-supplied model wins alone; otherwise
    # walk the configured primary + fallbacks so a transient outage on
    # any one model doesn't kill the whole render.
    model_chain = [model] if model else [TEXT_MODEL_PRIMARY, *TEXT_MODEL_FALLBACKS]

    last_err: Exception | None = None
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

        try:
            if use_stream:
                content, reasoning = _post_chat_streamed_pair(
                    payload, read_timeout=60, total_timeout=max(120, timeout)
                )
            else:
                data = _post_chat(payload, timeout=timeout)
                msg = data["choices"][0]["message"]
                content = msg.get("content") or ""
                reasoning = msg.get("reasoning_content") or ""
        except Exception as e:
            log.warning(f"NIM chat {m_name} failed: {e}; trying next model in chain")
            last_err = e
            continue

        if content.strip():
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
    if last_err:
        raise last_err
    return ""


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


def vision_score(image_url, fit_description, premise="", model=None, timeout=90):
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
    if last_err:
        log.warning(f"vision_score: all models failed; last error {last_err}")
    return -1

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
NIM_KEY = os.getenv("NVIDIA_NIM_API_KEY", "")

# Model picks (verified working on the free tier as of June 2026):
#   - Nemotron 3 Super 120B (a12b MoE: 120B params, ~12B active per token)
#     is a reasoning model — it thinks out loud then writes the final
#     content. Faster wall-clock than the dense 70b llama AND noticeably
#     more specific in storyboard / image-prompt work.
#   - Vision: meta/llama-3.2-11b-vision-instruct — only multimodal option
#     verified on the free tier; the 120b text model is text-only.
TEXT_MODEL   = os.getenv("NIM_TEXT_MODEL",   "nvidia/nemotron-3-super-120b-a12b")
VISION_MODEL = os.getenv("NIM_VISION_MODEL", "meta/llama-3.2-11b-vision-instruct")

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
    return bool(NIM_KEY)


def _post_chat(payload, timeout=60):
    if not NIM_KEY:
        raise RuntimeError("NVIDIA_NIM_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {NIM_KEY}",
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
    if not NIM_KEY:
        raise RuntimeError("NVIDIA_NIM_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {NIM_KEY}",
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
         response_format=None, timeout=60, stream=None, thinking=False):
    """
    OpenAI-compatible chat completion. Returns the assistant message string.

    Streaming is auto-enabled for long-output calls (max_tokens > 1024) so
    NIM's slow free-tier inference doesn't trip read timeouts on the full
    response. Pass stream=False to force non-streaming.

    thinking=False (default) sends `chat_template_kwargs={"thinking": false}`
    so Nemotron-class reasoning models skip the verbose think-trace and
    produce the final answer directly. Set thinking=True only when you
    actually want the reasoning trace (debugging, transparency).
    """
    payload = {
        "model": model or TEXT_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if response_format:
        payload["response_format"] = response_format
    if not thinking:
        # Reasoning models eat the entire token budget on internal
        # monologue otherwise. With thinking off they go straight to
        # the answer — same quality, ~5x fewer tokens, ~3x faster.
        payload["chat_template_kwargs"] = {"thinking": False}

    if stream is None:
        stream = max_tokens > 1024

    if stream:
        content, reasoning = _post_chat_streamed_pair(
            payload, read_timeout=60, total_timeout=max(120, timeout)
        )
    else:
        data = _post_chat(payload, timeout=timeout)
        msg = data["choices"][0]["message"]
        content = msg.get("content") or ""
        reasoning = msg.get("reasoning_content") or ""

    if content.strip():
        return content
    # Empty content but reasoning present = the model ran out of budget
    # mid-reasoning before producing the final answer. Warn and surface
    # the reasoning anyway — usually still useful.
    if reasoning.strip():
        log.warning(
            f"NIM returned reasoning but no final content (max_tokens={max_tokens} "
            f"may be too low for this reasoning model). Using reasoning trace."
        )
        return reasoning
    return ""


# ── Vision judge ──────────────────────────────────────────────
_INT_RE = re.compile(r"\b(10|[0-9])\b")


def vision_score(image_url, fit_description, premise="", model=None, timeout=90):
    """
    Ask the vision model to score how well `image_url` fits `fit_description`
    (and optionally a `premise` describing the story). Returns an int 0-10,
    or -1 on error (caller should treat -1 as "unknown, fall through").

    Watermarked previews are completely fine — the model judges aesthetic
    fit, and Shutterstock previews include the full image just with a
    diagonal Shutterstock watermark.
    """
    prompt_parts = [
        "You are a strict art director picking images for a gothic-horror "
        "YouTube short. Most images you see will NOT fit. Be harsh.\n\n",
        f"Required visual style: {fit_description}.",
    ]
    if premise:
        prompt_parts.append(f"\nStory premise: {premise}")
    prompt_parts.append(
        "\n\nRate the image strictly using this rubric:\n"
        "  0 = totally wrong (sunny outdoors, beach, office, cartoon, food, daylight portrait, sports)\n"
        "  1-2 = dark or moody but contemporary/clinical (modern bedroom, parking garage, "
        "highway, lab, generic urban night)\n"
        "  3-4 = horror-adjacent but generic (just-a-dark-room, generic forest, "
        "ordinary fog, no gothic detail)\n"
        "  5-6 = clearly horror but missing gothic specificity\n"
        "  7-8 = solid gothic horror — abandoned/decayed setting, victorian/period detail, "
        "candlelight, fog, occult symbols, supernatural silhouette, cemetery, mansion\n"
        "  9-10 = exceptional gothic horror — every element on-style, immediately chilling\n\n"
        "RULES:\n"
        "  • Daylight or sunny → max 2.\n"
        "  • Modern/contemporary setting without visible decay → max 4.\n"
        "  • Cartoon, illustration, or text-heavy → max 2.\n"
        "  • Ignore any Shutterstock watermark.\n\n"
        "Reply with ONLY the integer. No words, no explanation."
    )
    prompt = "".join(prompt_parts)

    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": image_url}},
        ],
    }]

    try:
        text = chat(messages, model=model or VISION_MODEL,
                    max_tokens=16, temperature=0.0, timeout=timeout)
    except Exception as e:
        log.warning(f"vision_score error: {e}")
        return -1

    m = _INT_RE.search(text or "")
    if not m:
        log.warning(f"vision_score: couldn't parse integer from {text!r}")
        return -1
    score = int(m.group(1))
    return max(0, min(10, score))

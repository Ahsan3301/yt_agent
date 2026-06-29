"""
research_agent.py — NIM-driven browser research loop.

Lets a NIM model gather facts about a topic by issuing tool calls
(search, visit, read_text, extract_images) against a headless Chromium
session. Returns a structured "research bundle" that the scriptwriter
can use to ground its narration in real, current information.

Used by main.run_pipeline() during the script stage when:
  - The channel's research_mode == "fact_research", AND
  - The user provided a manual_topic (so we have a focused thing to
    research), AND
  - modules.browser_agent.is_available() returns True (Playwright OK).

Otherwise the pipeline falls back to the keyword-only flow it had
before — this is purely additive.

Public surface:
  is_available()                — guard
  research_topic(topic, max_steps=6, channel_cfg=None) -> dict | None
"""
from __future__ import annotations
import json
import logging
import time
from typing import Optional

from modules import browser_agent, nim

log = logging.getLogger(__name__)

_SYSTEM = """You are a fact-finding research agent for a YouTube Shorts pipeline. \
Your job is to gather 4-6 verified, specific, surprising facts about a topic the \
user will give you, then return a JSON research bundle.

Rules:
- Use the provided tools (search, visit, read_text, extract_images) to find \
real information from the web. Do not invent facts.
- Prefer authoritative sources: Wikipedia, established news outlets, \
academic sources, official websites.
- Each "fact" must be a single concrete claim, ideally with a number, date, \
name, or specific detail. Avoid vague generalities.
- Spend no more than {max_steps} tool calls total. Be efficient — search once, \
visit once, read once is often enough.
- When done gathering facts, return JSON with this exact shape (no markdown):
{{
  "headline":   "<one-line attention-grabbing summary of the topic>",
  "facts":      ["fact 1", "fact 2", ...],            // 4-6 specific claims
  "sources":    ["https://...", ...],                 // URLs you actually visited
  "image_urls": ["https://...", ...],                 // optional, 0-6 hero images
  "search_keywords": ["short kw", "short kw", ...]    // 6-10 stock-footage queries
}}

If a tool errors or returns nothing useful, try a different query rather than \
giving up. If the topic is unverifiable (pure opinion, fiction), set facts \
to general talking points and return promptly."""


def is_available() -> bool:
    return browser_agent.is_available()


def _build_initial_messages(topic: str, channel_hint: str, max_steps: int) -> list[dict]:
    sys_msg = _SYSTEM.format(max_steps=max_steps)
    user_msg = (
        f"Topic to research: {topic.strip()}\n"
        f"Channel style hint: {channel_hint}\n\n"
        f"Find me 4-6 specific verified facts plus images. Return the JSON bundle when done."
    )
    return [
        {"role": "system", "content": sys_msg},
        {"role": "user",   "content": user_msg},
    ]


def _execute_tool(session: browser_agent.Session, name: str, args: dict) -> str:
    """Run one tool call and return its result as a string (which NIM
    will see as the tool message content)."""
    try:
        if name == "search":
            results = session.search(args.get("query", ""))
            return json.dumps(results)[:4000]
        if name == "visit":
            return session.visit(args.get("url", ""))
        if name == "read_text":
            return session.read_text(args.get("max_chars", 4000))
        if name == "extract_images":
            return json.dumps(session.extract_images(args.get("min_width", 400)))
        return f"unknown tool: {name}"
    except Exception as e:
        log.warning(f"research_agent tool {name} threw: {e}")
        return f"tool error: {e!s}"


def research_topic(
    topic: str,
    max_steps: int = 6,
    channel_cfg: Optional[dict] = None,
    overall_timeout_sec: int = 180,
) -> Optional[dict]:
    """Run a NIM-driven browser research loop on `topic`. Returns the
    parsed JSON bundle, or None if Playwright isn't available / NIM
    refuses to finalise within the budget.

    Best-effort. Caller falls back to the keyword-only flow on None.
    """
    if not is_available():
        log.info("research_agent: skipped (browser_agent unavailable)")
        return None
    topic = (topic or "").strip()
    if not topic:
        return None

    channel_hint = (
        f"channel '{channel_cfg.get('name')}' tone={channel_cfg.get('tone')!r}"
        if channel_cfg else "generic"
    )
    messages = _build_initial_messages(topic, channel_hint, max_steps)

    start = time.time()
    session = browser_agent.Session(headless=True)
    try:
        for step in range(max_steps + 2):    # +2 = some headroom for the final answer
            if time.time() - start > overall_timeout_sec:
                log.warning(f"research_agent: overall timeout {overall_timeout_sec}s hit")
                return None
            try:
                resp = nim.chat_with_tools(
                    messages,
                    tools=browser_agent.TOOL_DEFS,
                    max_tokens=1500,
                    temperature=0.4,
                    timeout=60,
                )
            except Exception as e:
                log.warning(f"research_agent: NIM chat_with_tools failed: {e}")
                return None

            content = resp.get("content")
            tool_calls = resp.get("tool_calls") or []

            if tool_calls:
                # Echo the assistant's tool-call message back, then run
                # each call and append a tool-role result.
                messages.append({
                    "role": "assistant",
                    "content": content or "",
                    "tool_calls": tool_calls,
                })
                for tc in tool_calls:
                    fn = (tc.get("function") or {}).get("name", "")
                    args_raw = (tc.get("function") or {}).get("arguments") or "{}"
                    try:
                        args = json.loads(args_raw)
                    except Exception:
                        args = {}
                    log.info(f"research_agent step {step}: tool {fn}({list(args)})")
                    result = _execute_tool(session, fn, args)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id"),
                        "content": result,
                    })
                continue

            # No tool calls → model gave a final answer. Parse JSON.
            txt = (content or "").strip()
            if not txt:
                return None
            # Tolerate fenced JSON.
            if txt.startswith("```"):
                txt = txt.strip("`")
                if txt.lower().startswith("json"):
                    txt = txt[4:]
                txt = txt.strip()
            try:
                parsed = json.loads(txt)
            except Exception as e:
                log.warning(f"research_agent: final answer wasn't JSON: {e} — first 300 chars: {txt[:300]}")
                return None
            # Light validation.
            if not isinstance(parsed, dict):
                return None
            parsed.setdefault("headline", topic)
            parsed.setdefault("facts", [])
            parsed.setdefault("sources", [])
            parsed.setdefault("image_urls", [])
            parsed.setdefault("search_keywords", [])
            log.info(
                f"research_agent: done in {time.time()-start:.1f}s — "
                f"{len(parsed['facts'])} facts, {len(parsed['sources'])} sources, "
                f"{len(parsed['image_urls'])} images"
            )
            return parsed

        log.warning("research_agent: exhausted step budget without final answer")
        return None
    finally:
        session.close()

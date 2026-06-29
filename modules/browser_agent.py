"""
browser_agent.py — Headless Chromium driven by NIM tool-calls.

What this is:
  A small set of tools that NIM (via function-calling) can use to do
  real research from inside a Playwright-controlled Chromium. The agent
  loop in modules/research_agent.py composes these into multi-step
  research (fact-check a claim, find an image, scrape a Wikipedia
  summary, etc.).

What this is NOT:
  A general-purpose web scraper or anything that runs without explicit
  NIM intent. The agent loop has step limits + tool-call timeouts to
  prevent runaway browsing.

Optional dep: playwright. If the import fails, is_available() returns
False and every tool no-ops with a clear error message. The script
stage in main.py only invokes this when the channel's research_mode
is 'fact_research' AND is_available() is True — otherwise we fall
back to the existing keyword-only flow.

Public surface:
  is_available()                                    — torch-style guard
  start_session() -> Session                        — open Chromium
  Session.close()                                   — cleanup
  Session.search(query, engine='duckduckgo') -> list[dict]
  Session.visit(url) -> str          (title)
  Session.read_text(max_chars=4000) -> str
  Session.extract_images(min_w=400) -> list[str]
  Session.screenshot() -> bytes (png)
  TOOL_DEFS                                          — NIM tool schema

Tool schemas follow the OpenAI function-calling spec, which NIM's chat
completions endpoint accepts under tools=[...].
"""
from __future__ import annotations
import logging
import re
import time
from typing import Optional
from urllib.parse import quote_plus, urlparse, urljoin

log = logging.getLogger(__name__)

try:
    from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page  # type: ignore
    _HAS_PLAYWRIGHT = True
except Exception as _e:
    log.info(f"browser_agent: playwright unavailable ({_e.__class__.__name__}); browser tools disabled")
    sync_playwright = None  # type: ignore
    _HAS_PLAYWRIGHT = False


def is_available() -> bool:
    """True iff Playwright is importable AND its Chromium binary is on disk."""
    if not _HAS_PLAYWRIGHT:
        return False
    try:
        # Smoke test: open + close a context. Catches missing browser
        # binary ("Executable doesn't exist") at use time rather than
        # halfway through a render.
        with sync_playwright() as p:  # type: ignore
            b = p.chromium.launch(headless=True)
            b.close()
        return True
    except Exception as e:
        log.warning(f"browser_agent.is_available: playwright launch failed ({e}); "
                    f"run 'playwright install --with-deps chromium' on the worker")
        return False


# ── Tool schemas (OpenAI function-calling shape) ─────────────────
#
# NIM's chat completions endpoint accepts these on the `tools` param.
# The agent loop in research_agent.py converts tool_calls in the
# response into Session method calls and feeds results back as
# tool-role messages.
TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "Search the web (DuckDuckGo). Returns up to 10 result objects with title + url + snippet. Use this to find sources, fact-check claims, or locate images.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query — plain English."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "visit",
            "description": "Navigate the browser to a URL. Subsequent read_text / extract_images calls operate on this page. Returns the page's title.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full https:// URL"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_text",
            "description": "Return up to N chars of human-readable text from the currently-visited page (no nav / footer / ads). Default 4000 chars.",
            "parameters": {
                "type": "object",
                "properties": {
                    "max_chars": {"type": "integer", "description": "Truncate to this many chars (default 4000, max 12000).", "default": 4000},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_images",
            "description": "Return image URLs from the currently-visited page filtered by minimum width. Useful for finding hero images or illustrations of a specific topic.",
            "parameters": {
                "type": "object",
                "properties": {
                    "min_width": {"type": "integer", "description": "Minimum image width in pixels (default 400).", "default": 400},
                },
                "required": [],
            },
        },
    },
]


class Session:
    """One Playwright Chromium browser kept open for the duration of
    a research loop. Use as a context manager OR call close() manually.
    """

    def __init__(self, headless: bool = True, timeout_ms: int = 15_000):
        if not _HAS_PLAYWRIGHT:
            raise RuntimeError("playwright not installed; pip install -r requirements-browser.txt")
        self._pw = sync_playwright().start()  # type: ignore
        self._browser: Browser = self._pw.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",                # Colab/Kaggle run as root
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        self._ctx: BrowserContext = self._browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            ignore_https_errors=True,
        )
        self._page: Page = self._ctx.new_page()
        self._page.set_default_timeout(timeout_ms)
        self._timeout_ms = timeout_ms

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        try:
            self._ctx.close()
        except Exception:
            pass
        try:
            self._browser.close()
        except Exception:
            pass
        try:
            self._pw.stop()
        except Exception:
            pass

    # ── Tool implementations ─────────────────────────────────────

    def search(self, query: str, engine: str = "duckduckgo") -> list[dict]:
        """DuckDuckGo HTML search — no API key, no JS-rendering needed.
        Returns [{title, url, snippet}, ...] up to 10 results.
        """
        q = quote_plus(query.strip())
        if engine != "duckduckgo":
            engine = "duckduckgo"  # other engines deferred
        url = f"https://html.duckduckgo.com/html/?q={q}"
        try:
            self._page.goto(url, wait_until="domcontentloaded")
            time.sleep(0.6)
            results = []
            for el in self._page.query_selector_all("div.result")[:12]:
                a = el.query_selector("a.result__a")
                snippet = el.query_selector("a.result__snippet")
                if not a:
                    continue
                href = a.get_attribute("href") or ""
                title = (a.inner_text() or "").strip()
                # DDG html sometimes wraps URLs in a redirector — unwrap.
                if "/l/?uddg=" in href:
                    from urllib.parse import parse_qs, urlparse as _u
                    qs = parse_qs(_u(href).query)
                    real = qs.get("uddg", [None])[0]
                    if real:
                        href = real
                if not href.startswith("http"):
                    continue
                results.append({
                    "title":   title[:200],
                    "url":     href,
                    "snippet": ((snippet.inner_text() if snippet else "") or "").strip()[:300],
                })
                if len(results) >= 10:
                    break
            return results
        except Exception as e:
            log.warning(f"browser_agent.search({query!r}) failed: {e}")
            return []

    def visit(self, url: str) -> str:
        """Navigate to url. Returns the page title (or empty on failure)."""
        if not url.startswith(("http://", "https://")):
            return f"refused: {url!r} not an http(s) URL"
        try:
            self._page.goto(url, wait_until="domcontentloaded")
            time.sleep(0.4)
            t = self._page.title() or ""
            return t[:300]
        except Exception as e:
            log.warning(f"browser_agent.visit({url!r}) failed: {e}")
            return f"error: {e!s}"

    def read_text(self, max_chars: int = 4000) -> str:
        """Return cleaned visible text from the current page."""
        max_chars = max(200, min(int(max_chars or 4000), 12_000))
        try:
            html = self._page.content()
            from bs4 import BeautifulSoup  # type: ignore
            soup = BeautifulSoup(html, "html.parser")
            # Strip script / style / nav / footer noise.
            for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "form", "button"]):
                tag.decompose()
            text = soup.get_text("\n", strip=True)
            # Collapse adjacent blank lines.
            text = re.sub(r"\n{3,}", "\n\n", text)
            return text[:max_chars]
        except Exception as e:
            log.warning(f"browser_agent.read_text failed: {e}")
            return ""

    def extract_images(self, min_width: int = 400) -> list[str]:
        """Return absolute image URLs from the current page filtered by
        their rendered displayed width."""
        try:
            base = self._page.url
            imgs = self._page.eval_on_selector_all(
                "img",
                """(els) => els.map(e => ({
                    src: e.currentSrc || e.src || '',
                    w: e.naturalWidth || e.width || 0,
                    h: e.naturalHeight || e.height || 0,
                }))""",
            )
            min_w = max(50, int(min_width or 400))
            out: list[str] = []
            seen: set[str] = set()
            for it in imgs:
                src = (it.get("src") or "").strip()
                if not src or src.startswith("data:"):
                    continue
                w = int(it.get("w") or 0)
                if w and w < min_w:
                    continue
                abs_url = urljoin(base, src)
                if abs_url in seen:
                    continue
                seen.add(abs_url)
                out.append(abs_url)
            return out[:24]
        except Exception as e:
            log.warning(f"browser_agent.extract_images failed: {e}")
            return []

    def screenshot(self) -> bytes:
        try:
            return self._page.screenshot(type="png", full_page=False)
        except Exception as e:
            log.warning(f"browser_agent.screenshot failed: {e}")
            return b""

"""
seo_writer.py — Post-script viral-SEO metadata pass.

Runs AFTER the narration is finalized (script + audio pinned), so the
title/description/tags can be tuned to the actual chosen words rather
than the pre-writing prompt. Uses per-niche `viral_seo` templates from
CHANNEL_PRESETS (see modules/channels.py) so each niche gets the hook
patterns / tag ecosystems / category IDs that actually rank.

Output shape (strict — validated before returning):
{
  "youtube_title":         str,          # <= 60 chars, hits a niche hook pattern
  "description":           str,          # multi-line, hook-first-2-lines + body + CTA + hashtags + tag strip
  "tags":                  list[str],    # exactly 10, specific → broad
  "hashtags":              list[str],    # exactly 3 branded hashtags
  "pinned_comment":        str,          # ~1 sentence seeding engagement
  "thumbnail_text_ideas":  list[str],    # 3 short strings 3–5 words each
  "youtube_category_id":   int,          # niche's proven category
  "_source":               "nim" | "regex_fallback"
}

Never returns empty — if all NIM attempts fail, a regex fallback builds
a mediocre-but-usable block from the narration + niche seeds. Better to
publish something SEO-shaped than the literal string "Run <id>".
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

log = logging.getLogger(__name__)

_TITLE_MAX = 60
_TAGS_COUNT = 10
_HASHTAGS_COUNT = 3
_THUMB_IDEAS_COUNT = 3

_DEFAULT_BANNED_OPENERS = (
    "learn about", "in this video", "did you know", "today we",
    "let me tell", "have you ever", "welcome to", "hey guys",
)


# ── Public entry ──────────────────────────────────────────────────

def write_seo_metadata(
    *,
    narration: str,
    script: dict,
    channel_cfg: dict,
    research_data: Optional[dict] = None,
    borrowed_titles: Optional[list[str]] = None,
) -> dict:
    """Build the publish-ready metadata block for one run.

    Args:
      narration: the frozen script narration (word-for-word).
      script: the scriptwriter's output dict (has youtube_title, description,
              tags, search_keywords).
      channel_cfg: fully resolved channel preset (from channels.get_channel).
              Must include `viral_seo` — falls back to preset defaults if not.
      research_data: optional research dict (topic, facts, sources).
      borrowed_titles: optional list of top-ranking peer titles to inform tone.

    Returns:
      dict — always populated, never raises.
    """
    viral = (channel_cfg.get("viral_seo") or {}) if isinstance(channel_cfg, dict) else {}
    niche = channel_cfg.get("name", "generic") if isinstance(channel_cfg, dict) else "generic"

    # Try NIM first (up to 2 attempts with error feedback), then regex fallback.
    problems = []
    for attempt in range(1, 3):
        raw = _call_llm(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems)
        if not raw:
            break
        try:
            parsed = json.loads(_strip_fences(raw))
        except Exception as e:
            log.warning(f"seo_writer attempt {attempt}: invalid JSON: {e}")
            problems = [f"Your previous reply was not valid JSON ({e}). Reply again with ONLY the JSON object."]
            continue
        problems = _validate(parsed, viral)
        if not problems:
            parsed = _normalise(parsed, viral, script)
            parsed["_source"] = "nim"
            log.info(f"seo_writer: NIM metadata ready for niche={niche} "
                     f"lang={channel_cfg.get('language','en')!r} "
                     f"title='{parsed['youtube_title'][:40]}...'")
            return parsed
        log.warning(f"seo_writer attempt {attempt}: {problems}")

    log.warning(f"seo_writer: NIM path failed for niche={niche}; using regex fallback")
    return _regex_fallback(narration, script, channel_cfg, viral)


# ── NIM path ──────────────────────────────────────────────────────

def _call_llm(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems):
    """Single call. Returns raw model text on success, None on failure."""
    try:
        from modules import nim
    except Exception:
        return None
    if not nim.is_available():
        return None

    prompt = _build_prompt(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems)
    try:
        return nim.chat(
            [
                {"role": "system", "content": (
                    "You are a YouTube Shorts SEO strategist who has ranked "
                    "hundreds of videos to the top of niche search. Follow the "
                    "niche's proven hook patterns exactly. Respond with a single "
                    "JSON object only — no markdown fences, no preamble."
                )},
                {"role": "user", "content": prompt},
            ],
            max_tokens=1500,
            temperature=0.6,
            response_format={"type": "json_object"},
            timeout=180,
        )
    except Exception as e:
        log.warning(f"seo_writer NIM call failed: {e}")
        return None


def _build_prompt(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems):
    niche = channel_cfg.get("display_name") or channel_cfg.get("name") or "content"
    tone = channel_cfg.get("tone") or "engaging"
    language = channel_cfg.get("language") or "en"

    hook_patterns = viral.get("hook_patterns") or []
    banned_openers = viral.get("banned_openers") or list(_DEFAULT_BANNED_OPENERS)
    tag_seeds = viral.get("tag_seeds") or []
    hashtag_seeds = viral.get("hashtag_seeds") or []
    first_two = viral.get("description_first_two_lines") or "Open with the most surprising claim, then the specific mechanism."
    cta = viral.get("engagement_cta") or "Comment your thoughts below."
    cat_id = int(viral.get("youtube_category_id") or 22)

    facts = ""
    if research_data:
        f = research_data.get("facts") or []
        if f:
            facts = "\nVERIFIED FACTS from research (ground your metadata in these — invent nothing else):\n" \
                + "\n".join(f"- {x}" for x in f[:6])

    borrowed = ""
    if borrowed_titles:
        borrowed = "\nTOP-RANKING PEER TITLES for tone reference (do NOT copy — match the style):\n" \
            + "\n".join(f"- {x}" for x in borrowed_titles[:5])

    problem_block = ""
    if problems:
        problem_block = "\nFIX these problems from your previous attempt:\n" + "\n".join(f"- {p}" for p in problems)

    return f"""Niche: {niche}
Tone: {tone}
Language: {language}
YouTube category id (must be returned as an integer): {cat_id}

VIRAL HOOK PATTERNS for this niche (title MUST open with one of these, filling in the slots with SPECIFIC nouns from the narration below — NOT the literal placeholder text):
{chr(10).join(f'  - {p}' for p in hook_patterns) if hook_patterns else '  (none — use the tone above and open with the most surprising angle)'}

BANNED TITLE OPENERS (title must NOT begin with any of these — case-insensitive):
{chr(10).join(f'  - {b}' for b in banned_openers)}

TAG SEEDS for this niche (use most of these + add 2-3 long-tail extras from the narration):
{', '.join(tag_seeds) if tag_seeds else '(none — infer from the narration)'}

HASHTAG SEEDS (return exactly {_HASHTAGS_COUNT}, may swap for niche-relevant ones):
{', '.join(hashtag_seeds) if hashtag_seeds else '(infer 3 hashtags)'}

DESCRIPTION FIRST-2-LINES STYLE: {first_two}

ENGAGEMENT CTA style: {cta}
{facts}{borrowed}
NARRATION (this is the ACTUAL video — every metadata field must be tied to this content):
\"\"\"{narration.strip()}\"\"\"
{problem_block}

Return a JSON object with EXACTLY these keys:
- youtube_title: string, {_TITLE_MAX} chars max, opens with one of the hook patterns above with slots filled from the narration
- description: multi-line string with this structure:
    * Line 1-2: hook (this is what viewers see before "...more" — follow the first-2-lines style above)
    * Blank line
    * 3-5 short value-bullet lines starting with • that reference SPECIFIC content from the narration
    * Blank line
    * 1-line credibility or context
    * Blank line
    * CTA line (follow the CTA style above)
    * Blank line
    * The 3 hashtags on one line separated by spaces
    * Blank line
    * A single line of the 10 tags joined by ", "  (this improves search discoverability)
- tags: array of EXACTLY {_TAGS_COUNT} strings, ranked most-specific → broadest
- hashtags: array of EXACTLY {_HASHTAGS_COUNT} strings, each starting with #
- pinned_comment: 1-2 sentence comment to pin under the video that seeds discussion
- thumbnail_text_ideas: array of EXACTLY {_THUMB_IDEAS_COUNT} short 3-5 word strings for thumbnail overlay text
- youtube_category_id: integer, use {cat_id}

Reply with ONLY the JSON object, no markdown fences."""


# ── Validation ────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    t = (text or "").strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", t, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else t


def _validate(data: dict, viral: dict) -> list[str]:
    problems = []
    if not isinstance(data, dict):
        return ["response is not a JSON object"]

    title = data.get("youtube_title")
    if not isinstance(title, str) or not title.strip():
        problems.append("youtube_title missing or empty")
    else:
        if len(title) > _TITLE_MAX:
            problems.append(f"youtube_title too long ({len(title)} chars; max {_TITLE_MAX})")
        banned = [b.lower() for b in (viral.get("banned_openers") or _DEFAULT_BANNED_OPENERS)]
        low = title.strip().lower()
        for b in banned:
            if low.startswith(b):
                problems.append(f"youtube_title starts with banned opener '{b}'")
                break

    desc = data.get("description")
    if not isinstance(desc, str) or len(desc.strip()) < 60:
        problems.append("description missing or too short (need >=60 chars)")

    tags = data.get("tags")
    if not isinstance(tags, list):
        problems.append("tags is not a list")
    elif len(tags) != _TAGS_COUNT:
        problems.append(f"tags must have exactly {_TAGS_COUNT} items (got {len(tags)})")

    hashtags = data.get("hashtags")
    if not isinstance(hashtags, list):
        problems.append("hashtags is not a list")
    elif len(hashtags) != _HASHTAGS_COUNT:
        problems.append(f"hashtags must have exactly {_HASHTAGS_COUNT} items (got {len(hashtags)})")
    elif any(not isinstance(h, str) or not h.startswith("#") for h in hashtags):
        problems.append("every hashtag must be a string starting with #")

    thumb = data.get("thumbnail_text_ideas")
    if not isinstance(thumb, list) or len(thumb) != _THUMB_IDEAS_COUNT:
        problems.append(f"thumbnail_text_ideas must be a list of exactly {_THUMB_IDEAS_COUNT} strings")

    cat = data.get("youtube_category_id")
    if not isinstance(cat, int):
        try:
            int(cat)
        except Exception:
            problems.append("youtube_category_id must be an integer")

    return problems


def _normalise(data: dict, viral: dict, script: dict) -> dict:
    """Coerce lightly-off shapes into the strict shape (int coerce, trim, etc)."""
    out = dict(data)
    # Coerce category id
    try:
        out["youtube_category_id"] = int(out.get("youtube_category_id") or viral.get("youtube_category_id") or 22)
    except Exception:
        out["youtube_category_id"] = int(viral.get("youtube_category_id") or 22)
    # Trim title to hard cap
    if isinstance(out.get("youtube_title"), str):
        out["youtube_title"] = out["youtube_title"].strip()[:_TITLE_MAX]
    # Trim description of trailing whitespace
    if isinstance(out.get("description"), str):
        out["description"] = out["description"].strip()
    return out


# ── Regex fallback (never empty) ──────────────────────────────────

_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of",
    "in", "on", "at", "for", "with", "by", "from", "as", "is", "are",
    "was", "were", "be", "been", "being", "have", "has", "had", "do",
    "does", "did", "this", "that", "these", "those", "it", "its", "you",
    "your", "we", "our", "they", "their", "he", "she", "him", "her",
    "will", "would", "can", "could", "should", "may", "might", "not",
    "no", "yes", "up", "down", "out", "into", "over", "under", "very",
    "just", "only", "even", "also", "than", "when", "where", "how",
    "what", "why", "who", "which", "some", "any", "all",
}


def _regex_fallback(narration: str, script: dict, channel_cfg: dict, viral: dict) -> dict:
    """Cheap-but-usable metadata built from the narration + preset seeds.

    Called only when every NIM attempt failed. Guarantees a valid,
    publish-safe metadata block so a run never ships as `Run <id>`.
    """
    tag_seeds = list(viral.get("tag_seeds") or [])
    hashtag_seeds = list(viral.get("hashtag_seeds") or ["#shorts"])
    hook_patterns = viral.get("hook_patterns") or []
    cat_id = int(viral.get("youtube_category_id") or 22)
    niche = channel_cfg.get("display_name") or channel_cfg.get("name") or "content"

    # Prefer the scriptwriter's title if it exists and passes the ban list
    title = (script.get("youtube_title") or "").strip()
    banned = [b.lower() for b in (viral.get("banned_openers") or _DEFAULT_BANNED_OPENERS)]
    if not title or any(title.lower().startswith(b) for b in banned):
        # Build one from the first sentence of the narration + a niche pattern seed
        first_sentence = re.split(r"(?<=[.!?])\s+", narration.strip(), maxsplit=1)[0]
        first_words = " ".join(first_sentence.split()[:8]).rstrip(",.:;!?")
        if hook_patterns:
            title = f"{first_words[:_TITLE_MAX]}"
        else:
            title = first_words[:_TITLE_MAX]
    title = title[:_TITLE_MAX]

    # Description
    scripted_desc = (script.get("description") or "").strip()
    hook_line = title
    body = scripted_desc if scripted_desc else _summarise(narration, 300)
    bullets = _bullet_points(narration, 3)
    cta = viral.get("engagement_cta") or "Comment your thoughts below."
    hashtag_line = " ".join(hashtag_seeds[:_HASHTAGS_COUNT])

    # Tags — mix seed + top-frequency keywords from narration
    kw = _keyword_extract(narration, 6)
    tags = []
    for t in tag_seeds:
        if t and t not in tags:
            tags.append(t)
        if len(tags) >= _TAGS_COUNT:
            break
    for t in kw:
        if t and t not in tags:
            tags.append(t)
        if len(tags) >= _TAGS_COUNT:
            break
    while len(tags) < _TAGS_COUNT:
        tags.append(niche.lower())
    tags = tags[:_TAGS_COUNT]

    tag_strip = ", ".join(tags)
    description = "\n".join([
        hook_line,
        "",
        body[:400],
        "",
        *[f"• {b}" for b in bullets],
        "",
        cta,
        "",
        hashtag_line,
        "",
        tag_strip,
    ]).strip()

    # Thumbnail ideas — pick 3 short keyword phrases from the narration
    thumb = kw[:_THUMB_IDEAS_COUNT] if len(kw) >= _THUMB_IDEAS_COUNT else (kw + [niche] * _THUMB_IDEAS_COUNT)[:_THUMB_IDEAS_COUNT]
    thumb = [(" ".join(t.split()[:5])).upper() for t in thumb]

    # Pinned comment
    pinned = f"{cta} What did you think of this one?"

    return {
        "youtube_title": title,
        "description": description,
        "tags": tags,
        "hashtags": hashtag_seeds[:_HASHTAGS_COUNT] if len(hashtag_seeds) >= _HASHTAGS_COUNT
                    else (hashtag_seeds + ["#shorts", "#viral"])[:_HASHTAGS_COUNT],
        "pinned_comment": pinned,
        "thumbnail_text_ideas": thumb,
        "youtube_category_id": cat_id,
        "_source": "regex_fallback",
    }


def _summarise(text: str, max_chars: int) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t[:max_chars]


def _bullet_points(narration: str, n: int) -> list[str]:
    """Grab up to n punchy sentences from the narration for description bullets."""
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", (narration or "").strip()) if s.strip()]
    picks = []
    for s in sents:
        wc = len(s.split())
        if 5 <= wc <= 18:
            picks.append(s.rstrip("."))
        if len(picks) >= n:
            break
    while len(picks) < n and sents:
        picks.append(sents[0].rstrip("."))
        sents = sents[1:]
    return picks[:n]


def _keyword_extract(text: str, n: int) -> list[str]:
    """Naive frequency-based keyword picker for tags/thumbnails."""
    words = re.findall(r"[A-Za-z][A-Za-z\-']{2,}", (text or "").lower())
    freq = {}
    for w in words:
        if w in _STOPWORDS:
            continue
        freq[w] = freq.get(w, 0) + 1
    ranked = sorted(freq.items(), key=lambda kv: -kv[1])
    return [w for w, _ in ranked[:n]]

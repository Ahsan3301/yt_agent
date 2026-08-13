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
_HASHTAGS_COUNT = 8
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
    borrowed_tags: Optional[list[str]] = None,
    own_performance: Optional[str] = None,
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
      borrowed_tags: optional tags shared by top-ranking peers, most-common
              first. These are the keywords YouTube already associates with
              the topic, so echoing the relevant ones is what puts this
              video into the same suggestion graph.
      own_performance: optional prompt block listing THIS channel's own
              above-median titles with real view counts (see
              modules/performance.py). Stronger evidence than competitor
              titles, because it is the same audience — but only present
              once the channel has enough settled videos to mean anything.

    Returns:
      dict — always populated, never raises.
    """
    viral = (channel_cfg.get("viral_seo") or {}) if isinstance(channel_cfg, dict) else {}
    niche = channel_cfg.get("name", "generic") if isinstance(channel_cfg, dict) else "generic"

    # Try NIM first (up to 2 attempts with error feedback), then regex fallback.
    problems = []
    for attempt in range(1, 3):
        raw = _call_llm(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems, borrowed_tags, own_performance)
        if not raw:
            break
        try:
            parsed = json.loads(_strip_fences(raw))
        except Exception as e:
            log.warning(f"seo_writer attempt {attempt}: invalid JSON: {e}")
            problems = [f"Your previous reply was not valid JSON ({e}). Reply again with ONLY the JSON object."]
            continue
        # The model now returns youtube_title_candidates; collapse to
        # the single youtube_title BEFORE validating, so _validate's
        # existing contract (length, banned openers, language leak)
        # applies to the title we're actually going to publish.
        parsed = _collapse_title_candidates(parsed, viral)
        problems = _validate(
            parsed, viral,
            expected_language=(channel_cfg.get("language") or "en"),
        )

        # Claim check on the metadata, same wall the scriptwriter got.
        # A description is published text like any other: it is the first
        # thing a viewer reads and the part search indexes, so an invented
        # "studies show 80%" here is no less false than in the narration.
        #
        # The support corpus is deliberately WIDER than the scriptwriter's.
        # A description's job is to describe the video, so anything the
        # narration legitimately says is fair ground for it to repeat —
        # the narration passed its own claim check on the way here. Only
        # figures and sources that appear in NEITHER the narration nor the
        # research are inventions.
        try:
            from modules import factcheck as _fc
            _support = "\n".join(str(x) for x in (
                narration or "",
                (research_data or {}).get("raw_title") or "",
                (research_data or {}).get("summary") or "",
                *[str(f) for f in ((research_data or {}).get("facts") or [])],
                *[str(s) for s in ((research_data or {}).get("sources") or [])],
            ) if x)
            _checked = "\n".join(str(x) for x in (
                parsed.get("description") or "",
                parsed.get("youtube_title") or "",
            ) if x)
            _claims = _fc.unsupported_claims(_checked, _support)
            if _claims:
                log.warning(f"seo_writer attempt {attempt}: fabricated claims: {_claims}")
                problems.extend(_claims)
        except Exception as _e:                      # noqa: BLE001
            # A broken guard must never cost a render its metadata.
            log.debug(f"seo_writer factcheck skipped: {_e}")

        # Spoiler check. The prompt has asked for a "curiosity gap" all
        # along and titles kept shipping the answer instead. Shorts rank
        # on watch-through, so a title carrying the payoff is actively
        # self-defeating — it wins the impression and loses the view.
        # Checked after _collapse_title_candidates so it applies to the
        # title actually being published, not to a candidate we discard.
        try:
            from modules import retention_guard as _rg
            _spoil = _rg.title_spoils(parsed.get("youtube_title") or "", narration)
            if _spoil:
                log.warning(f"seo_writer attempt {attempt}: spoiler title: {_spoil}")
                problems.extend(_spoil)
        except Exception as _e:                      # noqa: BLE001
            log.debug(f"seo_writer spoiler check skipped: {_e}")

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

def _call_llm(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems, borrowed_tags=None, own_performance=None):
    """Single call. Returns raw model text on success, None on failure."""
    try:
        from modules import nim
    except Exception:
        return None
    if not nim.is_available():
        return None

    prompt = _build_prompt(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems, borrowed_tags, own_performance)
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


_LANG_NAMES = {
    "en":"English","de":"German","fr":"French","es":"Spanish",
    "it":"Italian","pt":"Portuguese","ru":"Russian","tr":"Turkish",
    "nl":"Dutch","pl":"Polish","ar":"Arabic","ur":"Urdu","hi":"Hindi",
    "bn":"Bengali","ja":"Japanese","ko":"Korean","zh":"Chinese",
    "vi":"Vietnamese","th":"Thai","id":"Indonesian",
}


def _build_prompt(narration, script, channel_cfg, viral, research_data, borrowed_titles, problems, borrowed_tags=None, own_performance=None):
    niche = channel_cfg.get("display_name") or channel_cfg.get("name") or "content"
    tone = channel_cfg.get("tone") or "engaging"
    language = channel_cfg.get("language") or "en"
    language_full = _LANG_NAMES.get(language, language)
    # If non-English, prepend a loud language directive. Minimax + Llama
    # otherwise default to the majority-language of the prompt (English)
    # and silently return an English title on a German script. Confirmed
    # live on 2026-07-09 with a de finance render.
    if language != "en":
        lang_block = (
            f"CRITICAL LANGUAGE REQUIREMENT\n"
            f"Write youtube_title, description, and pinned_comment "
            f"in {language_full} ({language}). The narration below is "
            f"in {language_full}. Do NOT translate to English. Do NOT "
            f"reply in English. A {language_full} video with an English "
            f"title is a bug that gets us reported for spam.\n"
            f"`tags` and `hashtags` MAY stay in English for YouTube SEO reach.\n\n"
        )
    else:
        lang_block = ""

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

    # Competitor tags are the one signal here that isn't a style hint:
    # they are the exact keywords YouTube already associates with this
    # topic, so reusing the relevant ones is what puts the video into
    # the same suggestion graph as the videos already ranking for it.
    # Deliberately permissive about copying (unlike titles) — tags are
    # keywords, not creative work, and divergence is what costs reach.
    borrowed_tag_block = ""
    if borrowed_tags:
        borrowed_tag_block = (
            "\nKEYWORDS THE TOP-RANKING PEERS ALREADY RANK FOR (most-shared first).\n"
            "Reuse every one that genuinely fits this narration — these are\n"
            "search terms, so matching them is the point. Skip any that don't\n"
            "describe THIS video; an irrelevant tag hurts more than it helps:\n"
            + "\n".join(f"- {x}" for x in borrowed_tags[:25])
        )

    # Placed AFTER the competitor block in the prompt on purpose: this
    # is the channel's own audience responding to its own videos, which
    # is stronger evidence than what worked for somebody else, and the
    # last thing before the narration carries the most weight.
    own_perf_block = f"\n{own_performance}" if own_performance else ""

    problem_block = ""
    if problems:
        problem_block = "\nFIX these problems from your previous attempt:\n" + "\n".join(f"- {p}" for p in problems)

    return f"""{lang_block}Niche: {niche}
Tone: {tone}
Language: {language_full} ({language}) — youtube_title/description/pinned_comment MUST be in this language
YouTube category id (must be returned as an integer): {cat_id}

VIRAL HOOK PATTERNS for this niche (title MUST follow the STRUCTURE of one of these, filling in the slots with SPECIFIC nouns from the narration — NOT the literal placeholder text{f". Patterns are shown in English for structure only — TRANSLATE the wording into {language_full} in your final title" if language != "en" else ""}):
{chr(10).join(f'  - {p}' for p in hook_patterns) if hook_patterns else '  (none — use the tone above and open with the most surprising angle)'}

BANNED TITLE OPENERS (title must NOT begin with any of these — case-insensitive):
{chr(10).join(f'  - {b}' for b in banned_openers)}

DO NOT CLAIM THE STORY IS TRUE unless the narration itself is built on
documented events. A live description read "True horror based on real
trail closures and unexplained phenomena" about a story that was written
from scratch — that is a fabricated claim of authenticity, and it is the
kind of thing that costs a channel its credibility when a viewer checks.
Nothing in the metadata may assert the events happened, cite a real place
as the setting of an invented event, or imply sourcing that does not
exist. Some tag seeds below contain the word "true" — those are search
terms people type, and using one as a TAG is fine. Writing "this is true"
in the description is not.

TAG SEEDS for this niche (use most of these + add 2-3 long-tail extras from the narration):
{', '.join(tag_seeds) if tag_seeds else '(none — infer from the narration)'}

HASHTAG SEEDS (return exactly {_HASHTAGS_COUNT}, may swap for niche-relevant ones):
{', '.join(hashtag_seeds) if hashtag_seeds else '(infer 3 hashtags)'}

DESCRIPTION FIRST-2-LINES STYLE: {first_two}

ENGAGEMENT CTA style: {cta}
{facts}{borrowed}{borrowed_tag_block}{own_perf_block}
NARRATION (this is the ACTUAL video — every metadata field must be tied to this content):
\"\"\"{narration.strip()}\"\"\"
{problem_block}

Return a JSON object with EXACTLY these keys:
- youtube_title_candidates: array of EXACTLY 3 DISTINCT title strings, each {_TITLE_MAX} chars max.
    Each must follow the STRUCTURE of one of the hook patterns above, with slots
    filled from the narration. Make the three genuinely different in angle —
    e.g. one number-led, one question, one contradiction — not three rewordings.
    Rules for every candidate (these decide whether anyone clicks):
      * Strong concrete nouns beat adjectives. Specific beats abstract.
      * Numbers outperform prose ("3", "$1000", "6 hours") — prefer a real
        figure drawn from the narration over a vague quantity.
      * Put the primary keyword in the FIRST 40 characters, for search.
      * Aim for a curiosity gap: the viewer clicks to close a loop the title
        opened. Do not resolve the loop in the title.
      * NO ALL CAPS, NO emoji, NO clickbait ("you won't believe",
        "shocked everyone", "gone wrong").
      * Target 45-58 characters — long enough to be specific, short enough
        to survive mobile truncation.
- description: multi-line string with this structure:
    * Opening hook, UNDER 150 CHARACTERS TOTAL before the first blank line.
      YouTube truncates at ~150 and this is the only description text most
      viewers ever read, and the part search weights most heavily. Follow the
      first-2-lines style above. Do not exceed 150 characters here.
    * Blank line
    * 2-3 short lines that set up WHY the video is worth watching, WITHOUT
      revealing what happens. NEVER list the events of the narration.
      A live description bulleted every single beat of a horror short,
      including its ending — anyone reading it had no reason to watch.
      Shorts are ranked on watch-through, so a description that spoils
      the video attacks the one signal that actually drives reach.
      Say what KIND of thing happens and what is at stake. Never the
      outcome, never the last line, never the twist.
    * Blank line
    * CTA line (follow the CTA style above)
    * Blank line
    * The first 3 hashtags on one line separated by spaces. These render
      as clickable links ABOVE the title, so they are real estate — make
      them specific.
    * NOTHING AFTER THE HASHTAGS. Do not append a comma-separated list
      of the tags. Tags belong in the `tags` field, which YouTube reads
      directly; repeating them as visible text is keyword stuffing,
      which YouTube's spam policy names explicitly, and it is the last
      thing a human reader sees.
- tags: array of EXACTLY {_TAGS_COUNT} strings, ranked most-specific → broadest
- hashtags: array of EXACTLY {_HASHTAGS_COUNT} strings, each starting with #.
    Order matters: the FIRST THREE are displayed above the video title, so make
    those the most specific and most searched. The remainder are for discovery
    only and should widen progressively toward the broad niche terms.
- pinned_comment: 1-2 sentence comment to pin under the video that seeds discussion
- thumbnail_text_ideas: array of EXACTLY {_THUMB_IDEAS_COUNT} short 3-5 word strings for thumbnail overlay text
- youtube_category_id: integer, use {cat_id}

Reply with ONLY the JSON object, no markdown fences."""


# ── Validation ────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    t = (text or "").strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", t, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else t


# Short English stopwords used to heuristically detect an English reply
# on a non-English render. Kept short so we don't false-positive on a
# German title that happens to contain "the" (uncommon) — we require
# THREE hits within the title+description head window to flag.
_EN_STOPWORDS = {
    "the","is","and","of","to","for","you","we","it","on","in","at",
    "how","why","what","when","this","that","with","from","by","was",
    "were","are","be","been","your","our","their","its","which","who",
    "will","can","could","should","would","if","but","or","not","no",
    "yes","did","does","do","have","has","had","made","make","just",
    "than","then","so","because","only","also","more","most","some",
    "any","all","one","two","three","four","five","after","before",
}


def _looks_english(text: str) -> bool:
    """Heuristic: >=3 English stopwords in the first ~30 words?"""
    if not text:
        return False
    words = [w.strip(".,;:!?()[]\"'").lower() for w in text.split()[:30]]
    hits = sum(1 for w in words if w in _EN_STOPWORDS)
    return hits >= 3



def _score_title(t: str, keyword: str = "") -> tuple[float, list[str]]:
    """Rank a candidate title on the levers that actually move CTR.

    Deliberately mechanical rather than another LLM call: it costs
    nothing, it's deterministic, and it's inspectable when a title
    comes out badly. Returns (score, reasons) — reasons are logged so
    a poor pick can be diagnosed rather than guessed at.
    """
    import re as _re
    score, why = 0.0, []
    t = (t or "").strip()
    if not t:
        return (-99.0, ["empty"])

    n = len(t)
    # 45-58 is the sweet spot: specific enough to earn a click, short
    # enough to survive mobile truncation.
    if 45 <= n <= 58:
        score += 3.0; why.append(f"len {n} ideal")
    elif 38 <= n < 45 or 58 < n <= _TITLE_MAX:
        score += 1.0; why.append(f"len {n} ok")
    else:
        why.append(f"len {n} poor")

    # A concrete figure is the single strongest signal we can detect.
    if _re.search(r"\d", t):
        score += 2.5; why.append("has number")

    # Proper nouns / specific entities beat abstractions.
    caps = _re.findall(r"[A-Z][a-z]{2,}", t)
    if len(caps) >= 1:
        score += 1.0; why.append(f"{len(caps)} proper noun(s)")

    # Keyword position matters for search, not just presence.
    if keyword:
        pos = t.lower().find(keyword.lower())
        if 0 <= pos <= 40:
            score += 2.0; why.append(f"keyword @{pos}")
        elif pos > 40:
            score += 0.5; why.append(f"keyword late @{pos}")

    # Open loops earn the click.
    if t.rstrip().endswith("?"):
        score += 1.0; why.append("question")

    # Penalise the things that get videos ignored or demoted.
    if t.isupper():
        score -= 3.0; why.append("ALL CAPS")
    if _re.search(r"[🌀-🫿☀-➿]", t):
        score -= 2.0; why.append("emoji")
    for bad in ("you won't believe", "shocked everyone", "gone wrong",
                "this happened", "must see", "number one trick"):
        if bad in t.lower():
            score -= 3.0; why.append(f"clickbait '{bad}'")
            break

    return (score, why)


def _pick_title(candidates: list, keyword: str = "") -> str:
    """Choose the best candidate, logging the comparison."""
    scored = []
    for c in candidates:
        if isinstance(c, str) and c.strip():
            sc, why = _score_title(c, keyword)
            scored.append((sc, c.strip(), why))
    if not scored:
        return ""
    scored.sort(key=lambda x: x[0], reverse=True)
    for sc, c, why in scored:
        log.info(f"seo: title candidate [{sc:+.1f}] {c!r} ({', '.join(why)})")
    log.info(f"seo: picked {scored[0][1]!r}")
    return scored[0][1]


def _trim_title(t: str) -> str:
    """Hard-cap without cutting mid-word.

    The previous `strip()[:60]` could slice a word in half, which reads
    as broken rather than concise.
    """
    t = (t or "").strip()
    if len(t) <= _TITLE_MAX:
        return t
    cut = t[:_TITLE_MAX]
    sp = cut.rfind(" ")
    # Only back off to a word boundary if it doesn't gut the title.
    if sp >= _TITLE_MAX * 0.6:
        cut = cut[:sp]
    return cut.rstrip(" ,;:-—")


def _collapse_title_candidates(data: dict, viral: dict) -> dict:
    """Pick one title from the candidate list, on measurable criteria.

    Runs before validation so the rest of the module keeps working
    with a single `youtube_title`, exactly as it did before. Models
    that ignore the instruction and return a bare youtube_title still
    pass straight through.
    """
    if not isinstance(data, dict):
        return data
    cands = data.get("youtube_title_candidates")
    if not (isinstance(cands, list) and cands):
        return data
    keyword = ""
    try:
        seeds = viral.get("tag_seeds") or []
        keyword = str(seeds[0]) if seeds else ""
    except Exception:
        keyword = ""
    picked = _pick_title(cands, keyword)
    if picked:
        out = dict(data)
        out["youtube_title"] = _trim_title(picked)
        # Kept for a future real A/B loop — nothing consumes them yet,
        # but discarding them would throw away work already paid for.
        out["youtube_title_alternates"] = [
            c.strip() for c in cands
            if isinstance(c, str) and c.strip() and c.strip() != picked
        ][:2]
        return out
    return data


def _validate(data: dict, viral: dict, expected_language: str = "en") -> list[str]:
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
        # Number/noun agreement. Hook patterns interpolate a model-chosen
        # number in front of a hard-coded plural, and the model does pick
        # 1 and 0 — both shipped to YouTube on 2026-08-02 as "abandoned
        # for 1 years" and "abandoned for 0 years". Cheap to catch here,
        # where a failed check already triggers a rewrite attempt.
        _bad_plural = re.search(
            r"\b1\s+(years|months|weeks|days|hours|minutes|seconds|times|people|things|reasons|videos)\b",
            title, re.I,
        )
        if _bad_plural:
            problems.append(
                f"youtube_title says '1 {_bad_plural.group(1)}' — use the singular"
            )
        _zero = re.search(
            r"\b0\s+(years|months|weeks|days|hours|minutes)\b", title, re.I,
        )
        if _zero:
            problems.append(
                f"youtube_title says '0 {_zero.group(1)}', which is meaningless — "
                f"use a real figure from the narration or drop the number"
            )

    desc = data.get("description")
    if not isinstance(desc, str) or len(desc.strip()) < 60:
        problems.append("description missing or too short (need >=60 chars)")
    elif isinstance(desc, str):
        # These three shipped to YouTube for months. The prompt now
        # forbids them, but a prompt is a request — this is the gate.
        _d = desc.strip()

        # 1. Keyword stuffing. The old contract asked for the tag list to
        #    be repeated as visible text at the end. YouTube's spam policy
        #    names this directly, and it is what a human reader sees last.
        _last = [ln for ln in _d.splitlines() if ln.strip()][-1] if _d.splitlines() else ""
        if _last.count(",") >= 4 and not _last.strip().startswith("#"):
            problems.append(
                "description ends with a comma-separated keyword list — that is "
                "keyword stuffing. Delete that line entirely; tags belong in the "
                "`tags` field."
            )

        # 2. Spoilers. Bullets used to be sliced verbatim out of the
        #    narration, which on a 50-word Short reproduced the whole
        #    story including its ending.
        if "•" in _d:
            problems.append(
                "description contains • bullets. Remove them — they were being "
                "filled with the narration's own sentences, which gives away the "
                "video and destroys the watch-through Shorts are ranked on."
            )

        # 3. Fabricated authenticity on invented stories.
        _truth = re.search(
            r"\b(based on (a )?(real|true)|true story|really happened|actual events|"
            r"documented case|real events)\b", _d, re.I)
        if _truth:
            problems.append(
                f"description claims the story is real ('{_truth.group(0)}'). Unless "
                f"the narration was built from documented events, remove the claim — "
                f"asserting invented events are true is a credibility risk."
            )

    # Language leak check: if we asked for non-English metadata and the
    # title OR the first ~30 words of description look English, force a
    # retry with an explicit problem string. Confirmed live: minimax-m3
    # ignored a single-line "Language: de" directive and returned an
    # English title on a German finance render.
    if expected_language and expected_language != "en":
        lang_full = _LANG_NAMES.get(expected_language, expected_language)
        combined = f"{title or ''} {(desc or '')[:200]}"
        if _looks_english(combined):
            problems.append(
                f"youtube_title/description came back in ENGLISH; must be in "
                f"{lang_full} ({expected_language}). Rewrite title, description, "
                f"and pinned_comment entirely in {lang_full}. Keep tags/hashtags "
                f"as they are."
            )

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
    if isinstance(out.get("youtube_title"), str):
        out["youtube_title"] = _trim_title(out["youtube_title"])
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

    # NO bullets and NO tag strip.
    #
    # _bullet_points slices sentences verbatim out of the narration, so
    # on a 50-word Short it reproduced the entire story — including the
    # ending — above the fold. Shorts rank on watch-through; a
    # description that gives away the video attacks the only signal that
    # matters. And the trailing ", ".join(tags) was visible keyword
    # stuffing, which YouTube's spam policy names directly. The tags go
    # in the `tags` field, which YouTube reads on its own.
    #
    # This is the fallback path, so it must be safe rather than clever:
    # a hook, one line of context, the CTA, three hashtags.
    description = "\n".join([
        hook_line,
        "",
        _summarise(narration, 180),
        "",
        cta,
        "",
        hashtag_line,
    ]).strip()

    # Thumbnail ideas — pick 3 short keyword phrases from the narration
    thumb = kw[:_THUMB_IDEAS_COUNT] if len(kw) >= _THUMB_IDEAS_COUNT else (kw + [niche] * _THUMB_IDEAS_COUNT)[:_THUMB_IDEAS_COUNT]
    thumb = [(" ".join(t.split()[:5])).upper() for t in thumb]

    # Pinned comment — language-aware suffix so a German channel doesn't
    # ship an English "What did you think of this one?" tag on the pinned
    # comment when the NIM path fails and this regex-fallback fires.
    language = (channel_cfg.get("language") or "en").lower()
    _PINNED_SUFFIX = {
        "en": "What did you think of this one?",
        "de": "Was hältst du davon?",
        "fr": "Qu'en pensez-vous ?",
        "es": "¿Qué opinas de esto?",
        "it": "Cosa ne pensi?",
        "pt": "O que você achou disso?",
        "ru": "Что думаете об этом?",
        "tr": "Bunu ne düşünüyorsun?",
        "nl": "Wat vind je hiervan?",
        "pl": "Co o tym sądzisz?",
        "ar": "ما رأيك في هذا؟",
        "ur": "آپ کا اس بارے میں کیا خیال ہے؟",
        "hi": "आपको यह कैसा लगा?",
        "bn": "আপনি এটা সম্পর্কে কি মনে করেন?",
        "ja": "これについてどう思いますか？",
        "ko": "이것에 대해 어떻게 생각하세요?",
        "zh": "你觉得这个怎么样？",
        "vi": "Bạn nghĩ gì về điều này?",
        "th": "คุณคิดยังไงกับเรื่องนี้?",
        "id": "Bagaimana pendapatmu?",
    }
    pinned = f"{cta} {_PINNED_SUFFIX.get(language, _PINNED_SUFFIX['en'])}"

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

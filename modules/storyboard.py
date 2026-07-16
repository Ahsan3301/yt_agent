"""
storyboard.py — Convert narration into a structured shot list.

A *storyboard* is the bridge between "we have a script" and "we have images".
Each shot ties one excerpt of the narration to:
  - a visual_description (what the viewer should see at that moment)
  - a search_query (for stock libraries)
  - an ai_prompt (for text-to-image generation)

The pipeline downstream uses these to fetch + vision-validate one image per
shot, so every frame on screen is intentional rather than "whatever the
keyword search returned first".
"""
import json
import logging
import re
from modules import nim

log = logging.getLogger(__name__)

STORYBOARD_PROMPT = """You are a professional storyboard artist.

Below is a 60-second YouTube Short NARRATION. Break it into exactly {n} SHOTS
in narrative order. Each shot must cover 1-3 sentences of the narration so
the entire narration is fully assigned across the {n} shots.

NARRATION:
\"\"\"
{narration}
\"\"\"

CHANNEL GENRE + TONE:
  {genre_tone}

VISUAL STYLE FOR THIS CHANNEL:
  {visual_style}

STOCK-FOOTAGE KEYWORDS THAT WORK FOR THIS CHANNEL (use as inspiration,
not verbatim — expand into concrete per-shot subjects that MATCH the
specific sentence being narrated):
  {keyword_examples}

FIRST: pick ONE `story_period` describing the SETTING TIME + PLACE that all
shots share, e.g. "present-day suburban USA", "Victorian London 1888",
"medieval Scottish highlands", "1970s American diner", "near-future
Tokyo". Every shot's props, costumes, and technology must be internally
consistent with this period — this is CRITICAL to prevent the image
model from mashing eras together (rotary phone glued to a smartphone,
medieval knight with a wristwatch, etc.).

THE PERIOD MUST COME FROM THE NARRATION, NOT FROM THE CHANNEL'S VISUAL
STYLE. Read the narration for technology and setting cues FIRST:
  - smartphones, texting, apps, wifi, Airbnb, rideshares, laptops,
    security cameras, social media → story_period MUST be present-day.
  - gas lamps, carriages, telegrams, servants' bells → period setting OK.
The channel style keywords (e.g. "candlelit", "victorian", "gothic")
describe LIGHTING and MOOD ONLY — they are NOT an instruction to
relocate a modern story into the past. A story about text messages set
in "Victorian England" produces absurd images (a rotary telephone
"displaying" a text message) and MUST NOT happen.

For EACH shot return:
  - narration_excerpt: the exact substring of the narration this shot covers.
    Concatenated in order, the excerpts must reconstruct the full narration
    (you may collapse whitespace, but otherwise verbatim).
  - period: SAME time-period phrase as story_period (or a tighter refinement
    for that specific shot, e.g. "1888 gaslit street"). Never introduce a
    period different from story_period.
  - visual_description: 1-2 sentences describing what we see on screen during
    these words. Concrete subject, lighting, composition. Grounded in what
    the sentence is literally about — not decorative genre atmosphere.
    Name specific real objects (e.g. "rotary telephone", "Model T Ford",
    "iPhone 15", "medieval broadsword") — never bare category nouns
    ("phone", "car", "sword") that let the image model guess wrong.
  - search_query: 3 to 5 GENERIC words that a stock library like Shutterstock
    or Pexels will ACTUALLY have matches for. Do NOT include specific
    names, dates, institutions, unique research findings, or technical
    jargon — those return zero results.
      • BAD (too specific, zero matches): "MIT visual cortex brain scan
        predictive timing 2019", "Baikonur Soyuz 2.1a first stage separation".
      • GOOD (generic subjects a library actually stocks): "rocket
        launch cosmodrome sunrise", "neural network brain scan", "person
        looking at stars".
    Prefer common photography subjects (people, places, objects, weather,
    nature) over niche subjects. The AI image gen provider will use the
    much richer `ai_prompt` field for accuracy — search_query only needs
    to find a decent generic stock stand-in.
  - ai_prompt: a full text-to-image generation prompt (1-3 sentences).
    Describe the specific subject the shot depicts. End with the
    channel's style keywords: "{style_keywords_tail}".

RULES:
  - Shots must flow narratively — the visuals must MATCH what each
    specific sentence is describing. Do not sprinkle generic
    channel-atmosphere imagery in place of the actual subject.
  - No two consecutive shots should depict the same subject in the same way.
  - Stay on-genre for the channel: {avoid_line}

Respond with ONLY a JSON object in this shape:
{{
  "story_period": "...",
  "shots": [
    {{
      "narration_excerpt": "...",
      "period": "...",
      "visual_description": "...",
      "search_query": "...",
      "ai_prompt": "..."
    }},
    ...
  ]
}}
The "shots" array MUST contain exactly {n} entries."""


# Per-channel guidance blocks. Keys match modules.channels.CHANNEL_PRESETS
# names. `default` is used for unknown channels (or custom user channels).
_GENRE_TONE_BY_CHANNEL: dict[str, dict[str, str]] = {
    "horror": {
        # NOTE: "victorian/candlelit" here are MOOD references, not an
        # era instruction — the storyboard prompt explicitly tells the
        # LLM to derive story_period from the narration's technology.
        # (2026-07-16: an Airbnb/smartphone story got anchored to
        # "Victorian-era England" because of these keywords, producing
        # rotary telephones that "display text messages".)
        "genre_tone":       "chilling gothic horror. Viewer should feel physically uneasy by the end. Visual reference: Hereditary / The Witch / Midsommar — atmospheric, decaying, shadow-soaked, fog, occult, supernatural threat. Mood only: derive the actual era from the narration.",
        "visual_style":     "low-key lighting, cool desaturated palette, fog, film grain, night-time or dimly-lit interiors. Period detail ONLY when the narration itself is period-set.",
        "avoid_line":       "no daylight, no contemporary office/urban imagery, no cartoons or illustrations.",
        "style_keywords_tail": "cinematic, 35mm film, candlelight, fog, victorian gothic, atmospheric horror, dramatic shadows, dread-soaked",
    },
    "wisdom": {
        "genre_tone":       "inspirational, contemplative, uplifting. Viewer should feel encouraged and thoughtful.",
        "visual_style":     "warm cinematic tones, golden-hour lighting, natural landscapes, soft focus, professional photography.",
        "avoid_line":       "no dark/gothic imagery, no cluttered scenes, no cartoons.",
        "style_keywords_tail": "cinematic, golden hour, soft focus, professional photography, inspirational",
    },
    "science": {
        "genre_tone":       "clear, awe-inspiring science communication. Viewer should feel curious and informed.",
        "visual_style":     "sharp, clean, high-detail. Space photography, laboratory shots, microscopy, technical diagrams, telescope imagery, well-lit modern research settings.",
        "avoid_line":       "no cartoons, no vague abstract shots, no horror atmosphere, no daylight rejection — daylight is often correct (labs, observatories).",
        "style_keywords_tail": "photorealistic, high-detail, cinematic, professional science photography, crisp lighting",
    },
    "finance": {
        "genre_tone":       "sharp, analytical, contemporary business. Viewer should feel informed and slightly urgent.",
        "visual_style":     "modern office, market charts, city skylines, close-ups of currency/screens, motion-blurred trading floors.",
        "avoid_line":       "no horror imagery, no rural/nature-only imagery, no cartoons.",
        "style_keywords_tail": "cinematic, high-contrast, modern business, sharp focus, professional photography",
    },
}


def _genre_block(channel: str) -> dict[str, str]:
    """Return the storyboard prompt slot values for `channel`. Falls back
    to a neutral default for unknown/custom channels so their scripts
    still get channel-relevant shots instead of hardcoded horror."""
    if channel in _GENRE_TONE_BY_CHANNEL:
        d = _GENRE_TONE_BY_CHANNEL[channel]
    else:
        d = {
            "genre_tone":       f"channel niche: {channel}. Match tone + subject to what the narration actually describes.",
            "visual_style":     "photorealistic, cinematic, grounded in the specific subject of each sentence.",
            "avoid_line":       "no cartoons or illustrations unless the narration explicitly calls for them.",
            "style_keywords_tail": "cinematic, photorealistic, professional photography, sharp focus",
        }
    # Try to pull channel footage_keywords for keyword_examples if
    # channels.py knows about the channel.
    try:
        from modules import channels as _ch
        preset = _ch.CHANNEL_PRESETS.get(channel) or {}
        kws = preset.get("footage_keywords") or []
        keyword_examples = ", ".join(kws[:6]) if kws else "(no channel keywords defined — infer from the narration itself)"
    except Exception:
        keyword_examples = "(unknown)"
    return {**d, "keyword_examples": keyword_examples}


def _strip_fences(text):
    t = (text or "").strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", t, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else t


def _salvage_partial_json(text: str):
    """When Nemotron truncates mid-string on shot N, recover shots 1..N-1.

    Strategy: find each top-level '{...}' inside the shots array by
    tracking brace depth + escape-aware string state. Keep only the
    ones that parse individually, then wrap in a valid envelope.
    Cheap + brittle enough that it only kicks in when json.loads
    already failed.
    """
    try:
        # Trim to the shots array boundary.
        arr_start = text.find("\"shots\"")
        if arr_start < 0:
            return None
        arr_start = text.find("[", arr_start)
        if arr_start < 0:
            return None
        i = arr_start + 1
        objects: list[dict] = []
        n = len(text)
        while i < n:
            # Skip whitespace + commas.
            while i < n and text[i] in ", \t\n\r":
                i += 1
            if i >= n or text[i] != "{":
                break
            # Walk one object with brace depth + string awareness.
            depth = 0
            in_str = False
            esc = False
            j = i
            while j < n:
                ch = text[j]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == "\"":
                        in_str = False
                elif ch == "\"":
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            if depth != 0 or j > n:
                break  # ran off the end mid-object → truncated shot, stop
            chunk = text[i:j]
            try:
                obj = json.loads(chunk)
            except Exception:
                break
            if isinstance(obj, dict):
                objects.append(obj)
            i = j
        if not objects:
            return None
        return {"shots": objects}
    except Exception:
        return None


REQUIRED_KEYS = ("narration_excerpt", "visual_description", "search_query", "ai_prompt")


def _well_formed(shot):
    """A shot is usable if all four required string fields are non-empty."""
    if not isinstance(shot, dict):
        return False
    for k in REQUIRED_KEYS:
        v = shot.get(k)
        if not isinstance(v, str) or not v.strip():
            return False
    return True


def plan_shots(narration, num_shots, channel: str = "horror",
               max_attempts=2, language: str = "en", tone_override: str = ""):
    """
    Ask NIM to break `narration` into ~`num_shots` storyboard shots.

    `channel` selects the genre/tone/visual-style/keyword block injected
    into the prompt. `language` + `tone_override` were added 2026-07-13
    (audit #11): previously the storyboard prompt was entirely English +
    used the hardcoded per-niche tone block, so a Spanish-narration
    channel with a per-channel tone override got English-only-genre-
    hardcoded shots that didn't reflect the operator's tone choice.

    Returns a list of shot dicts (only the well-formed ones — the LLM
    sometimes emits a trailing empty entry, especially near the token
    budget; we tolerate that by dropping it instead of rejecting the whole
    response and re-running the slow 70b model).

    Returns None only if no attempt produced ANY usable shots.
    """
    if not nim.is_available():
        log.warning("NIM not available — cannot generate storyboard")
        return None

    genre_slots = _genre_block(channel)
    # Overlay a per-channel tone if the operator set one — it wins over
    # the niche-preset genre_tone. Preserves the visual_style/avoid_line
    # so the visual palette stays niche-appropriate.
    _tone_clean = str(tone_override or "").strip()
    if _tone_clean:
        genre_slots = dict(genre_slots)
        genre_slots["genre_tone"] = (
            f"{_tone_clean} (operator-set tone for this channel — takes "
            f"priority over the niche default). "
            f"Original niche framing: {genre_slots.get('genre_tone', '')}"
        )
    # Language hint: narration_excerpt fields are already in the target
    # language (verbatim from the script). The prompt itself stays English
    # so the LLM's structured output stays consistent, but we tell it the
    # narration language so it doesn't try to "correct" foreign-language
    # excerpts back to English inside its analysis.
    lang_hint = ""
    if language and language != "en":
        lang_hint = (
            f"\n\nNARRATION LANGUAGE: The narration above is written in "
            f"language code '{language}'. Preserve every narration_excerpt "
            f"VERBATIM in that language — do not translate. "
            f"visual_description / search_query / ai_prompt fields stay "
            f"in English so downstream image search + generation work."
        )

    prompt = STORYBOARD_PROMPT.format(
        narration=narration.strip(),
        n=num_shots,
        **genre_slots,
    ) + lang_hint
    last_raw = ""
    best_partial = None  # remember the best partial across attempts

    for attempt in range(1, max_attempts + 1):
        try:
            raw = nim.chat(
                [
                    {"role": "system", "content":
                        "You are a professional storyboard artist. Reply with a single JSON object only. "
                        "Match the visual language to the channel genre described in the user message; "
                        "each shot's visual_description must depict what the assigned narration excerpt "
                        "is literally about, not generic channel atmosphere."},
                    {"role": "user", "content": prompt},
                ],
                # Bumped 4096 → 8192 after Nemotron kept truncating
                # long detailed shot arrays mid-string at ~char 4640.
                max_tokens=8192,
                temperature=0.6,
                response_format={"type": "json_object"},
                # chat() auto-streams when max_tokens > 1024 — this is the
                # total wall-clock budget, not per-read timeout.
                timeout=240,
            )
        except Exception as e:
            log.warning(f"Storyboard NIM call failed (attempt {attempt}): {e}")
            continue

        last_raw = raw
        try:
            data = json.loads(_strip_fences(raw))
        except json.JSONDecodeError as e:
            # Salvage a truncated response — the model ran out of tokens
            # mid-shot. Find the last complete shot object and rebuild
            # a valid JSON envelope around it.
            salvaged = _salvage_partial_json(_strip_fences(raw))
            if salvaged is not None:
                log.warning(f"Storyboard JSON parse failed (attempt {attempt}): {e} — salvaging partial")
                data = salvaged
            else:
                log.warning(f"Storyboard JSON parse failed (attempt {attempt}): {e}")
                continue

        raw_shots = data.get("shots") if isinstance(data, dict) else None
        if not isinstance(raw_shots, list) or not raw_shots:
            log.warning(f"Storyboard attempt {attempt}: no shots array")
            continue

        # Top-level story_period anchors every shot to a single era so
        # the image model can't mash a Model T + iPhone into one frame.
        story_period = ""
        if isinstance(data, dict):
            story_period = str(data.get("story_period") or "").strip()

        # Filter to well-formed shots. Empty trailing shots from token
        # truncation are dropped silently here.
        good = []
        for sh in raw_shots:
            if not _well_formed(sh):
                continue
            # Backfill missing period on a shot from the story-level
            # anchor. Nemotron occasionally forgets the per-shot period
            # but always fills story_period when we ask.
            if isinstance(sh, dict) and not str(sh.get("period") or "").strip() and story_period:
                sh["period"] = story_period
            good.append(sh)
        dropped = len(raw_shots) - len(good)
        if dropped:
            log.info(f"Storyboard attempt {attempt}: kept {len(good)} of {len(raw_shots)} shots (dropped {dropped} malformed)")

        if len(good) >= max(3, num_shots - 2):
            # Close enough to the target — accept.
            if story_period:
                log.info(f"Storyboard: story_period='{story_period}' — {len(good)} shots anchored to this era")
            return good

        # Otherwise keep the best partial in case all attempts come up short.
        if best_partial is None or len(good) > len(best_partial):
            best_partial = good

        log.warning(f"Storyboard attempt {attempt}: only {len(good)} usable shots (wanted ~{num_shots})")

    if best_partial:
        log.warning(f"Storyboard: returning best partial ({len(best_partial)} shots)")
        return best_partial

    log.error(f"Storyboard generation failed after {max_attempts} attempts. Last raw: {last_raw[:300]}")
    return None


def assign_timing(shots, total_duration):
    """
    Distribute total_duration across shots proportional to narration_excerpt
    character length. Returns shots mutated in place with `start` and `end`
    keys added.
    """
    if not shots:
        return shots
    weights = [max(len(sh.get("narration_excerpt", "")), 1) for sh in shots]
    total_w = sum(weights) or 1.0
    cursor = 0.0
    for sh, w in zip(shots, weights):
        dur = total_duration * (w / total_w)
        sh["start"] = cursor
        sh["end"] = cursor + dur
        cursor += dur
    # Snap last shot's end to exactly total_duration (eliminate rounding drift).
    if shots:
        shots[-1]["end"] = total_duration
    return shots

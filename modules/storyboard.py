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

For EACH shot return:
  - narration_excerpt: the exact substring of the narration this shot covers.
    Concatenated in order, the excerpts must reconstruct the full narration
    (you may collapse whitespace, but otherwise verbatim).
  - visual_description: 1-2 sentences describing what we see on screen during
    these words. Concrete subject, lighting, composition. Grounded in what
    the sentence is literally about — not decorative genre atmosphere.
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
  "shots": [
    {{
      "narration_excerpt": "...",
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
        "genre_tone":       "chilling gothic horror. Viewer should feel physically uneasy by the end. Visual reference: Hereditary / The Witch / Midsommar — atmospheric, decaying, candlelit, victorian, fog, occult, supernatural threat.",
        "visual_style":     "low-key lighting, cool desaturated palette, fog, film grain, victorian/period detail, night-time or candlelit interiors.",
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


def plan_shots(narration, num_shots, channel: str = "horror", max_attempts=2):
    """
    Ask NIM to break `narration` into ~`num_shots` storyboard shots.

    `channel` selects the genre/tone/visual-style/keyword block injected
    into the prompt. Previously the prompt was hardcoded for gothic-horror
    which produced off-topic shots (and thus off-topic images) for
    science / wisdom / finance channels. Now every channel gets prompts
    grounded in its actual subject matter.

    Returns a list of shot dicts (only the well-formed ones — the LLM
    sometimes emits a trailing empty entry, especially near the token
    budget; we tolerate that by dropping it instead of rejecting the whole
    response and re-running the slow 70b model).

    Returns None only if no attempt produced ANY usable shots.
    """
    if not nim.is_available():
        log.warning("NIM not available — cannot generate storyboard")
        return None

    prompt = STORYBOARD_PROMPT.format(
        narration=narration.strip(),
        n=num_shots,
        **_genre_block(channel),
    )
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
                # 4096 is plenty for ~15 detailed shots now that thinking
                # is suppressed at the NIM layer (chat_template_kwargs).
                max_tokens=4096,
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
            log.warning(f"Storyboard JSON parse failed (attempt {attempt}): {e}")
            continue

        raw_shots = data.get("shots") if isinstance(data, dict) else None
        if not isinstance(raw_shots, list) or not raw_shots:
            log.warning(f"Storyboard attempt {attempt}: no shots array")
            continue

        # Filter to well-formed shots. Empty trailing shots from token
        # truncation are dropped silently here.
        good = [sh for sh in raw_shots if _well_formed(sh)]
        dropped = len(raw_shots) - len(good)
        if dropped:
            log.info(f"Storyboard attempt {attempt}: kept {len(good)} of {len(raw_shots)} shots (dropped {dropped} malformed)")

        if len(good) >= max(3, num_shots - 2):
            # Close enough to the target — accept.
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

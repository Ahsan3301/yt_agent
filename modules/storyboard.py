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

STORYBOARD_PROMPT = """You are a horror-film storyboard artist.

Below is a 60-second YouTube Short NARRATION. Break it into exactly {n} SHOTS
in narrative order. Each shot must cover 1-3 sentences of the narration so
the entire narration is fully assigned across the {n} shots.

NARRATION:
\"\"\"
{narration}
\"\"\"

GENRE: chilling gothic horror. The viewer should be physically uneasy by
the end. Visual style: Hereditary / The Witch / Midsommar — atmospheric,
decaying, candlelit, victorian-gothic, fog, occult, supernatural threat.

For EACH shot return:
  - narration_excerpt: the exact substring of the narration this shot covers.
    Concatenated in order, the excerpts must reconstruct the full narration
    (you may collapse whitespace, but otherwise verbatim).
  - visual_description: 1-2 sentences describing what we see on screen during
    these words. Cinematic, dread-soaked, specific. Mention lighting and
    composition.
  - search_query: 3-6 word stock-photo search phrase that will surface real
    gothic-horror imagery on Shutterstock/Pexels/Pixabay. Concrete subject +
    setting + mood (e.g. "abandoned victorian asylum corridor candlelight").
    AVOID safe modern imagery ("rain on window", "coffee mug").
  - ai_prompt: a full text-to-image generation prompt (1-3 sentences). Style
    keywords at the end: "cinematic, 35mm film, candlelight, fog, victorian
    gothic, atmospheric horror, dramatic shadows, dread-soaked".

RULES:
  - Shots must flow narratively — the visuals escalate dread alongside the
    narration.
  - No two consecutive shots should depict the same subject in the same way.
  - No daylight, no contemporary office/urban imagery, no comic/cartoon.

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


def plan_shots(narration, num_shots, max_attempts=2):
    """
    Ask NIM to break `narration` into ~`num_shots` storyboard shots.

    Returns a list of shot dicts (only the well-formed ones — the LLM
    sometimes emits a trailing empty entry, especially near the token
    budget; we tolerate that by dropping it instead of rejecting the whole
    response and re-running the slow 70b model).

    Returns None only if no attempt produced ANY usable shots.
    """
    if not nim.is_available():
        log.warning("NIM not available — cannot generate storyboard")
        return None

    prompt = STORYBOARD_PROMPT.format(narration=narration.strip(), n=num_shots)
    last_raw = ""
    best_partial = None  # remember the best partial across attempts

    for attempt in range(1, max_attempts + 1):
        try:
            raw = nim.chat(
                [
                    {"role": "system", "content":
                        "You are a horror-film storyboard artist. Reply with a single JSON object only."},
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

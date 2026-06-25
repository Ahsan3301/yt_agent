"""
image_prompter.py — Craft story-specific text-to-image prompts.

Storyboard already produces a baseline ai_prompt per shot, but those are
often generic ("Create an image of a brass door handle..."). This module
takes the shot's narrative context and rewrites it as a *production-grade*
image-generation prompt: subject + composition + lens + lighting +
atmosphere + style tags, in the form that Flux/SDXL respond to best.

On retry (attempt > 0) it varies camera angle and composition so a failed
generation gets a fresh visual approach instead of the same prompt twice.
"""
import logging
from modules import nim

log = logging.getLogger(__name__)


# Compositional variants we cycle through on retry. Forces fresh angles
# instead of "same prompt with different seed produced same result".
_ANGLE_VARIANTS = [
    "wide establishing shot, low angle, deep shadows",
    "tight close-up, shallow depth of field, off-center subject",
    "over-the-shoulder POV, narrow corridor compressed by lens",
    "high overhead angle, isolated subject in negative space",
    "Dutch tilt, dim light from below, oppressive headroom",
]


_FX_TAGS_HORROR = (
    "cinematic 35mm film, dramatic chiaroscuro lighting, candlelight, "
    "fog, victorian gothic, atmospheric horror, dread-soaked, "
    "muted desaturated palette, deep blacks, fine film grain, "
    "photoreal, eerie stillness, no people in modern clothing"
)
_NEG_TAGS_HORROR = (
    "no daylight, no sunny, no cartoon, no anime, no comic, no text, "
    "no watermark, no modern office, no contemporary urban, no smiling people"
)


def _craft_prompt_template(narration_excerpt, visual_description, channel, attempt):
    angle = _ANGLE_VARIANTS[attempt % len(_ANGLE_VARIANTS)]
    if channel == "horror":
        style = _FX_TAGS_HORROR
        neg = _NEG_TAGS_HORROR
    else:
        style = ("cinematic, professional photography, golden hour, "
                 "depth of field, photoreal")
        neg = "no cartoon, no anime, no text, no watermark"

    return f"""You are a senior production designer. Write ONE rich text-to-image
prompt for a Flux/SDXL-class image model. The output will be rendered
as a single still inside a gothic-horror YouTube short.

The narration spoken DURING this shot:
  "{narration_excerpt}"

The director's visual intent for this shot:
  {visual_description}

Compositional approach for this attempt: {angle}

Rules:
  - The image must DEPICT the specific subject from the visual intent
    (not a generic horror scene). The viewer should connect what they
    see to what is being said.
  - Be concrete: name the subject, its setting, the lighting source,
    the mood. Avoid abstract emotions ("dread") — show what causes dread.
  - End with these style tags exactly: {style}
  - Then append: {neg}
  - 50-90 words total. One paragraph, no line breaks, no markdown,
    no preface, no quotes.

Respond with ONLY the image prompt text."""


def craft_image_prompt(narration_excerpt, visual_description,
                       channel="horror", attempt=0):
    """
    Return a polished text-to-image prompt for this shot, OR None if NIM
    is unavailable. Caller should fall back to the storyboard's raw
    ai_prompt in that case.

    `attempt` (0,1,2,...) varies the camera angle so retries don't
    produce the same image with a different seed.
    """
    if not nim.is_available():
        return None
    user = _craft_prompt_template(narration_excerpt, visual_description, channel, attempt)
    # JSON mode keeps reasoning models (Nemotron 120b) from rambling — when
    # they have a structured schema to fill, they produce the final answer
    # efficiently instead of burning tokens on internal monologue.
    user_json = user + (
        '\n\nRespond with ONLY a JSON object in this exact shape:\n'
        '{"prompt": "your single-paragraph image-generation prompt here"}'
    )
    import json as _json
    try:
        raw = nim.chat(
            [
                {"role": "system",
                 "content": "You write image-generation prompts. Reply with a single JSON object only."},
                {"role": "user", "content": user_json},
            ],
            max_tokens=600,
            temperature=0.7,
            response_format={"type": "json_object"},
            timeout=90,
        ).strip()
    except Exception as e:
        log.warning(f"image_prompter NIM call failed: {e}")
        return None

    if not raw:
        return None
    try:
        data = _json.loads(raw)
        prompt = (data.get("prompt") or "").strip()
    except Exception:
        # If JSON parse fails, treat raw text as the prompt directly.
        prompt = raw

    # Strip surrounding quotes if the model added them.
    if prompt.startswith(("\"", "'")) and prompt.endswith(("\"", "'")):
        prompt = prompt[1:-1].strip()
    prompt = " ".join(prompt.split())
    return prompt or None

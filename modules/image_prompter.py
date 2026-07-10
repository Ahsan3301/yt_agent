"""
image_prompter.py — Craft story-specific text-to-image prompts.

Rewritten 2026-07-10 against BFL's Flux 2 prompt-engineering guide + a
horror-cinematography research pass. Prior versions built comma-tag
prompt strings (SDXL-style) which actively degrade Flux 2 [klein]
output — klein's Qwen text encoder wants natural language, subject
first, no quality boosters, no negative-prompt tag list.

Structure this module enforces on every prompt it emits (per BFL):
  1. Subject (concrete noun first — highest attention weight)
  2. Setting / foreground / background depth layering
  3. Lighting source + direction + colour
  4. Camera: lens, film stock, angle, framing
  5. Atmosphere / mood as natural sentences (never tag lists)

Per-niche "style seeds" below tell the LLM what LOOK each niche wants
without dictating the specific prompt words — the LLM writes the actual
prompt using the seed as a directorial brief.

On retry (attempt > 0) it varies camera angle so a failed generation
gets a fresh visual approach instead of the same prompt twice.
"""
import logging
from modules import nim

log = logging.getLogger(__name__)


# Compositional variants cycled through on retry. All framed as
# natural-language camera directions (not tags) so the LLM can weave
# them into the sentence-form prompt Flux 2 klein prefers.
_ANGLE_VARIANTS = [
    "wide establishing shot from a low angle, deep foreground shadow, subject small in frame",
    "tight over-the-shoulder POV, shallow depth of field, subject off-center right",
    "static high overhead angle, subject isolated in negative space, cold empty floor around",
    "handheld shoulder-height medium shot, slight Dutch tilt, oppressive headroom",
    "extreme close-up on a single detail, the rest of the scene blurred and dark",
]


# Per-niche "style briefs" — written as natural-language directorial
# notes the LLM incorporates into its prompt. Each brief covers:
#   • palette + light direction (BFL says lighting has biggest quality impact)
#   • camera / lens / film stock (concrete + realism)
#   • storytelling rule specific to the niche
#   • "avoid" as a negative sentence, not a tag list
_NICHE_BRIEFS = {
    "horror": (
        "LOOK: cinematic 35mm horror still. Palette is desaturated cold "
        "blue-grey with a single unnatural warm accent (candle amber, "
        "sodium-lamp yellow, or an off-red glow) — never rainbow, never "
        "vibrant. LIGHT: one hard practical source only — a doorway sliver, "
        "a single bare bulb, moonlight through a window — casting deep "
        "chiaroscuro. Underlighting or backlighting preferred; flat "
        "overhead light is forbidden. CAMERA: shot on Arri Alexa with a "
        "vintage 32mm anamorphic lens, subtle film grain, f/2.0, wide "
        "cinematic 2.39:1 framing. STORYTELLING RULE: this shot works by "
        "IMPLIED presence, not explicit reveal — a door slightly ajar, an "
        "empty rocking chair still swaying, a silhouette at the far end "
        "of a hallway. Show what feels WRONG about an ordinary space, "
        "not a monster. Avoid: modern smartphones/laptops, smiling people, "
        "sunlit exteriors, comic-book gore, anime style, cheerful "
        "colours."
    ),
    "comedy": (
        "LOOK: bright, energetic, saturated but grounded — Wes Anderson "
        "meets modern YouTube-explainer aesthetic. Cheerful pastel "
        "palette with confident primary colour accents. LIGHT: soft even "
        "key light from one side, gentle fill, no harsh shadows, "
        "everything readable at a glance. CAMERA: shot on Fujifilm X-T5 "
        "with a 35mm f/2 lens, clean digital look, symmetrical framing, "
        "slight lens-flare warmth. STORYTELLING RULE: the visual should "
        "reinforce the comedic beat — exaggerated facial expression, "
        "impossibly-clean minimalist setting, or one absurd out-of-place "
        "object that lands the joke. Character-forward. Avoid: horror "
        "atmosphere, muddy palettes, night scenes, gore, sadness."
    ),
    "finance": (
        "LOOK: modern editorial-photography aesthetic used in Bloomberg / "
        "Reuters / WSJ features. Clean, deliberate, expensive-feeling. "
        "Palette: navy + charcoal + brushed steel + one warm amber accent. "
        "LIGHT: window light with soft directional falloff, or a controlled "
        "studio strip light on a subject; deep clean shadows on backgrounds. "
        "CAMERA: shot on Hasselblad X2D with 55mm f/2.5, medium-format "
        "clarity, subtle motion blur if hands or documents are moving. "
        "STORYTELLING RULE: the image must SHOW the specific fact the "
        "narration is stating — an actual chart, a specific object of "
        "value, a real skyline of the named city — not a generic 'money' "
        "cliché. Include one legible textural detail (pen on paper, "
        "coffee ring, screen-glow face). Avoid: cartoon dollar signs, "
        "piles of gold coins, stock-photo handshakes, faceless suits."
    ),
    "fitness": (
        "LOOK: high-end athletic editorial — think Nike + Whoop + Peloton "
        "campaign photography. Palette: crisp neutrals with one saturated "
        "energy colour (electric orange, chartreuse, or blue-white gym "
        "light). LIGHT: rim light from behind sculpting muscle definition, "
        "cool fill from the side; sweat catches highlights. CAMERA: shot "
        "on Sony A1 with 85mm f/1.4 for portraits, 24mm f/2.8 for wide "
        "gym shots, subtle motion blur on limbs mid-movement. "
        "STORYTELLING RULE: capture the SPECIFIC exercise or moment the "
        "narration describes — mid-rep tension, sweat at the temple, one "
        "focused expression. Show effort, not just a posed model. Avoid: "
        "cartoon energy lines, unrealistic anatomy, staged smiles, empty "
        "generic gym backgrounds."
    ),
    "gaming": (
        "LOOK: cinematic in-game screenshot or promo key art — think "
        "Cyberpunk 2077, Elden Ring, Red Dead Redemption 2 marketing "
        "stills. Palette: rich saturated tones with strong colour blocking, "
        "one neon accent, deep atmospheric blacks. LIGHT: volumetric — "
        "god-rays through smoke or steam, rim light on the subject, "
        "environmental practical lights (neon signs, torches, HUD glow). "
        "CAMERA: shot as if from an ultra-wide 21:9 in-game camera, "
        "35mm equivalent lens, sharp foreground with atmospheric depth. "
        "STORYTELLING RULE: show a specific in-world moment — an action, "
        "a choice, a landscape at a specific time of day. Environment "
        "should feel LIVED-IN with wear + texture. Avoid: cartoon UI "
        "elements, floating text, screenshot HUD overlays, generic fantasy."
    ),
    "history": (
        "LOOK: period-accurate documentary reenactment photography — "
        "somewhere between a Ken Burns docuseries still and a museum "
        "exhibit reconstruction. Palette: warm sepia and desaturated "
        "earth tones, single-colour highlights matched to the era. "
        "LIGHT: soft natural light — candlelight, oil lamps, or diffused "
        "daylight through period-appropriate windows. Never modern "
        "overhead fluorescent. CAMERA: shot on medium-format film with a "
        "50mm f/2, gentle grain, subtle sepia colour cast, deep clean "
        "shadows. STORYTELLING RULE: every prop, textile, and haircut "
        "must match the STATED period. Show one specific historical "
        "moment or object — an actual named artefact, a real location, "
        "an accurate uniform. Avoid: anachronistic tech, digital watches, "
        "modern clothing on background figures, plastic in shot."
    ),
    "science": (
        "LOOK: high-end science-journalism photography — think Quanta / "
        "Nature / National Geographic feature spreads. Palette: cool "
        "clean whites and blues with one warm accent per scene (a laser "
        "green, a lab-oven orange, a bioluminescent teal). LIGHT: "
        "controlled directional light — a single strong key from an "
        "instrument screen, a fluorescent tube from above with soft fill. "
        "CAMERA: shot on Sony A7R V with a macro 90mm f/2.8 for detail "
        "shots, 35mm f/2 for lab-wide framing, tack-sharp focus, minimal "
        "grain. STORYTELLING RULE: the image must show the SPECIFIC "
        "phenomenon, tool, or organism the narration names — a real "
        "instrument, an accurate diagram, a real specimen. Include one "
        "human-scale detail (hands on a keyboard, an eye at a microscope) "
        "so the abstract feels tangible. Avoid: sci-fi glowing hologram "
        "clichés, cartoon molecules, made-up lab equipment, magic sparkles."
    ),
}


def _brief_for(channel: str) -> str:
    """Return the niche's directorial brief, defaulting to horror since
    that's the project's original niche and its brief is the most
    battle-tested."""
    key = (channel or "").strip().lower()
    return _NICHE_BRIEFS.get(key) or _NICHE_BRIEFS["horror"]


def _craft_prompt_template(narration_excerpt, visual_description, channel, attempt):
    angle = _ANGLE_VARIANTS[attempt % len(_ANGLE_VARIANTS)]
    brief = _brief_for(channel)

    return f"""You are a senior production designer writing ONE text-to-image
prompt for a Flux 2 [klein] cinematic still.

CRITICAL RULES for the model you're targeting (Flux 2 [klein]):
  • Write NATURAL LANGUAGE sentences. Do NOT use comma-separated tag
    lists, quality boosters ("masterpiece", "8k", "best quality"),
    weight syntax like (word:1.3), or negative-prompt keyword lists —
    these degrade Flux 2 output.
  • Put the CONCRETE SUBJECT NOUN first. The model's attention weights
    early nouns heavily, so lead with what the image IS OF.
  • Order: Subject → Foreground/setting layer → Lighting (source +
    direction + colour) → Camera (lens, film stock, framing) → Mood
    described as sentences.
  • Split the scene into foreground / midground / background so the
    model has depth structure — describe what's in each plane.

THE NARRATION SPOKEN DURING THIS SHOT:
  "{narration_excerpt}"

THE DIRECTOR'S VISUAL INTENT:
  {visual_description}

COMPOSITIONAL APPROACH FOR THIS ATTEMPT:
  {angle}

NICHE STYLE BRIEF (weave the LOOK, LIGHT, CAMERA, and STORYTELLING RULE
into your prompt; obey the "avoid" sentence — never list avoided items
as a negative-tag string):
  {brief}

FORMAT REQUIREMENTS:
  • 60-120 words. One paragraph, no line breaks, no markdown, no
    preface, no quotes around the whole thing.
  • Must be a valid natural-language English sentence-string a person
    could read aloud.
  • Must depict the SPECIFIC subject from the visual intent above, not
    a generic scene of the niche's genre.

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
                 "content": "You write image-generation prompts for Flux 2 klein. "
                            "Natural-language sentences only; no tag lists. "
                            "Reply with a single JSON object only."},
                {"role": "user", "content": user_json},
            ],
            max_tokens=700,
            temperature=0.75,
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
    # Collapse any whitespace runs / newlines the model slipped in.
    prompt = " ".join(prompt.split())
    return prompt or None

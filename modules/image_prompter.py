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
        "LOOK: cinematic 35mm horror still in the vein of Ari Aster's "
        "Hereditary + Robert Eggers' The Witch — grounded, dread-soaked, "
        "never campy. Palette: desaturated cold blue-grey with a single "
        "unnatural warm accent (candle amber, sodium-lamp yellow, an "
        "off-red glow) — never rainbow, never vibrant. LIGHT: one hard "
        "practical source only — a doorway sliver, a single bare bulb, "
        "moonlight through a window — casting deep chiaroscuro. "
        "Underlighting or backlighting preferred; flat overhead light "
        "is forbidden. CAMERA: shot in the style of DP Chung-hoon Chung "
        "or Roger Deakins, Arri Alexa + vintage 32mm anamorphic lens, "
        "subtle film grain, f/2.0, wide cinematic 2.39:1 framing. "
        "STORYTELLING RULE: this shot works by IMPLIED presence, not "
        "explicit reveal — a door slightly ajar, an empty rocking chair "
        "still swaying, a silhouette at the far end of a hallway. Show "
        "what feels WRONG about an ordinary space, not a monster. "
        "Avoid: smiling people, sunlit exteriors, comic-book gore, "
        "anime style, cheerful colours."
    ),
    "comedy": (
        "LOOK: bright, energetic, saturated but grounded — Wes Anderson "
        "meets modern YouTube-explainer aesthetic. Cheerful pastel "
        "palette with confident primary colour accents. LIGHT: soft even "
        "key light from one side, gentle fill, no harsh shadows, "
        "everything readable at a glance. CAMERA: in the style of DP "
        "Robert Yeoman (Anderson's long-time DP), Fujifilm X-T5 with a "
        "35mm f/2 lens, clean digital look, dead-on symmetrical framing, "
        "slight lens-flare warmth. STORYTELLING RULE: the visual should "
        "reinforce the comedic beat — one EXAGGERATED facial expression "
        "(wide eyes, dropped jaw, deadpan stare into the lens), an "
        "impossibly-clean minimalist setting, or one absurd out-of-place "
        "object that lands the joke. Character-forward, human eye-line "
        "at frame centre. Avoid: horror atmosphere, muddy palettes, "
        "night scenes, gore, sadness, generic stock-photo people."
    ),
    "finance": (
        "LOOK: modern editorial-photography aesthetic used in Bloomberg "
        "Businessweek / Reuters / WSJ features — clean, deliberate, "
        "expensive-feeling. Palette: navy + charcoal + brushed steel + "
        "one warm amber accent (a lamp, a whisky, an early-morning "
        "sunrise through a window). LIGHT: window light with soft "
        "directional falloff, or a controlled studio strip light on a "
        "subject; deep clean shadows on backgrounds. CAMERA: in the "
        "style of photographer Christopher Anderson or Platon — "
        "Hasselblad X2D with 55mm f/2.5, medium-format clarity, subtle "
        "motion blur if hands or documents are moving. STORYTELLING "
        "RULE: the image must SHOW the SPECIFIC fact the narration is "
        "stating — an actual named chart type (candlestick, line, "
        "heatmap), a specific object of value (a numbered banknote, a "
        "known stock ticker on a screen), a real skyline of the named "
        "city — not a generic 'money' cliché. Include one legible "
        "textural detail (pen on paper, coffee ring, screen-glow on a "
        "face). Avoid: cartoon dollar signs, piles of gold coins, "
        "stock-photo handshakes, faceless suits, laptop-with-generic-"
        "chart clichés."
    ),
    "fitness": (
        "LOOK: high-end athletic editorial — Nike + Whoop + Peloton "
        "campaign photography. Palette: crisp neutrals (whites, chalk, "
        "concrete grey) with ONE saturated energy colour (electric "
        "orange, chartreuse, or blue-white gym light). LIGHT: rim light "
        "from behind sculpting muscle definition, cool fill from the "
        "side; sweat catches highlights. CAMERA: in the style of DP "
        "Emmanuel Lubezki's naturalistic sports work — Sony A1 with "
        "85mm f/1.4 for portraits, 24mm f/2.8 for wide gym shots, "
        "1/500s freezing the peak of the movement, subtle motion blur "
        "only on trailing limbs. STORYTELLING RULE: capture the "
        "SPECIFIC named exercise or moment the narration describes "
        "(deadlift lockout, sprint start block, mid-pull-up chin over "
        "bar) — anatomical form must be textbook-correct. Show effort "
        "(gritted teeth, veins, sweat), not a posed model. Avoid: "
        "cartoon energy lines, anatomically-impossible poses, staged "
        "PR-photo smiles, empty generic gym backgrounds."
    ),
    "gaming": (
        "LOOK: cinematic in-game screenshot or promo key art — "
        "Cyberpunk 2077 / Elden Ring / Red Dead Redemption 2 marketing "
        "stills. Palette: rich saturated tones with strong colour "
        "blocking, one neon accent, deep atmospheric blacks. LIGHT: "
        "volumetric — god-rays through smoke or steam, rim light on the "
        "subject, environmental practical lights (neon signs, torches, "
        "HUD glow). CAMERA: as if from an ultra-wide 21:9 in-game "
        "camera, 35mm equivalent lens, sharp foreground with atmospheric "
        "depth, motion blur only on fast-moving objects. STORYTELLING "
        "RULE: show a specific in-world moment matching the game era "
        "(retro-pixel / early 3D / current-gen photoreal / stylised) — "
        "an action, a choice, a landscape at a specific time of day. "
        "Environment must feel LIVED-IN with wear, texture, and "
        "believable clutter. Avoid: floating UI/HUD overlays, on-image "
        "text captions, generic fantasy tropes divorced from the story."
    ),
    "history": (
        "LOOK: period-accurate documentary reenactment photography — "
        "somewhere between a Ken Burns docuseries still and a museum "
        "exhibit reconstruction. Palette: warm sepia and desaturated "
        "earth tones matched to the era's actual pigment availability. "
        "LIGHT: soft natural light appropriate to the period — "
        "candlelight, oil lamps, gaslamp, or diffused daylight through "
        "period-accurate windows. Never modern overhead fluorescent. "
        "CAMERA: in the style of documentary DP Buddy Squires (Ken "
        "Burns' cinematographer) — medium-format film equivalent with a "
        "50mm f/2, gentle grain, subtle sepia colour cast, deep clean "
        "shadows. STORYTELLING RULE: every prop, textile, hairstyle, "
        "and background figure must match the STATED period exactly. "
        "Show ONE specific historical moment or artefact — a real "
        "named location, a documented uniform, an actual known object "
        "of that era. Avoid: any anachronistic technology (digital "
        "watches, plastic bottles, LED lights, modern clothing) on any "
        "figure in shot, background included."
    ),
    "science": (
        "LOOK: high-end science-journalism photography — Quanta / "
        "Nature / National Geographic feature spreads. Palette: cool "
        "clean whites and blues with one warm accent per scene (a "
        "laser green, a lab-oven orange, a bioluminescent teal). "
        "LIGHT: controlled directional light — a single strong key "
        "from an instrument screen, a fluorescent tube from above with "
        "soft fill. CAMERA: in the style of NatGeo staff photographer "
        "Anand Varma or Paolo Verzone — Sony A7R V with a macro 90mm "
        "f/2.8 for detail shots, 35mm f/2 for lab-wide framing, "
        "tack-sharp focus, minimal grain. STORYTELLING RULE: the "
        "image must show the SPECIFIC phenomenon, tool, or organism "
        "the narration NAMES — a real instrument (electron microscope, "
        "James Webb, mass spectrometer), a documented specimen "
        "(Ediacaran fossil, cephalopod, specific bacterium), an "
        "accurate diagram. Include one human-scale detail (a hand on "
        "a keyboard, an eye at a microscope) so the abstract feels "
        "tangible. Avoid: sci-fi glowing hologram clichés, cartoon "
        "molecules, made-up lab equipment, magic sparkles, generic "
        "'test tubes with coloured liquid' shots."
    ),
}


# Universal coherence checklist appended to EVERY prompt template
# (all niches, every attempt). Empirically prevents the "rotary phone
# glued to a smartphone" / "medieval knight wearing a wristwatch"
# failure mode by making the LLM writer explicitly commit to a single
# consistent era + a single specific named object before it starts.
_COHERENCE_RULES = """
COHERENCE — MANDATORY (this stops the image model mashing eras together):
  • Pick ONE consistent period from the shot's `period` field. Every
    object, garment, hairstyle, and background prop visible in the
    image must belong to that ONE period. Do not blend eras.
  • Name the CONCRETE SPECIFIC OBJECT the narration references — not
    the category. If the narration says "phone", write which phone
    ("rotary Bakelite telephone, 1954" OR "iPhone 15 in matte
    titanium" OR "prop wall payphone"), never bare "a phone". Same
    for cars, weapons, computers, clothing.
  • Do not fuse two objects into one hybrid (never "rotary phone with
    a smartphone screen embedded", never "sword with a pistol grip").
    If the shot requires two objects, place them separately in the
    frame — one in foreground, one in background.
  • Every human figure visible must be dressed for the SAME period
    and region. Background figures included.
"""


def _brief_for(channel: str) -> str:
    """Return the niche's directorial brief, defaulting to horror since
    that's the project's original niche and its brief is the most
    battle-tested."""
    key = (channel or "").strip().lower()
    return _NICHE_BRIEFS.get(key) or _NICHE_BRIEFS["horror"]


def _craft_prompt_template(narration_excerpt, visual_description, channel,
                           attempt, period=""):
    angle = _ANGLE_VARIANTS[attempt % len(_ANGLE_VARIANTS)]
    brief = _brief_for(channel)
    period_line = (
        f'\nSTORY PERIOD (all objects, clothes, tech in the image MUST '
        f'belong to this era): "{period.strip()}"'
        if period and period.strip()
        else ""
    )

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
{period_line}

COMPOSITIONAL APPROACH FOR THIS ATTEMPT:
  {angle}

NICHE STYLE BRIEF (weave the LOOK, LIGHT, CAMERA, and STORYTELLING RULE
into your prompt; obey the "avoid" sentence — never list avoided items
as a negative-tag string):
  {brief}
{_COHERENCE_RULES}

FORMAT REQUIREMENTS:
  • 60-120 words. One paragraph, no line breaks, no markdown, no
    preface, no quotes around the whole thing.
  • Must be a valid natural-language English sentence-string a person
    could read aloud.
  • Must depict the SPECIFIC subject from the visual intent above, not
    a generic scene of the niche's genre.

Respond with ONLY the image prompt text."""


def craft_image_prompt(narration_excerpt, visual_description,
                       channel="horror", attempt=0, period=""):
    """
    Return a polished text-to-image prompt for this shot, OR None if NIM
    is unavailable. Caller should fall back to the storyboard's raw
    ai_prompt in that case.

    `attempt` (0,1,2,...) varies the camera angle so retries don't
    produce the same image with a different seed.

    `period` (from the storyboard's per-shot or story-level anchor)
    forces the generated prompt into a single era so the image model
    can't mash a Model T + iPhone into one frame.
    """
    if not nim.is_available():
        return None
    user = _craft_prompt_template(narration_excerpt, visual_description,
                                  channel, attempt, period=period)
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

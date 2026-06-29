"""
channels.py — Channel/niche presets for the pipeline.

Up until this module existed, the codebase had `if channel == "horror"`
sprinkled across 7 files (scriptwriter prompt, voiceover settings,
storyboard prompt, footage keywords, image-prompter style, editor color
grade, uploader category). Adding a new niche meant edits in all 7 places.

Now: every channel has ONE entry in CHANNEL_PRESETS describing every
niche-dependent thing. Modules call get_channel(name) → dict and read
their slice of it. Custom niches typed by the user at runtime get an
LLM-generated preset that follows the same shape.

Preset schema (all fields optional except `name`):
    name              : unique slug
    display_name      : human-facing label
    tone              : free-form tone tag the scriptwriter prompt uses
    voice             : edge-tts voice id (default English voice)
    voices            : LIST of alternate voices in the niche's primary
                        language — voiceover picks the first; UI surfaces
                        the rest as user-selectable
    voices_by_lang    : {"en": [...], "ur": [...], "hi": [...]} — per-
                        language voice catalog. voiceover._resolve_voice
                        consults this when language != preset default.
    language          : primary content language (default "en")
    rate, pitch       : edge-tts prosody knobs
    script_prompt     : the LLM template for narration writing
    storyboard_prompt : the LLM template for shot planning (uses
                        {{narration}} + {{num_shots}})
    footage_keywords  : seed keywords for stock image/video search
    image_style       : NIM prompt suffix used by image_prompter
    color_grade       : "cool_desaturated" | "warm_punchy" | "neutral"
    music_keywords    : seed query for the music search
    youtube_category  : YouTube Data API category id (string)
    hook_style        : how the first 3 seconds get framed
    research_mode     : "trend_aggregator" | "fact_research" | "none"
"""
from __future__ import annotations
import logging
import os
import re
from typing import Optional

log = logging.getLogger(__name__)


# ── Color grade presets that the editor knows how to render ──────
COLOR_GRADES = ("cool_desaturated", "warm_punchy", "neutral", "vivid_high_contrast")


# ── Niche voice catalog ─────────────────────────────────────────
# A LIST of voice options per niche per language. The voiceover module
# picks the first by default; the wizard / channels page can surface
# the rest for the user to choose a different one. Kept separate from
# the CHANNEL_PRESETS table because it'd otherwise bloat each preset
# entry by ~15 lines; merged in at module-load time.
#
# Picking criteria per niche: voices that have actually rendered well
# on test prompts. en-US-*MultilingualNeural variants are preferred
# when the niche may go non-English later (horror, finance, etc.) so
# code-mixed or hand-off scripts stay coherent.
NICHE_VOICE_CATALOG: dict[str, dict[str, list[str]]] = {
    "horror": {
        "en": [
            "en-US-BrianMultilingualNeural",
            "en-US-ChristopherNeural",
            "en-GB-RyanNeural",
            "en-US-GuyNeural",
        ],
        "ur": ["ur-PK-AsadNeural", "ur-PK-UzmaNeural"],
        "hi": ["hi-IN-MadhurNeural", "hi-IN-SwaraNeural"],
    },
    "wisdom": {
        "en": [
            "en-US-AndrewMultilingualNeural",
            "en-US-RogerNeural",
            "en-GB-ThomasNeural",
            "en-US-EricNeural",
        ],
        "ur": ["ur-PK-AsadNeural"],
        "hi": ["hi-IN-MadhurNeural"],
    },
    "finance": {
        "en": [
            "en-US-GuyNeural",
            "en-US-AndrewMultilingualNeural",
            "en-US-DavisNeural",
            "en-GB-ThomasNeural",
        ],
        "ur": ["ur-PK-AsadNeural"],
        "hi": ["hi-IN-MadhurNeural"],
    },
    "fitness": {
        "en": [
            "en-US-DavisNeural",
            "en-US-GuyNeural",
            "en-US-RogerNeural",
            "en-US-BrianMultilingualNeural",
        ],
        "ur": ["ur-PK-AsadNeural"],
        "hi": ["hi-IN-MadhurNeural"],
    },
    "science": {
        "en": [
            "en-US-AriaNeural",
            "en-US-JennyNeural",
            "en-GB-LibbyNeural",
            "en-US-EmmaMultilingualNeural",
        ],
        "ur": ["ur-PK-UzmaNeural"],
        "hi": ["hi-IN-SwaraNeural"],
    },
    "history": {
        "en": [
            "en-US-ChristopherNeural",
            "en-GB-RyanNeural",
            "en-US-AndrewMultilingualNeural",
            "en-GB-ThomasNeural",
        ],
        "ur": ["ur-PK-AsadNeural"],
        "hi": ["hi-IN-MadhurNeural"],
    },
    "comedy": {
        "en": [
            "en-US-JennyNeural",
            "en-US-AriaNeural",
            "en-US-EmmaMultilingualNeural",
            "en-US-GuyNeural",
        ],
        "ur": ["ur-PK-UzmaNeural"],
        "hi": ["hi-IN-SwaraNeural"],
    },
    "food": {
        "en": [
            "en-US-JaneNeural",
            "en-US-EmmaMultilingualNeural",
            "en-US-AriaNeural",
            "en-GB-SoniaNeural",
        ],
        "ur": ["ur-PK-UzmaNeural"],
        "hi": ["hi-IN-SwaraNeural"],
    },
    "travel": {
        "en": [
            "en-US-EmmaMultilingualNeural",
            "en-US-JaneNeural",
            "en-GB-SoniaNeural",
            "en-US-AndrewMultilingualNeural",
        ],
        "ur": ["ur-PK-UzmaNeural"],
        "hi": ["hi-IN-SwaraNeural"],
    },
    "gaming": {
        "en": [
            "en-US-RogerNeural",
            "en-US-DavisNeural",
            "en-US-GuyNeural",
            "en-US-BrianMultilingualNeural",
        ],
        "ur": ["ur-PK-AsadNeural"],
        "hi": ["hi-IN-MadhurNeural"],
    },
}


# ── Hardcoded presets — the starter set. ─────────────────────────
# Adding a new niche is just appending a dict here OR letting a user
# define one at runtime via the dashboard (LLM expands a name + blurb
# into the same shape).
CHANNEL_PRESETS: dict[str, dict] = {
    "horror": {
        "display_name":   "Horror stories",
        "tone":           "chilling, dread-first, atmospheric",
        # STORYTELLER voice — like a classic gothic narrator recounting
        # a chilling tale that happened to OTHERS. Specific people,
        # specific places, specific dates. NEVER 'this happened to me',
        # 'I was walking' — that voice reads as fake autobiography
        # and kills retention. The narrator is the disembodied teller
        # of the legend, not a participant.
        "perspective":    "third_person_storyteller — like a campfire / podcast host narrating a true horror story. Pick concrete subjects ('Sarah', 'the night nurse on ward 4', 'the workers in the abandoned mill'). Past tense or present-tense storytelling, NOT 'I/me'. The narrator describes events from outside, with chilling detachment. Banned openings: 'It happened to me', 'I was', 'Let me tell you about the time I'. Required: the protagonist is someone OTHER than the narrator. Vary characters across scripts — don't always be 'she'.",
        "voice":          "en-US-BrianMultilingualNeural",
        "rate":           "-5%",
        "pitch":          "-2Hz",
        "color_grade":    "cool_desaturated",
        "footage_keywords": [
            "abandoned gothic mansion at night",
            "decrepit asylum corridor flickering light",
            "foggy graveyard moonlight",
            "candlelit dark hallway shadows",
            "abandoned victorian doll on chair",
            "old cathedral interior fog",
            "shadowy figure end of long hallway",
            "rusted hospital morgue empty",
            "occult symbols carved wood",
            "withered tree branches in fog",
        ],
        "image_style":      "cinematic horror, low-key lighting, fog, desaturated colors, film grain",
        "music_keywords":   "dark ambient horror",
        "youtube_category": "24",
        "hook_style":       "open with a chilling sensory question or unsettling fact",
        "research_mode":    "trend_aggregator",
    },
    "wisdom": {
        "display_name":   "Wisdom + motivation",
        "tone":           "inspirational, contemplative, clear",
        "perspective":    "second_person_direct — talk TO the viewer ('you', 'your'). NEVER tell the script as a personal anecdote ('I did X, then Y happened'). The viewer is the subject.",
        "voice":          "en-US-AndrewMultilingualNeural",
        "rate":           "+0%",
        "pitch":          "+0Hz",
        "color_grade":    "warm_punchy",
        "footage_keywords": [
            "sunrise nature mountain",
            "city timelapse golden hour",
            "ocean waves crash",
            "mountain peak above clouds",
            "people walking purposeful",
            "thoughtful contemplation",
            "ancient temple peaceful",
            "open road horizon",
        ],
        "image_style":      "warm cinematic, golden hour, soft focus, professional photography",
        "music_keywords":   "inspirational background music piano strings",
        "youtube_category": "27",
        "hook_style":       "open with a stark truth or a question that challenges assumption",
        "research_mode":    "trend_aggregator",
    },
    "finance": {
        "display_name":   "Finance + business",
        "tone":           "confident, punchy, fact-driven",
        "perspective":    "third_person_documentary — narrate ABOUT real companies / events / numbers ('In 2008, Lehman Brothers collapsed in...'). Use 'you' only when giving the viewer a takeaway. NEVER tell it as 'I lost money on...' — that's fake and untrustworthy for finance content.",
        "voice":          "en-US-GuyNeural",
        "rate":           "+3%",
        "pitch":          "+0Hz",
        "color_grade":    "warm_punchy",
        "footage_keywords": [
            "stock market chart green red",
            "modern office skyscraper",
            "businessperson laptop concentration",
            "wallet cash money",
            "luxury car keys",
            "bitcoin cryptocurrency",
            "calculator paperwork desk",
            "boardroom meeting",
            "city financial district",
        ],
        "image_style":      "clean editorial photography, sharp focus, corporate aesthetic",
        "music_keywords":   "upbeat corporate motivation",
        "youtube_category": "25",   # News & Politics — closest to finance
        "hook_style":       "open with a startling number or a contrarian claim",
        "research_mode":    "fact_research",
    },
    "fitness": {
        "display_name":   "Fitness + discipline",
        "tone":           "energetic, commanding, no-nonsense",
        "perspective":    "second_person_commanding — 'you walk into the gym', 'your form is wrong'. Direct address. Avoid first-person ('when I started lifting...') unless it's a genuine universal truth dressed as personal example.",
        "voice":          "en-US-DavisNeural",
        "rate":           "+5%",
        "pitch":          "+1Hz",
        "color_grade":    "vivid_high_contrast",
        "footage_keywords": [
            "gym intense workout",
            "dumbbell weightlifting close up",
            "runner sprint sunrise",
            "boxer training",
            "muscle anatomy",
            "sweat determination face",
            "barbell deadlift",
            "athletic outdoor training",
        ],
        "image_style":      "high contrast dramatic lighting, motion blur, dynamic sports photography",
        "music_keywords":   "high energy motivation gym rock",
        "youtube_category": "17",   # Sports
        "hook_style":       "open with a direct command or a brutal truth",
        "research_mode":    "fact_research",
    },
    "science": {
        "display_name":   "Science + tech explainers",
        "tone":           "curious, clear, building from familiar to surprising",
        "perspective":    "third_person_explanatory — narrate the phenomenon itself ('A neutrino passes through your hand right now'). 'You' is fine when addressing the viewer's intuition; first-person is BANNED ('when I learned this...') — science isn't autobiography.",
        "voice":          "en-US-AriaNeural",
        "rate":           "+0%",
        "pitch":          "+0Hz",
        "color_grade":    "neutral",
        "footage_keywords": [
            "microscope cells",
            "space galaxy nebula",
            "scientific lab equipment",
            "circuit board macro",
            "data visualization",
            "particle physics experiment",
            "DNA helix",
            "astronaut earth view",
        ],
        "image_style":      "clean documentary photography, bright lighting, scientific clarity",
        "music_keywords":   "ambient science discovery soundtrack",
        "youtube_category": "28",   # Science & Technology
        "hook_style":       "open with a counterintuitive fact or 'what if' question",
        "research_mode":    "fact_research",
    },
    "history": {
        "display_name":   "History + mythology",
        "tone":           "dramatic narrator, immersive, slightly grave",
        "perspective":    "third_person_omniscient_narrator — Ken Burns voice. Specific subjects ('Pliny the Younger', 'the Roman fleet') in past tense. NEVER 'this happened to me' or 'when I visited Pompeii' — historical events did not happen to the narrator.",
        "voice":          "en-US-ChristopherNeural",
        "rate":           "-3%",
        "pitch":          "-1Hz",
        "color_grade":    "warm_punchy",
        "footage_keywords": [
            "ancient ruins crumbling",
            "medieval castle interior",
            "old map parchment",
            "historical painting renaissance",
            "ancient artifact museum",
            "battlefield smoke",
            "monastery candlelight",
            "ancient hieroglyphics",
            "viking ship",
            "egyptian pyramid",
        ],
        "image_style":      "painterly historical, warm earth tones, classical composition",
        "music_keywords":   "epic orchestral historical drama",
        "youtube_category": "27",   # Education
        "hook_style":       "open with a specific date or a long-buried mystery",
        "research_mode":    "fact_research",
    },
    "comedy": {
        "display_name":   "Comedy + observational",
        "tone":           "casual, sharp, dry wit",
        "perspective":    "first_person_observational — 'I went to the DMV', 'I noticed' — this is the one channel where personal anecdote is the format. Specific, mundane, relatable. Avoid making the narrator the hero of the bit.",
        "voice":          "en-US-JennyNeural",
        "rate":           "+3%",
        "pitch":          "+0Hz",
        "color_grade":    "vivid_high_contrast",
        "footage_keywords": [
            "people laughing candid",
            "awkward office situation",
            "everyday absurd moment",
            "city street people",
            "cafe conversation",
        ],
        "image_style":      "candid bright photography, pop colors, slightly oversaturated",
        "music_keywords":   "quirky upbeat ukulele",
        "youtube_category": "23",   # Comedy
        "hook_style":       "open with a relatable mini-rant or specific observation",
        "research_mode":    "none",
    },
    "food": {
        "display_name":   "Food + cooking",
        "tone":           "warm, inviting, sensory",
        "perspective":    "second_person_invitational — 'you slice the onion', 'imagine the smell'. The viewer is doing/tasting/seeing. First-person ('I learned this recipe in Italy') is only OK as a brief credibility frame, never the whole script.",
        "voice":          "en-US-JaneNeural",
        "rate":           "+0%",
        "pitch":          "+0Hz",
        "color_grade":    "warm_punchy",
        "footage_keywords": [
            "food close up sizzle",
            "chef chopping ingredients",
            "cooking pan flames",
            "plated dish overhead",
            "ingredients fresh market",
            "dessert chocolate molten",
            "asian street food steaming",
        ],
        "image_style":      "food photography, golden hour, shallow depth of field",
        "music_keywords":   "upbeat acoustic kitchen",
        "youtube_category": "26",   # Howto & Style
        "hook_style":       "open with a craving-inducing description or a kitchen secret",
        "research_mode":    "none",
    },
    "travel": {
        "display_name":   "Travel + culture",
        "tone":           "wanderlust, sensory, slightly poetic",
        "perspective":    "second_person_descriptive — 'you stand at the cliff edge', 'the salt hits the back of your throat'. Transport the viewer; don't recount a personal vacation. First-person travelogue ('when I visited Bali...') makes the script feel like a vlog instead of a Short.",
        "voice":          "en-US-EmmaNeural",
        "rate":           "+0%",
        "pitch":          "+0Hz",
        "color_grade":    "vivid_high_contrast",
        "footage_keywords": [
            "tropical island beach drone",
            "european cobblestone street",
            "asian market night neon",
            "mountain hiking trail",
            "ancient ruins traveler",
            "local cuisine close up",
            "passport stamps",
        ],
        "image_style":      "travel photography, golden hour, wide vistas, vibrant colors",
        "music_keywords":   "world music exotic uplifting",
        "youtube_category": "19",   # Travel & Events
        "hook_style":       "open with a sensory transport — sights, smells, sounds of a place",
        "research_mode":    "none",
    },
    "gaming": {
        "display_name":   "Gaming + lore",
        "tone":           "enthusiast, fast, knowledgeable",
        "perspective":    "third_person_enthusiast — 'the dev secretly added X', 'Cloud is actually...'. Narrate ABOUT the game world / community / hidden mechanic. First-person ('I was playing Elden Ring when...') sometimes works for reveals but should be the exception, not the default.",
        "voice":          "en-US-RogerNeural",
        "rate":           "+5%",
        "pitch":          "+0Hz",
        "color_grade":    "vivid_high_contrast",
        "footage_keywords": [
            "video game gameplay action",
            "gaming setup rgb",
            "controller close up",
            "esports tournament crowd",
            "pixel art retro",
            "fantasy character render",
        ],
        "image_style":      "video game render, neon lighting, dynamic action poses",
        "music_keywords":   "synthwave gaming epic",
        "youtube_category": "20",   # Gaming
        "hook_style":       "open with a specific mechanic, lore reveal, or rage moment",
        "research_mode":    "none",
    },
}


# ── Accessors ────────────────────────────────────────────────────

def _normalise(name: str) -> str:
    """Lowercase, alphanumeric + underscores only. So 'Self Improvement!'
    and 'self_improvement' resolve to the same key."""
    return re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower()).strip("_") or "horror"


def list_channels() -> list[dict]:
    """All known channel presets. Used by the dashboard's channel picker."""
    return [{"name": k, **v} for k, v in CHANNEL_PRESETS.items()]


def get_channel(name: str) -> dict:
    """Return the preset for `name`. Falls back to the 'horror' shape if
    name is unknown — caller can then ask synthesize_custom() to fill it
    in for a never-seen-before niche."""
    key = _normalise(name)
    if key in CHANNEL_PRESETS:
        cfg = {"name": key, **CHANNEL_PRESETS[key]}
    else:
        cfg = {"name": key, "_unknown": True, **CHANNEL_PRESETS["horror"]}
    # Default web_research_enabled = (channel benefits from facts).
    # Preset can override by setting an explicit value.
    cfg.setdefault("web_research_enabled", cfg.get("research_mode") == "fact_research")
    # Language default — every niche is English-first unless explicitly
    # overridden by a Firestore channel doc or a custom synthesised
    # preset (e.g. an Urdu horror channel sets language="ur").
    cfg.setdefault("language", "en")
    # Merge in the voice catalog so callers see voices_by_lang without
    # the preset table needing to inline every voice variant.
    if "voices_by_lang" not in cfg and key in NICHE_VOICE_CATALOG:
        cfg["voices_by_lang"] = NICHE_VOICE_CATALOG[key]
    # Surface the alternate English voice list as `voices` for the UI's
    # voice picker. First entry mirrors the preset's `voice` field.
    if "voices" not in cfg:
        cfg["voices"] = (cfg.get("voices_by_lang") or {}).get("en") or [cfg.get("voice")]
    return cfg


def web_research_default(name: str) -> bool:
    """Cheap accessor for the dashboard's Create page so the toggle
    can be initialised correctly per channel selection."""
    return bool(get_channel(name).get("web_research_enabled"))


def is_known(name: str) -> bool:
    return _normalise(name) in CHANNEL_PRESETS


def synthesize_custom(name: str, description: str = "", llm_call=None) -> dict:
    """Build a preset on-the-fly for a niche the user just invented.

    Uses NIM to translate a name + free-form description into the full
    schema. `llm_call` is injected so tests can stub it; production code
    passes modules.nim.chat.

    Falls back to a reasonable 'unknown' preset if NIM is unreachable —
    the pipeline can still run, just with generic tone/keywords.
    """
    key = _normalise(name)
    desc = (description or name).strip()

    fallback = {
        "name": key,
        "display_name": name.strip() or key,
        "tone": "engaging, clear, suited to the topic",
        "perspective": "third_person_objective — narrate ABOUT the subject, not about the narrator. Use 'you' to address the viewer when giving takeaways. Avoid first-person ('I/me') unless the niche is clearly personal-anecdote-driven.",
        "voice": "en-US-AriaNeural",
        "rate": "+0%",
        "pitch": "+0Hz",
        "color_grade": "neutral",
        "footage_keywords": [desc] if desc else [key],
        "image_style": "professional photography, sharp focus, natural lighting",
        "music_keywords": "ambient background music",
        "youtube_category": "22",   # People & Blogs (safe default)
        "hook_style": "open with the most surprising element of the topic",
        "research_mode": "fact_research",
        "_synthesized": True,
        "_source_description": desc,
    }

    if llm_call is None:
        try:
            from modules import nim
            llm_call = nim.chat
        except Exception:
            log.info(f"channels.synthesize_custom({key}): NIM unavailable, using fallback preset")
            return fallback

    prompt = f"""You are building a content-niche preset for a YouTube Shorts automation pipeline.

The user wants a channel called: "{name.strip() or key}"
Their description: "{desc or '(none — infer from the name)'}"

Return a JSON object with these exact keys:
- display_name: short human-facing label (under 40 chars)
- tone: 1-line voice/style tag for the script LLM (e.g. "casual, sharp, sensory")
- voice: one of these edge-tts voice ids — en-US-AriaNeural, en-US-JennyNeural, en-US-EmmaNeural, en-US-JaneNeural, en-US-GuyNeural, en-US-DavisNeural, en-US-AndrewMultilingualNeural, en-US-BrianMultilingualNeural, en-US-ChristopherNeural, en-US-RogerNeural
- rate: edge-tts rate offset like "+3%", "-5%", "+0%"
- pitch: edge-tts pitch offset like "+1Hz", "-2Hz", "+0Hz"
- color_grade: one of cool_desaturated, warm_punchy, neutral, vivid_high_contrast
- footage_keywords: array of 6-10 short stock-footage search queries that fit the niche
- image_style: 1-line style suffix for AI image generation (e.g. "documentary photography, bright lighting")
- music_keywords: 1 stock-music search query (e.g. "upbeat corporate motivation")
- youtube_category: a YouTube Data API category id as a string (use "22" if unsure)
- hook_style: 1-line guidance for the first 3 seconds of the video
- research_mode: one of "trend_aggregator" (use trending feeds), "fact_research" (web research), "none"

Reply with ONLY the JSON object, no surrounding markdown."""

    try:
        raw = llm_call(
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=900,
            temperature=0.4,
        )
        # llm_call may return either a string or a dict — handle both.
        import json as _json
        if isinstance(raw, str):
            parsed = _json.loads(raw)
        elif isinstance(raw, dict):
            parsed = raw
        else:
            parsed = _json.loads(str(raw))
        # Merge into the fallback so any missing key gets a default.
        out = {**fallback, **parsed, "name": key, "_synthesized": True}
        log.info(f"channels.synthesize_custom({key}): NIM-built preset ready")
        return out
    except Exception as e:
        log.warning(f"channels.synthesize_custom({key}) failed: {e} — using fallback")
        return fallback


def resolve(channel_name: str, description: str = "") -> dict:
    """One-stop: known preset OR synthesized custom. Used by the
    pipeline at entry — every later module just sees a fully-filled dict.
    """
    if is_known(channel_name):
        return get_channel(channel_name)
    return synthesize_custom(channel_name, description)

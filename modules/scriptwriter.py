"""
scriptwriter.py — AI Script Generation Module
Uses Groq (free tier) with llama-3.3-70b-versatile — GPT-4o level quality,
no regional restrictions, 1000 free requests/day.
Get your free key at: https://console.groq.com/keys
"""
import os
import re
import json
import logging
import requests
from dotenv import load_dotenv

from modules._net import retry
from modules.config import load_settings
from modules import nim

load_dotenv()
log = logging.getLogger(__name__)

def _groq_key() -> str:
    """Read GROQ key from env at CALL time (not import time) so keys
    saved via the dashboard AFTER worker boot are picked up."""
    return os.getenv("GROQ_API_KEY", "") or ""

GROQ_API_KEY = _groq_key()  # kept for any legacy readers; DO NOT use in new code
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

PROMPT_VERSION = "v9"


# ── Universal retention-focused prompt ───────────────────────────
#
# Why this exists:
#   The old code branched into HORROR_PROMPT vs WISDOM_PROMPT. Horror
#   got 80+ lines of cinematic guidance; everything else got a generic
#   "make a hook + insight + takeaway" template. Result: finance,
#   fitness, science scripts read like a 2014 motivational LinkedIn
#   post — robotic, no real hook, no curiosity gap, no retention.
#
#   This template is channel-driven: tone, hook style, banned words,
#   structure all come from modules.channels.CHANNEL_PRESETS so adding
#   a new niche means editing ONE dict, not editing this prompt.
#
#   Retention principles baked in (these are the difference between
#   1k views and 100k views on a Short):
#     * First 3 seconds: pattern-interrupt or curiosity gap. Never an
#       introduction. Drop the viewer into the most surprising claim.
#     * Specificity over abstraction: numbers, names, dates, concrete
#       nouns. "He lost $47K in 14 days" beats "He lost a lot of money."
#     * Open loops every 3-4 sentences: tease a payoff that resolves
#       later. Most viewers leave at the 5-second mark; one good loop
#       gets them to 15 seconds; two gets them to the end.
#     * Sentence rhythm: vary length aggressively. Short. Then medium.
#       Then a longer line that breathes. Predictable cadence kills it.
#     * Stakes: even on a "fun fact" video, every claim should imply
#       why-the-viewer-should-care. Stakes can be tiny ("you've been
#       doing this wrong") or huge ("this will outlive everyone alive").
#     * End on a punch, not a summary. "Subscribe for more" is forbidden.

UNIVERSAL_PROMPT = """You are writing a YouTube Shorts narration for the
"{channel_label}" channel. The script must HOLD VIEWER RETENTION for
the full 30-60 seconds — Shorts metrics live and die on completion rate.

PREMISE (use this — do not invent a different topic):
  {title}

{facts_block}

CHANNEL TONE: {tone}

NARRATOR PERSPECTIVE (THIS IS CRITICAL — most scripts feel fake because
they default to first-person "this happened to me" no matter the niche.
Stick to the perspective below):
  {perspective}

HOOK STYLE (first 1-2 sentences are EVERYTHING — 60% of viewers leave
in the first 3 seconds; the right hook flips that): {hook_style}

NON-NEGOTIABLE RETENTION RULES:
  1. SPECIFICITY OVER ABSTRACTION. Use numbers, names, dates, exact
     places. "Lost $47K in 14 days" beats "Lost a lot of money."
     "The 1816 year without a summer" beats "centuries ago".
  2. FIRST LINE = pattern interrupt. Start mid-action, mid-revelation,
     mid-question — never with "Today I'll explain", "Let me tell
     you", "Have you ever wondered", or any greeting. The viewer must
     not realize they're being introduced to a topic.
  3. OPEN LOOPS. Plant a question or stakes in the first 5 seconds
     that the body of the script answers/resolves. The viewer should
     keep watching to find out the payoff.
  4. SENTENCE RHYTHM. Vary length aggressively. Short. Then medium-
     length. Then occasionally a longer sentence that lets the listener
     breathe a moment. Predictable cadence kills retention.
  5. STAKES IN EVERY BEAT. Imply what's at risk, what changes, what
     the listener now sees differently. Even "fun fact" scripts need
     micro-stakes — give the viewer a reason to care line by line.
  6. ZERO FILLER PHRASES. Banned: "in this video", "let's dive in",
     "stay tuned", "without further ado", "subscribe for more", "hit
     the like button", "make sure to", "as you can see", "interestingly
     enough", "the fact of the matter is", "at the end of the day".
     If you write any of these, the script fails review.
  7. END ON A PUNCH. Last sentence either (a) reveals the answer to
     the open loop, (b) lands a memorable one-liner the viewer
     re-shares, or (c) flips the framing of everything just said.
     Never a "thanks for watching" or summary.
  8. WORD COUNT: {word_min}-{word_max} words. Hard ceiling — a {hard_cap}-
     word response gets rejected. Cut connective tissue, never imagery.
  9. STRICTLY NO sexual / romantic / intimate content. No explicit
     violence beyond what the channel naturally requires (e.g. mild
     dread for horror). No content targeting minors as a subject.

YOUTUBE TITLE (50-70 chars — VIRAL SHORTS FORMAT):
  Formats that outperform on YouTube Shorts (pick the best one for
  this content):
    • Question hook:  "Why does <X> actually <do Y>?"
    • Number + noun:  "The 3 <things> nobody tells you about <X>"
    • Contradiction:  "<Common belief> is wrong. Here's why."
    • Reveal setup:   "What <X> looks like from the inside"
    • Time pressure:  "You have <N> seconds to see this"
  Rules:
    • Strong nouns beat adjectives. Concrete beats abstract.
    • Numbers outperform prose ("3", "$1000", "6 hours").
    • NO ALL CAPS, NO emoji in the title itself, NO clickbait
      ("you won't believe", "shocked everyone", "gone wrong").
    • Include the primary keyword in the FIRST 40 chars for search.
    • Aim for the curiosity gap — the viewer clicks because they
      need to close a loop the title opened.

DESCRIPTION (180-250 words — SEO-optimised, publish-ready):
  Structure (mandatory):
    1. HOOK LINE (first sentence): re-states the curiosity gap in the
       title. This is what YouTube shows below the title.
    2. VALUE PROMISE (2-3 sentences): tells the viewer what they'll
       learn / see / feel in the next 60 seconds. Natural keyword
       density — DO NOT stuff keywords, YouTube penalises it.
    3. CONTEXT / SOURCE (1-2 sentences): the credibility hook. What
       makes this claim / topic real. Cite by name if applicable.
    4. CALL-TO-ACTION (1 sentence): "Subscribe for more on <niche>."
       Keep it simple — one CTA outperforms three.
    5. HASHTAGS (line break, then exactly 3): #primaryKeyword
       #broadNiche #shorts. YouTube surfaces videos with matching
       hashtags in related searches.
    6. TAG STRIP (line break, then a comma-separated list of the
       10 tags). Not a ranking factor directly but helps YouTube
       understand the topic.

SEARCH_KEYWORDS (5-8 phrases, 3-6 words each):
  These feed a stock-footage / image search. GENERIC subjects only —
  the stock library must actually have matches. Bad: "MIT visual
  cortex 2019". Good: "brain scan neurons close up".
  Visual style target for this channel: {image_style}.

TAGS (exactly 10 YouTube tags, ranked most→least specific):
  1-3: the exact topic phrase (e.g. "phone network crash 1994",
       "AT&T system 7 failure")
  4-6: the broader theme (e.g. "telecommunications history",
       "software bug disaster")
  7-10: the umbrella niche + format (e.g. "science shorts",
        "tech explained", "history shorts", "did you know")
  Order matters — YouTube weights the first tag most.

Respond with ONLY this JSON object — no markdown fences, no prose
around it:
{{
  "narration":       "{word_min}-{word_max} word narration meeting EVERY rule above",
  "youtube_title":   "title under 60 chars",
  "description":     "150-200 word SEO description",
  "tags":            ["tag1", "tag2", ...],
  "search_keywords": ["visual phrase 1", "visual phrase 2", ...]
}}"""

# Per-tone style guidance appended to the base prompt. Keep each entry short:
# the base prompt does the heavy lifting; tone just colors the voice.
TONE_GUIDANCE = {
    "atmospheric": "Voice: slow, hushed, observational. Long shadows over loud scares.",
    "chilling":    "Voice: cold, certain, intimate. The narrator is calm; the situation is not. Lean into wrongness and dread, not gore.",
    "extreme":     "Voice: relentless. Every sentence raises the stakes. Use visceral body fear — pulse, breath, things behind you. Push the viewer past comfortable.",
    "dramatic":    "Voice: urgent, escalating, charged. Short punchy sentences. Stakes are visible.",
    "educational": "Voice: clear, second-person, analytical. Walks the viewer through what's happening.",
    "sarcastic":   "Voice: dry, deadpan, faintly amused. The narrator notices the absurd.",
    "inspirational": "Voice: warm, certain, direct. Each line lifts the viewer forward.",
}

HORROR_PROMPT = """You are writing a 60-second first-person horror narration
for a YouTube Short. The target is CHILLING — dread that sits in the
viewer's chest after the video ends. Not cozy spooky-story horror.

PREMISE (use exactly this — do not invent a different setting):
  {title}

TONE: {tone_guidance}

WRITING RULES — follow all of them:
  1. NARRATOR PERSPECTIVE — third-person STORYTELLER, NOT first-person
     autobiography. You are the disembodied narrator telling a chilling
     tale about a SPECIFIC OTHER PERSON / PLACE / EVENT. Pick a concrete
     character or location for the story to happen TO. Examples:
       "Sarah's first night in the apartment, the dishwasher ran by itself."
       "In a small Welsh village, the bell in the abandoned chapel rang once."
       "The night watchman at Hotel Cecil noticed it on his third week."
     NEVER "I was walking", "I felt", "I heard". The narrator describes
     what happened TO OTHERS with chilling detachment.
     Vary the protagonist across scripts — don't always use 'she' or
     'the woman'. Names, places, occupations, eras change every time.
  2. FIRST LINE = a hook that puts something WRONG in the viewer's head
     immediately. A single concrete, off-kilter detail anchored in the
     story's specific subject. NO "It started when…", "I'll never forget…",
     "Let me tell you about…". Drop the viewer mid-scene, mid-event —
     a specific moment something broke for a specific person.
  3. Past tense is fine; present-tense storytelling ("she finds…")
     also works for immediacy. NEVER first-person ("I find").
  4. Lean into DREAD, not jump-scares. The thing that scares the viewer
     isn't a monster reveal — it's the moment they realize the rules of
     reality bent quietly and the CHARACTER didn't notice. Wrongness
     over gore. Implication over description.
  5. Use body horror in the *sensation* sense — but happening to the
     character, not the narrator: the wet sound from the wall behind
     HER head, the breath that wasn't HIS, the warmth of a hand on
     THEIR shoulder when both their hands were visible. Specific,
     somatic, non-graphic. No explicit gore or slasher content.
  6. Build paranoia: each beat should make a safe thing mentioned earlier
     feel unsafe in retrospect. Re-contextualise the mundane.
  7. Escalate every 2-3 sentences. The viewer should be afraid to keep
     watching by the halfway point.
  8. End on ONE final line — a single new fact that makes everything
     above worse. Not a twist; a confirmation of the worst-case
     interpretation the viewer had been pushing away.
  9. LENGTH IS NOT OPTIONAL: narration must be {word_min}-{word_max} words.
     This is a HARD CEILING — a {hard_cap}-word response is rejected.
     Cut adverbs and connective tissue, never the imagery.
  10. STRICTLY NO sexual content, no romantic/intimate subtext, no nudity,
     no sexual violence. Genre is psychological terror, not adult.

BANNED PHRASES — do not use any of these (or paraphrases):
  - First-person: "I felt", "I heard", "I saw", "my heart", "I knew",
    "I'll never forget", "I was alone" — ANY 'I/me/my/mine' framing
    means the script is wrong. Always third-person.
  - "blood ran cold", "chill down my spine" (or anyone's spine — cliché)
  - "raspy voice", "darkest secret", "deepest fear"
  - "little did I know", "little did she know", "what happened next",
    "you won't believe"
  - "creaks and groans", "wooden beams", "settling house"
  - explicit gore: "blood pooling", "intestines", "split skull" — unease,
    not splatter
  - any sexual or romantic language

YouTube title: under 60 chars. Curiosity gap, not clickbait. A number,
question, or one strange concrete noun beats hype words every time.

search_keywords — CRITICAL: these go directly to a stock-image search to
build a GOTHIC-HORROR montage that gives viewers chills. The visual style
is: atmospheric, dread-soaked, decaying, occult, victorian-gothic,
candlelit, fog-shrouded, abandoned, haunted. Think MIDSOMMAR / THE WITCH /
HEREDITARY production-stills aesthetic — NOT "rainy day" or "moody
hallway".

  EXCELLENT keywords (genre-correct, will surface real gothic horror imagery):
    "abandoned victorian mansion candlelit hallway",
    "decrepit asylum corridor flickering bulb",
    "foggy gothic cemetery wrought iron gate",
    "ouija board scratched wooden floor candlelight",
    "shadowy hooded figure end of long corridor",
    "decaying victorian doll porcelain face",
    "old cathedral nave fog cracked stained glass",
    "rusted morgue drawers empty hospital",
    "occult sigil carved into ancient wood",
    "skeletal hand emerging from soil moonlight",
    "withered black tree branches against blood moon",
    "burning candle wax dripping down skull",
    "abandoned cabin deep dark woods night",
    "peeling wallpaper victorian wallpaper child's room"

  WEAK / BANNED (too safe, too modern, too generic):
    "rain on window", "dark city street", "empty parking lot",
    "fluorescent gas station", "coffee on table", "bedroom alarm clock",
    "person writing in journal", "ordinary house at night"

Rules for keywords:
  1. EVERY phrase must clearly signal gothic-horror or supernatural dread —
     a stock-photo reviewer should immediately know it's for a horror story.
  2. Each phrase 4-7 words, descriptive of the SHOT itself (lighting,
     subject, mood, setting all in one).
  3. Include at least one phrase with: candles/candlelight, fog, victorian
     decay, religious/occult symbols, or the supernatural figure/silhouette.
  4. Avoid bright, safe, or contemporary imagery. No urban skyline, no
     office, no daylight unless it's overcast/foggy.
  5. Provide 5-8 phrases (more is better — gives the montage variety).

Respond with ONLY a JSON object (no markdown, no prose around it):
{{
  "narration": "{word_min}-{word_max} word THIRD-PERSON STORYTELLER horror narration about a specific other person/place/event — NEVER first-person",
  "youtube_title": "...",
  "description": "150-200 word SEO description that hints at the hook",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "search_keywords": ["atmospheric phrase 1", "atmospheric phrase 2", "atmospheric phrase 3", "atmospheric phrase 4"]
}}"""


WISDOM_PROMPT = """You are a YouTube Shorts motivational narrator.

Topic: {title}
Context keywords: {keywords}

TONE: {tone_guidance}

Write a 60-second narration ({word_min}-{word_max} words):
  1. Sentence 1 is a HOOK — a surprising claim or pointed question.
  2. Second person ("you"), punchy, action-oriented.
  3. One clear insight. One concrete example or analogy.
  4. End with a memorable one-line takeaway the viewer will remember.
  5. NO "today we're going to talk about", NO filler.

YouTube title rules: under 60 chars, intrigue not clickbait, ideally
contains a number or pointed question.

Respond with ONLY a JSON object (no markdown):
{{
  "narration": "...",
  "youtube_title": "...",
  "description": "150-200 word SEO description",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "search_keywords": ["3-5 visual b-roll keywords"]
}}"""


def _build_messages(prompt, extra_messages=None):
    msgs = [
        {
            "role": "system",
            "content": (
                "You are an expert YouTube Shorts writer. For horror you write "
                "as a THIRD-PERSON storyteller — chilling tales about specific "
                "OTHER people/places/events, never 'I/me/my' personal accounts. "
                "Respond with a single JSON object only — no markdown fences, "
                "no preamble, no trailing text."
            ),
        },
        {"role": "user", "content": prompt},
    ]
    if extra_messages:
        msgs.extend(extra_messages)
    return msgs


def _call_nim(prompt, extra_messages=None):
    """Primary path — NVIDIA NIM. thinking=False keeps the reasoning model
    from burning the token budget on a think-trace before producing JSON."""
    return nim.chat(
        _build_messages(prompt, extra_messages),
        max_tokens=2048,
        temperature=0.7,
        response_format={"type": "json_object"},
        timeout=180,
    )


def _call_llm(prompt, extra_messages=None):
    """Dispatcher: prefer NIM, fall back to Groq on failure.

    NIM gives us a stronger model (llama-3.3-70b) with a 40 RPM free tier
    which is more than enough for a single video. Groq remains the safety
    net in case NIM is down or the key is missing.
    """
    if nim.is_available():
        try:
            text = _call_nim(prompt, extra_messages)
            if text and text.strip():
                return text
            log.warning("NIM returned empty content; falling back to Groq")
        except Exception as e:
            log.warning(f"NIM call failed ({e}); falling back to Groq")
    return _call_groq(prompt, extra_messages)


def _call_groq(prompt, extra_messages=None):
    """Single Groq call. Raises on HTTP error so retry() can catch it."""
    _groq = _groq_key()
    if not _groq:
        raise ValueError("GROQ_API_KEY not set — add it on the Connections page")

    messages = [
        {
            "role": "system",
            "content": (
                "You are an expert YouTube Shorts writer. "
                "Respond with a single JSON object only — no markdown fences, "
                "no preamble, no trailing text."
            ),
        },
        {"role": "user", "content": prompt},
    ]
    if extra_messages:
        messages.extend(extra_messages)

    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        # Lower temp = the model follows the writing rules more strictly
        # and ignores its default "old farmhouse / wooden beams" priors.
        "temperature": 0.7,
        # 1024 was clipping responses to ~95 words. With description + tags
        # + keywords in the same JSON object, we need real headroom.
        "max_tokens": 2048,
        # Groq supports OpenAI-style JSON mode for compatible models.
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {_groq}",
        "Content-Type": "application/json",
    }

    response = requests.post(GROQ_URL, headers=headers, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]


def _strip_fences(text):
    """Defensive cleanup if a model still emits ```json fences despite JSON mode."""
    t = text.strip()
    # ```json ... ``` or ``` ... ```
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", t, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return t


REQUIRED_FIELDS = ("narration", "youtube_title", "description", "tags")


def _validate(script, word_min=140, word_max=260):
    """Return list of human-readable problems with the parsed script dict.

    word_min/word_max are the hard rejection bounds. The prompt asks for a
    tighter range; we leave a small margin here so we don't reject borderline
    responses unnecessarily.
    """
    problems = []
    if not isinstance(script, dict):
        return ["script is not a JSON object"]
    for f in REQUIRED_FIELDS:
        if f not in script:
            problems.append(f"missing field: {f}")
    narration = script.get("narration", "")
    if isinstance(narration, str):
        wc = len(narration.split())
        if wc < word_min:
            problems.append(f"narration too short ({wc} words; want >={word_min})")
        if wc > word_max:
            problems.append(f"narration too long ({wc} words; want <={word_max})")
    else:
        problems.append("narration is not a string")
    title = script.get("youtube_title", "")
    if isinstance(title, str) and len(title) > 100:
        problems.append(f"youtube_title too long ({len(title)} chars; max 100)")
    tags = script.get("tags", [])
    if not isinstance(tags, list):
        problems.append("tags is not a list")
    return problems


def write_script(research_data, max_attempts=3):
    """
    Takes research_data dict, returns script dict. Retries on:
      - network/Groq HTTP errors (handled by retry())
      - invalid JSON or schema violations (re-prompts the model with the error)

    Channel dispatch:
      - horror: keeps the cinematic HORROR_PROMPT (high-effort genre-
        specific guidance the LLM is calibrated against).
      - everything else: UNIVERSAL_PROMPT — channel-driven, retention-
        focused, pulls tone/hook_style/image_style from
        modules.channels.CHANNEL_PRESETS so every niche gets a hook
        and structural pressure, not a generic motivational template.
    """
    from modules import channels as _ch

    s = load_settings()
    word_min = int(s["content"].get("target_word_min", 160))
    word_max = int(s["content"].get("target_word_max", 200))
    hard_cap = word_max + 100

    channel_type = research_data.get("type", "horror")
    channel_cfg = _ch.get_channel(channel_type)

    # Tone resolution — priority order:
    #   1. research_data["tone_override"] — per-channel tone from the
    #      channels UI (main.py stashes it there for exactly this reason;
    #      the 2026-07-13 audit found the previous code re-fetched
    #      channel_cfg here and dropped main.py's mutation).
    #   2. channel_cfg.tone — the niche preset's default.
    #   3. Global settings.content.tone.
    #   4. Hardcoded "atmospheric" fallback.
    _override_tone = str(research_data.get("tone_override") or "").strip()
    if _override_tone:
        tone = _override_tone
    elif channel_cfg.get("tone"):
        tone = str(channel_cfg["tone"]).strip()
    else:
        tone = s["content"].get("tone", "atmospheric")
    # channel_cfg carries the tone downstream too so BOTH the HORROR
    # branch (which used to read only global tone_guidance) AND the
    # UNIVERSAL branch see the same resolved value. Previously the
    # HORROR branch had no per-channel override path at all.
    channel_cfg = dict(channel_cfg)  # shallow copy — don't mutate the preset module
    channel_cfg["tone"] = tone
    tone_guidance = TONE_GUIDANCE.get(tone, TONE_GUIDANCE["atmospheric"])

    # Job-level overrides (set by the wizard / scheduled-render).
    language = (research_data.get("language") or channel_cfg.get("language") or "en").lower()[:2]
    real_events = bool(research_data.get("real_events"))

    # Optional facts block when the browser research agent ran upstream.
    facts = research_data.get("facts") or []
    sources = research_data.get("sources") or []
    facts_block = ""
    if facts:
        facts_block = (
            "VERIFIED RESEARCH (use these facts — invent nothing beyond them):\n"
            + "\n".join(f"  - {f}" for f in facts[:8])
            + (f"\nSources: {', '.join(sources[:4])}" if sources else "")
            + "\n"
        )

    # ── Real-events mode ────────────────────────────────────────
    # When ON the script MUST be grounded in something verifiable —
    # a documented true event, a published case, a recorded historical
    # incident, OR (for mythology/folklore niches) a faithful retelling
    # of a real published legend rather than invented lore.
    # The instruction adapts to the niche so the same toggle reads as
    # "true horror story" for horror, "real case study" for finance,
    # "documented experiment" for science, etc.
    real_events_block = ""
    if real_events:
        nm = channel_type
        framings = {
            "horror":  "Base the narration on a DOCUMENTED real incident — a haunting, disappearance, ritual murder, or unexplained event that has actual case files / news reports / paranormal records. Name the real victim or place (or a faithful pseudonym if names are protected). If you must use mythology / folklore, retell the published legend accurately — do NOT invent new myths.",
            "wisdom":  "Ground the takeaway in a REAL person's story — a documented life, choice, or moment from history or recent reporting. Name them. Don't invent characters.",
            "finance": "This must be a REAL case study — a documented company, founder, market event, with real dates, real dollar figures, real outcomes. No composite or hypothetical scenarios.",
            "fitness": "Cite a REAL athlete, real study, real protocol — with the actual reference. No invented anecdotes.",
            "science": "Every claim must trace to a real published study, experiment, or established theory. Mention the discoverer / lab / year where it adds weight.",
            "history": "Faithful historical retelling — real dates, real people, real geography. Mythology niches retell the published myth without invention.",
            "comedy":  "Anchor the bit in a REAL widely-shared experience (the DMV, airport security, etc.) — not invented absurdity.",
            "food":    "Real cuisines, real techniques, real chefs / regions. No invented dishes.",
            "travel":  "Real places, real cultural details, real practical info. Mythology of a place = retell the actual local legend.",
            "gaming":  "Real games, real dev quotes, real patches / lore drops with patch numbers / interview citations. No invented lore.",
        }
        framing = framings.get(nm, "Ground every claim in something documented and real. Avoid invented scenarios; cite specific people/places/dates where it strengthens credibility.")
        real_events_block = (
            "REAL EVENTS MODE — accuracy is mandatory:\n"
            f"  {framing}\n"
            "  If you genuinely don't have a real anchor for this topic, "
            "say so in the narration ('reports vary', 'one widely-circulated account holds...') "
            "rather than fabricating. NEVER present invented details as fact.\n"
        )

    # Multilingual: when the script language isn't English, tell the
    # LLM to actually write in that language. Edge-tts will pronounce
    # the chosen language; the channel preset's voice selection
    # (voices_by_lang) handles the actual TTS voice.
    LANG_NAMES = {
        "en": "English", "ur": "Urdu (Naskh script)", "hi": "Hindi (Devanagari script)",
        "es": "Spanish", "fr": "French", "de": "German",
        "ar": "Arabic", "pt": "Portuguese",
    }
    language_block = ""
    if language != "en":
        lang_label = LANG_NAMES.get(language, language)
        language_block = (
            f"LANGUAGE: Write the narration in {lang_label}. "
            f"All free-text fields (narration, youtube_title, description) "
            f"go in {lang_label}. Tags + search_keywords can stay English (YouTube SEO is language-flexible).\n"
        )

    # Prefix carries language + real-events guidance. Facts continue
    # to flow through the existing per-template slot (HORROR_PROMPT
    # doesn't have a hole for them yet, so for that path we fold them
    # into the prefix too).
    prefix_universal = (language_block + real_events_block).strip()
    prefix_horror    = (language_block + real_events_block + facts_block).strip()
    if prefix_universal: prefix_universal += "\n\n"
    if prefix_horror:    prefix_horror    += "\n\n"

    if channel_type == "horror":
        # tone_guidance is derived from `tone` above — which now honors
        # the per-channel override from research_data["tone_override"].
        # A dashboard channel that set tone="ominous" or "campy" was
        # previously ignored on this branch entirely.
        prompt = prefix_horror + HORROR_PROMPT.format(
            title=research_data["raw_title"],
            tone_guidance=tone_guidance,
            word_min=word_min, word_max=word_max, hard_cap=hard_cap,
        )
    else:
        prompt = prefix_universal + UNIVERSAL_PROMPT.format(
            title=research_data["raw_title"],
            channel_label=channel_cfg.get("display_name") or channel_type,
            tone=channel_cfg.get("tone") or tone_guidance,
            perspective=channel_cfg.get("perspective")
                or "third_person_objective — narrate ABOUT the subject, not as personal anecdote.",
            hook_style=channel_cfg.get("hook_style") or "open with the most surprising element of the topic",
            image_style=channel_cfg.get("image_style") or "professional photography, sharp focus",
            facts_block=facts_block,
            word_min=word_min, word_max=word_max, hard_cap=hard_cap,
        )

    primary = "NIM (" + nim.TEXT_MODEL_PRIMARY + ")" if nim.is_available() else f"Groq ({GROQ_MODEL})"
    log.info(f"Calling LLM | primary={primary} | prompt_version={PROMPT_VERSION} "
             f"| tone={tone} | words={word_min}-{word_max}")
    extra = None
    last_raw = ""

    for attempt in range(1, max_attempts + 1):
        try:
            raw_text = retry(
                lambda: _call_llm(prompt, extra),
                attempts=3,
                on=(requests.RequestException, requests.HTTPError),
                desc="llm",
            )
        except Exception as e:
            log.error(f"LLM call failed after retries: {e}")
            return None

        last_raw = raw_text
        try:
            script = json.loads(_strip_fences(raw_text))
        except json.JSONDecodeError as e:
            log.warning(f"Attempt {attempt}: invalid JSON: {e}")
            extra = [
                {"role": "assistant", "content": raw_text},
                {"role": "user", "content": f"Your previous reply was not valid JSON ({e}). Reply again with ONLY the JSON object."},
            ]
            continue

        # Wide acceptance margin (+100 over target_max). The 120b reasoning
        # model tends to write 180-220 words even when asked for shorter —
        # the script is still on-brand and usable, so rejecting it just
        # burns API budget on retries that often produce the same length.
        # 2026-07-15: widened word_min tolerance from -20 to -40 and added
        # a LAST-ATTEMPT rescue path — if we're on the final attempt and
        # word count is within 90% of target min, ship it anyway rather
        # than fail the whole render (Oracle logs showed 158-word narrations
        # rejected against min=180 → whole render aborted → 5 failed jobs
        # in a row).
        problems = _validate(script, word_min=max(60, word_min - 40), word_max=word_max + 100)
        if not problems:
            log.info(f"Script written: '{script.get('youtube_title', '')}'")
            return script

        # Last-attempt rescue — if the ONLY problem is "too short" and
        # we're within 90% of the min target, accept it. Better a
        # slightly-short but on-brand script than a failed render.
        if attempt == max_attempts and script:
            _wc = len(str(script.get("narration") or "").split())
            _short_only = all("too short" in p or "narration too short" in p for p in problems)
            if _short_only and _wc >= int(word_min * 0.85):
                log.warning(
                    f"Script last-attempt rescue: {_wc} words < target min {word_min} "
                    f"but within 85% — accepting rather than failing the render."
                )
                return script

        log.warning(f"Attempt {attempt}: schema problems: {problems}")
        extra = [
            {"role": "assistant", "content": raw_text},
            {"role": "user", "content": "Your previous reply had these problems:\n  - " + "\n  - ".join(problems) + "\nFix all of them and reply with ONLY the corrected JSON object."},
        ]

    log.error(f"Script generation failed after {max_attempts} attempts. Last raw: {last_raw[:300]}")
    return None

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

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

PROMPT_VERSION = "v7"

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
  1. FIRST LINE = a hook that puts something WRONG in the viewer's head
     immediately. A single concrete, off-kilter detail anchored in the
     premise. NO "It started when…", "I'll never forget…", "Let me tell
     you about…", "It's been happening since I arrived…". Drop the
     viewer mid-scene with something already broken.
  2. First person, PRESENT tense throughout. "I hear", not "I heard".
  3. Lean into DREAD, not jump-scares. The thing that scares the viewer
     isn't a monster reveal — it's the moment they realize the rules of
     reality bent quietly and the narrator didn't notice. Wrongness over
     gore. Implication over description.
  4. Use body horror in the *sensation* sense: the wet sound from the
     wall, the breath that isn't yours, the warmth of a hand on your
     shoulder when both your hands are visible. Specific, somatic,
     non-graphic. Skip explicit violence and slasher content — that's
     not where the chill lives.
  5. Build paranoia: each beat should make a safe thing the narrator
     mentioned earlier feel unsafe in retrospect. Re-contextualise the
     mundane.
  6. Escalate every 2-3 sentences. The reader should be afraid to keep
     reading by the halfway point.
  7. End on ONE final line — a single new fact that makes everything
     above worse. Not a twist; a confirmation of the worst-case
     interpretation the viewer had been pushing away.
  8. LENGTH IS NOT OPTIONAL: narration must be {word_min}-{word_max} words.
     This is a HARD CEILING — count your words before submitting and stop
     writing when you reach {word_max}. Cut adverbs and connective tissue,
     never the imagery. A {hard_cap}-word response is automatically rejected.
  9. STRICTLY NO sexual content, no romantic/intimate subtext, no nudity,
     no sexual violence. The genre is psychological terror, not adult.

BANNED PHRASES — do not use any of these (or paraphrases):
  - "my heart pounding/racing", "blood ran cold", "chill down my spine"
  - "raspy voice", "darkest secret", "deepest fear"
  - "little did I know", "what happened next", "you won't believe"
  - "creaks and groans", "wooden beams", "settling house"
  - listing literal sensory data with numbers ("52-degree air", "60 Hz hum")
  - explicit gore: "blood pooling", "intestines", "split skull", etc. —
    aim for unease, not splatter
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
  "narration": "160-200 word first-person present-tense horror narration",
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
                "You are an expert YouTube Shorts writer specializing in "
                "gothic-horror narration. Respond with a single JSON object "
                "only — no markdown fences, no preamble, no trailing text."
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
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY not set in .env file")

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
        "Authorization": f"Bearer {GROQ_API_KEY}",
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
    """
    s = load_settings()
    tone = s["content"].get("tone", "atmospheric")
    word_min = int(s["content"].get("target_word_min", 160))
    word_max = int(s["content"].get("target_word_max", 200))
    tone_guidance = TONE_GUIDANCE.get(tone, TONE_GUIDANCE["atmospheric"])

    channel_type = research_data.get("type", "horror")
    # hard_cap = the rejection ceiling. Putting this into the prompt lets
    # the LLM self-police; matching exactly the validator's bound means
    # the model won't be surprised by rejections.
    hard_cap = word_max + 100
    fmt = dict(tone_guidance=tone_guidance, word_min=word_min,
               word_max=word_max, hard_cap=hard_cap)
    if channel_type == "horror":
        prompt = HORROR_PROMPT.format(title=research_data["raw_title"], **fmt)
    else:
        prompt = WISDOM_PROMPT.format(
            title=research_data["raw_title"],
            keywords=", ".join(research_data.get("keywords", [])),
            **fmt,
        )

    primary = "NIM (" + nim.TEXT_MODEL + ")" if nim.is_available() else f"Groq ({GROQ_MODEL})"
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
        # If you want SHORTER scripts, lower target_word_max in settings
        # AND we now also push the hard cap into the prompt itself below.
        problems = _validate(script, word_min=max(60, word_min - 20), word_max=word_max + 100)
        if not problems:
            log.info(f"Script written: '{script.get('youtube_title', '')}'")
            return script

        log.warning(f"Attempt {attempt}: schema problems: {problems}")
        extra = [
            {"role": "assistant", "content": raw_text},
            {"role": "user", "content": "Your previous reply had these problems:\n  - " + "\n  - ".join(problems) + "\nFix all of them and reply with ONLY the corrected JSON object."},
        ]

    log.error(f"Script generation failed after {max_attempts} attempts. Last raw: {last_raw[:300]}")
    return None

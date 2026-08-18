"""
silent_story.py — write a WORDLESS short: a beat sheet, not a narration.

Every other niche in this pipeline hangs off narration. The scriptwriter
writes words, TTS turns them into audio, the audio's real duration
decides the video's length, and the storyboard cuts that narration into
shots. Remove the words and all four of those collapse at once — which
is why this is its own module rather than a flag on the scriptwriter.

What replaces narration is a BEAT SHEET: an ordered list of story beats,
each with its own duration in seconds and a description of what the
viewer SEES. The beats are the timing spine. Total runtime is decided
here, up front, instead of being discovered after TTS runs.

Two things this module is careful about, because both are the difference
between "a wordless story" and "some pretty clips in a row":

  1. THE STORY MUST RESOLVE. A wordless short has no narrator to explain
     what happened, so if the ending is not legible from action alone it
     did not happen. The prompt forces a setup / turn / payoff and makes
     the model state the payoff as a physical, visible event.

  2. ONE CHARACTER, PHYSICALLY SPECIFIED. Character consistency across
     generated clips is won or lost in the prompt: a cast described as
     "a young girl" drifts every shot, while "a round-faced girl of
     about seven, dark bob with a blunt fringe, mustard-yellow raincoat,
     red rubber boots" survives being re-drawn eight times. The schema
     demands that level of detail and validation rejects anything short.

The output is deliberately shaped like the scriptwriter's return value
(`narration`, `youtube_title`, `description`, `tags`) so every downstream
consumer — SEO writer, storyboard, uploader, run summary — keeps working
without knowing this niche exists. `narration` here is story prose that
is NEVER spoken; it exists so the storyboard and the SEO writer have
something to read. `silent: True` is what tells main.py to skip TTS.
"""
from __future__ import annotations

import json
import logging
import re

log = logging.getLogger(__name__)

# Shorts that resolve a story in under ~30s feel clipped, and past ~60s
# YouTube stops treating it as a Short. The model is told to land inside
# this window and the result is clamped to it.
MIN_SECONDS = 30.0
MAX_SECONDS = 60.0

# One beat per generated clip. Image-to-video models hold coherence for
# a few seconds and then start inventing, so beats are kept short — and
# more, shorter beats also read as better editing than fewer long ones.
MIN_BEAT_SECONDS = 3.0
MAX_BEAT_SECONDS = 6.0

# Below this many characters a "look" is a label rather than a
# description, and the character will drift between clips.
MIN_LOOK_CHARS = 80


_PROMPT = """You are a story artist writing a WORDLESS animated short film, in the tradition of Pixar's dialogue-free shorts (For the Birds, Piper, Paperman's opening).

TOPIC / SEED: {topic}

ABSOLUTE RULES:
- NOBODY SPEAKS. There is no dialogue, no narrator, no voice of any kind, and no on-screen text. Everything the audience understands, they understand from ACTION, FACIAL EXPRESSION and CONSEQUENCE.
- Therefore: never write a beat whose meaning depends on words. "She explains that she is lost" is impossible. "She turns the map upside down, then looks up at an identical row of trees in every direction" is the same information, told visually.
- The story must RESOLVE. A wordless short with no payoff reads as an unfinished clip. The final beat must show a physical, visible change: something is gained, lost, mended, or revealed.
- Total runtime {min_s:.0f}-{max_s:.0f} seconds.

STRUCTURE (three acts, compressed):
1. SETUP — establish the character, the place, and what they WANT, in the first two beats. Wanting must be shown by reaching for something, watching something, or being denied something.
2. TURN — an obstacle or surprise. The middle beats.
3. PAYOFF — the resolution. The last beat is the image the viewer remembers.

CHARACTER CONSISTENCY IS CRITICAL. Every beat is rendered by a separate image model, so the character is re-drawn from scratch each time and will drift unless it is pinned down. In `cast[].look`, give an exhaustive PHYSICAL description: age, body shape, face shape, skin tone, hair colour AND cut, eye colour, and every garment with its exact colour and material. At least 25 words. Never "a little girl" or "an old man" — those re-draw as a different person every time.

Return ONLY this JSON, no prose, no markdown fences:
{{
  "title": "short evocative title, max 8 words, no colon",
  "logline": "one sentence describing the whole story",
  "cast": [
    {{"name": "OneWordName",
      "look": "exhaustive physical description, 25+ words, every garment and colour named",
      "personality": "how they move and react, in a few words"}}
  ],
  "setting": "where this happens, described visually — time of day, weather, architecture, palette",
  "beats": [
    {{"seconds": 4.5,
      "action": "what physically happens, present tense, one sentence. Camera-visible only.",
      "emotion": "what the character's face is doing",
      "camera": "shot size and movement, e.g. 'wide static', 'slow push in on her face', 'low angle tracking'"}}
  ]
}}

Rules for `beats`:
- Between {min_beat:.0f} and {max_beat:.0f} seconds each. They must sum to between {min_s:.0f} and {max_s:.0f}.
- 8 to 12 beats.
- `action` describes ONE continuous piece of motion. Not "she walks in, sits, and opens the box" — that is three beats.
- Keep the SAME cast across beats. A one-character story is stronger than a three-character one at this length.

Rules for `cast`:
- One or two characters. Never more.
- Non-human protagonists (an animal, a lamp, a robot) are welcome and often read better wordlessly.
"""


def _strip_fences(text: str) -> str:
    t = (text or "").strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", t, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else t


def _coerce(raw: str) -> dict | None:
    try:
        return json.loads(_strip_fences(raw))
    except Exception:
        # Models occasionally wrap the object in commentary. Take the
        # outermost braces and retry once before giving up on the whole
        # (slow) generation.
        t = _strip_fences(raw)
        i, j = t.find("{"), t.rfind("}")
        if i >= 0 and j > i:
            try:
                return json.loads(t[i:j + 1])
            except Exception:
                return None
    return None


def _validate(d: dict) -> tuple[bool, str]:
    """Reject a beat sheet that would render badly, with the reason.

    The reason string is fed back to the model on the retry, so it is
    written as an instruction rather than an error code.
    """
    if not isinstance(d, dict):
        return False, "response was not a JSON object"

    cast = d.get("cast")
    if not isinstance(cast, list) or not cast:
        return False, "`cast` must be a non-empty list"
    if len(cast) > 2:
        return False, "at most two characters — cut the story down to one or two"
    for c in cast:
        if not isinstance(c, dict):
            return False, "each cast entry must be an object"
        if not str(c.get("name") or "").strip():
            return False, "every cast member needs a `name`"
        look = str(c.get("look") or "").strip()
        if len(look) < MIN_LOOK_CHARS:
            return False, (
                f"`look` for {c.get('name')!r} is too vague to redraw "
                f"consistently — name the face, hair, and every garment "
                f"with its colour, at least 25 words"
            )

    beats = d.get("beats")
    if not isinstance(beats, list) or len(beats) < 6:
        return False, "`beats` must be a list of at least 6 beats"
    if len(beats) > 14:
        return False, "too many beats — merge them down to 12 or fewer"

    total = 0.0
    for i, b in enumerate(beats):
        if not isinstance(b, dict):
            return False, f"beat {i + 1} must be an object"
        if not str(b.get("action") or "").strip():
            return False, f"beat {i + 1} has no `action`"
        try:
            s = float(b.get("seconds") or 0)
        except (TypeError, ValueError):
            return False, f"beat {i + 1} has a non-numeric `seconds`"
        if s <= 0:
            return False, f"beat {i + 1} needs a positive `seconds`"
        total += s

    if not (MIN_SECONDS - 5 <= total <= MAX_SECONDS + 10):
        return False, (
            f"the beats total {total:.0f}s — retime them to land between "
            f"{MIN_SECONDS:.0f} and {MAX_SECONDS:.0f} seconds"
        )
    return True, ""


def _clamp_beats(beats: list[dict]) -> tuple[list[dict], float]:
    """Clamp each beat into the model's coherence window, then scale the
    whole sheet to fit the runtime cap.

    Clamping first and scaling second matters: scaling a sheet that
    contains a 12-second beat just produces a smaller over-long beat,
    and that beat is the one where a generated clip starts inventing
    geometry.
    """
    out = []
    for b in beats:
        try:
            s = float(b.get("seconds") or 0)
        except (TypeError, ValueError):
            s = MIN_BEAT_SECONDS
        s = max(MIN_BEAT_SECONDS, min(MAX_BEAT_SECONDS, s))
        nb = dict(b)
        nb["seconds"] = s
        out.append(nb)

    total = sum(b["seconds"] for b in out)
    if total > MAX_SECONDS:
        # Drop whole beats from the MIDDLE rather than squeezing every
        # beat below the coherence floor. The first beats establish and
        # the last one resolves; the expendable material is in the turn.
        while len(out) > 6 and sum(b["seconds"] for b in out) > MAX_SECONDS:
            out.pop(len(out) // 2)
        total = sum(b["seconds"] for b in out)
    if total > MAX_SECONDS:
        k = MAX_SECONDS / total
        for b in out:
            b["seconds"] = max(MIN_BEAT_SECONDS, b["seconds"] * k)
        total = sum(b["seconds"] for b in out)
    return out, total


def _story_prose(d: dict) -> str:
    """Flatten the beat sheet into prose.

    NEVER SPOKEN. This exists because the storyboard and the SEO writer
    both take a block of text and this niche has none — writing the
    story out in order gives them the same shape of input every other
    niche gives them, without a `if silent:` branch in either.
    """
    parts = []
    setting = str(d.get("setting") or "").strip()
    if setting:
        parts.append(f"Setting: {setting}")
    for c in (d.get("cast") or []):
        parts.append(f"{c.get('name')}: {c.get('look')}")
    for i, b in enumerate(d.get("beats") or [], 1):
        line = str(b.get("action") or "").strip()
        emo = str(b.get("emotion") or "").strip()
        parts.append(f"{i}. {line}" + (f" ({emo})" if emo else ""))
    return "\n".join(parts)


def write_beat_sheet(research_data: dict, max_attempts: int = 3) -> dict | None:
    """Write a wordless short. Returns a script-shaped dict, or None.

    Shaped like scriptwriter.write_script's return so main.py, the SEO
    writer and the uploader need no special case:

        narration      story prose — for the storyboard/SEO to read,
                       never for TTS to speak
        silent         True — main.py reads this to skip the voiceover
        target_seconds authoritative runtime, since there is no audio
                       file to measure
        beats          the timing spine
        cast           character bible, used to build reference art
    """
    topic = (
        research_data.get("raw_title")
        or research_data.get("topic")
        or research_data.get("premise")
        or "a small character who wants one simple thing"
    )
    prompt = _PROMPT.format(
        topic=str(topic)[:400],
        min_s=MIN_SECONDS, max_s=MAX_SECONDS,
        min_beat=MIN_BEAT_SECONDS, max_beat=MAX_BEAT_SECONDS,
    )

    # Borrow the scriptwriter's chain rather than calling nim.chat
    # directly. It walks LLM_PRIORITY and then falls back to Groq
    # explicitly, because a render cannot proceed without a script —
    # and a beat sheet is this niche's script.
    from modules.scriptwriter import _call_llm

    extra: list[dict] = []
    for attempt in range(1, max_attempts + 1):
        raw = _call_llm(prompt, extra_messages=extra or None)
        if not raw:
            log.warning(f"silent_story: attempt {attempt} returned nothing")
            continue
        d = _coerce(raw)
        if d is None:
            log.warning(f"silent_story: attempt {attempt} was not JSON")
            extra = [
                {"role": "assistant", "content": str(raw)[:2000]},
                {"role": "user", "content": "That was not valid JSON. Return ONLY the JSON object."},
            ]
            continue
        ok, why = _validate(d)
        if not ok:
            log.warning(f"silent_story: attempt {attempt} rejected — {why}")
            extra = [
                {"role": "assistant", "content": json.dumps(d)[:2000]},
                {"role": "user", "content": f"Fix this and return the corrected JSON only: {why}"},
            ]
            continue

        beats, total = _clamp_beats(d.get("beats") or [])
        cast = d.get("cast") or []
        title = str(d.get("title") or "").strip()[:100]

        log.info(
            "silent_story: %d beats, %.1fs total, cast: %s",
            len(beats), total, ", ".join(str(c.get("name")) for c in cast),
        )
        for i, b in enumerate(beats, 1):
            log.info("  beat %2d [%.1fs] %s", i, b["seconds"], str(b.get("action"))[:90])

        return {
            "silent":         True,
            "target_seconds": round(total, 2),
            "beats":          beats,
            "cast":           cast,
            "setting":        str(d.get("setting") or ""),
            "logline":        str(d.get("logline") or ""),
            # Downstream-compatible fields.
            "narration":      _story_prose(d),
            "youtube_title":  title,
            "raw_title":      title,
            "description":    str(d.get("logline") or "")[:500],
            "tags":           [],
        }

    log.error("silent_story: no attempt produced a usable beat sheet")
    return None


def shots_from_beats(script: dict) -> list[dict]:
    """Turn the beat sheet directly into timed storyboard shots.

    The LLM storyboard step is SKIPPED for wordless shorts, deliberately.
    Its whole job is to infer visual shots from spoken narration, and
    here the beats already ARE shots — each one has its action, its
    emotion, its camera and its own duration. Round-tripping them
    through a second model would only give it the chance to lose the
    character descriptions and the timing.

    Emits the same keys shotfinder expects (`ai_prompt`,
    `visual_description`, `search_query`, `cast_names`, `start`, `end`)
    so nothing downstream can tell the difference.
    """
    beats = script.get("beats") or []
    cast = script.get("cast") or []
    setting = str(script.get("setting") or "").strip()

    # Every character's look is appended to every prompt in the same
    # phrasing shotfinder's cast-sheet parser looks for
    # ("Character reference — Name: look"), so the anchor portraits it
    # builds are keyed to the same names these shots declare.
    cast_clause = "; ".join(
        f"{c.get('name')}: {c.get('look')}" for c in cast if c.get("look")
    )
    names = [str(c.get("name")) for c in cast if c.get("name")]

    shots: list[dict] = []
    cursor = 0.0
    for b in beats:
        dur = float(b.get("seconds") or MIN_BEAT_SECONDS)
        action = str(b.get("action") or "").strip()
        emotion = str(b.get("emotion") or "").strip()
        camera = str(b.get("camera") or "").strip()

        prompt_parts = [action]
        if emotion:
            prompt_parts.append(f"Expression: {emotion}")
        if camera:
            prompt_parts.append(f"Camera: {camera}")
        if setting:
            prompt_parts.append(f"Setting: {setting}")
        if cast_clause:
            prompt_parts.append(f"Character reference — {cast_clause}")

        shots.append({
            # narration_excerpt drives assign_timing's weighting
            # elsewhere; here timing is explicit, but the SEO writer and
            # the run summary both read it, so it carries the action.
            "narration_excerpt":  action[:240],
            "visual_description": action[:240],
            # No stock search should ever run for this niche — every
            # frame is generated. Left populated only because some
            # fallback paths log it.
            "search_query":       action[:80],
            "ai_prompt":          ". ".join(p for p in prompt_parts if p)[:1200],
            "cast_names":         list(names),
            "start":              round(cursor, 3),
            "end":                round(cursor + dur, 3),
        })
        cursor += dur
    return shots

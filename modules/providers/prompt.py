"""Prompt shaping shared by every image provider.

Current behaviour is LIGHT natural-language cleanup capped at ~600
chars, NOT the tag-style compression the name suggests. That changed in
July 2026 with the Flux-2 klein migration: klein uses a Qwen text
encoder that wants prose, and comma-splitting sentences into tags plus
appending "photorealistic, cinematic, sharp focus" actively degraded its
output. See _regex_distill's docstring for the detail.

The old header comment describing "comma-separated subject + details +
style" travelled with this code when it moved and was already two
rewrites out of date — corrected here rather than carried a third time,
because a stale comment at the top of a module is read as the spec.

It lives here rather than in any one provider because FIVE of them call
it. It was the single thing blocking the generate bodies from moving
out of shotfinder: every provider body depended on a helper that lived
in the file they were leaving.

Public name is `distill_prompt_for_flux`. shotfinder keeps importing it
under its old private alias so the seven existing call sites did not
all have to change in the same commit as the move.
"""

from __future__ import annotations

import logging
import os
import re

from modules import nim

log = logging.getLogger(__name__)

# Flux prompt distiller — condenses long visual_description prose into
# a cleaned, length-capped prompt. Flux weights roughly the first 77
# tokens meaningfully, so a 500-char poetic description used to get
# truncated mid-clause and the model invented the rest.
#
# NOTE: output is natural-language prose, not tags — see
# _regex_distill. Tag-style output was correct for SDXL and is WRONG
# for Flux-2 klein's Qwen encoder.
_FLUX_DISTILL_CACHE: dict[str, str] = {}


# One-shot session flag — after the first NIM distiller timeout we
# stop calling NIM entirely and use the regex-based shortener for the
# rest of the render. Was previously burning ~30 sec per shot on NIM
# timeouts, one per shot × 8 shots = 4 minutes wasted per video.
_FLUX_DISTILLER_NIM_BROKEN = False


def _regex_distill(text: str) -> str:
    """Light natural-language cleanup — no LLM, no tag-splitting.

    Rewritten 2026-07-10 after the Flux-2 klein migration + a research
    pass against BFL's official prompt guide: klein uses a Qwen text
    encoder that wants NATURAL LANGUAGE. Comma-splitting sentences into
    tag style + appending "photorealistic, cinematic, sharp focus"
    quality-booster tags (what this function used to do) actively
    degrades klein output.

    So this function now only:
      - collapses whitespace runs
      - trims obvious filler phrases (still helps signal density)
      - hard-caps at ~600 chars (~120 words) which BFL calls the sweet
        spot for klein
    It preserves sentence punctuation so the model sees a paragraph, not
    a tag list.
    """
    import re
    t = (text or "").strip()
    # Kill filler phrases the LLM loves that add nothing for Flux.
    for junk in [
        "camera focuses on", "we see", "the frame captures",
        "the composition ", "the shot ", "the scene ", "the image ",
        "cinematic depth of field", "with a shallow depth of field",
    ]:
        t = re.sub(re.escape(junk), "", t, flags=re.IGNORECASE)
    # Whitespace cleanup only — preserve periods + commas as sentence
    # structure klein's encoder actually parses.
    t = re.sub(r"\s+", " ", t).strip()
    return t[:600].rstrip()


def _distill_prompt_for_flux(visual_description: str, channel: str = "") -> str:
    """Return a Flux-optimised tag-style prompt.

    Uses ONLY the deterministic regex distiller. NIM was previously used
    for a per-shot LLM rewrite, but the free tier's 40 rpm limit + our
    10 sec timeout meant every render burned quota on retries AND still
    fell back to regex. Skipping NIM entirely: same net output for
    slow-NIM renders (99% of them), zero rate-limit burn, no wasted
    wall-clock. The user can enable LLM distillation via the
    NIM_DISTILLER=1 env var if their NIM tier is genuinely fast.
    """
    key = (visual_description or "").strip()
    # Strip Nemotron's tokenization garbage — the model occasionally
    # returns unknown tokens as literal "<unk>" strings inside JSON,
    # which then reaches the image provider verbatim and causes 400s
    # (or with CF, an outright quota-burning gen of noise). Also drop
    # any JSON-wrapper the model added around the actual prompt.
    if "<unk>" in key:
        key = key.replace("<unk>", "").strip()
    if key.startswith("{") and '"prompt"' in key:
        try:
            _j = json.loads(key)
            if isinstance(_j, dict) and isinstance(_j.get("prompt"), str):
                key = _j["prompt"].strip()
        except Exception:
            pass
    if not key:
        return ""
    if key in _FLUX_DISTILL_CACHE:
        return _FLUX_DISTILL_CACHE[key]
    if os.getenv("NIM_DISTILLER", "").strip() not in ("1", "true", "yes"):
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out
    # Opt-in NIM path (user set NIM_DISTILLER=1). Same guard as before —
    # first NIM failure of the session flips the session-wide broken
    # flag so subsequent shots go straight to regex.
    global _FLUX_DISTILLER_NIM_BROKEN
    if _FLUX_DISTILLER_NIM_BROKEN:
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out
    try:
        prompt = (
            "Rewrite the scene below into a short image-generation prompt "
            "for Flux / SDXL. Format: 15 to 25 words, comma-separated. "
            "Structure: MAIN SUBJECT, key visual details, environment, "
            "lighting/mood, style tags. No poetic prose, no complete "
            "sentences, no 'shot' / 'scene' / 'image' words. "
            f"Channel: {channel or 'generic'}.\n\nSCENE: {key[:400]}\n\n"
            "Reply with ONLY the prompt string."
        )
        raw = nim.chat(
            messages=[{"role": "user", "content": prompt}],
            model="meta/llama-3.3-70b-instruct",
            max_tokens=80,
            temperature=0.5,
            stream=False,
            timeout=10,
            attempts=1,
        )
        distilled = (raw or "").strip().strip('"').strip().split("\n")[0]
        for pfx in ("Prompt:", "prompt:", "PROMPT:", "-"):
            if distilled.lower().startswith(pfx.lower()):
                distilled = distilled[len(pfx):].strip()
        distilled = distilled[:240]
        if len(distilled) < 15:
            distilled = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = distilled
        return distilled
    except Exception as e:
        _FLUX_DISTILLER_NIM_BROKEN = True
        log.warning(f"flux distiller (NIM opt-in): failed ({e}); regex from now on")
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out


# Public alias. The underscore-prefixed name is retained above so the
# moved code reads identically to its previous home, which keeps this
# commit reviewable as a MOVE rather than a rewrite.
distill_prompt_for_flux = _distill_prompt_for_flux
regex_distill = _regex_distill


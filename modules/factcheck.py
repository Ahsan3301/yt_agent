"""Reject claims the research never supplied.

WHY THIS IS CODE AND NOT A PROMPT RULE
--------------------------------------
Every generation prompt in this codebase already says some version of
"use these facts - invent nothing beyond them". The wisdom prompt has
said it for months. It does not hold. Asked for a script about being
the reliable one, from three plain sentences of research containing no
numbers and no sources, the model returned:

    "A 2022 Stanford study tracked 500 helpers over three years.
     Those who never declined were promoted faster, yet reported
     47% higher stress."

There is no such study. The year, the institution, the sample size and
the percentage were all invented, and the result is a confident,
citable, false statistic attributed to a real university - published to
YouTube automatically, with nobody reading it first.

Instructions are a request. A validator is a wall. The retry loop
already re-prompts on schema problems, so a claim problem raised here
gets the same treatment: the model is told exactly what it made up and
writes again.

WHAT IT FLAGS
-------------
Deliberately narrow, because a guard that cries wolf gets switched off:

  1. Percentages absent from the research. A number with a % sign that
     the research never mentioned is invented - there is no innocent
     way to arrive at "47%".
  2. Large or scaled quantities absent from the research (>=100, or any
     figure carrying million/billion/trillion).
  3. Years absent from the research.
  4. Named institutions and journals absent from the research -
     Stanford, NASA, The Lancet. Borrowed authority is the most
     damaging kind of fabrication.
  5. Attribution cues ("a study found", "according to researchers")
     when the research contains no source at all.

WHAT IT DELIBERATELY ALLOWS
---------------------------
Small bare numbers - "six weeks ago", "three years", "the second
floor". Narration needs ordinary counts and durations to sound human,
they are not claims of evidence, and flagging them would fire on every
script until someone turned the guard off. A fabricated statistic
almost always carries a percentage, a scale word, a year or a named
source, and those are all caught above.

The check is per-niche-blind on purpose. Horror narration is allowed
its atmosphere, but "a 2019 Stanford study" is exactly as false in a
horror script as in a wisdom one.
"""

from __future__ import annotations

import re

# Institutions and journals whose names lend borrowed authority. Not
# exhaustive and does not need to be - it covers the names a model
# reaches for when it wants a claim to sound sourced.
_AUTHORITY_NAMES = (
    "stanford", "harvard", "mit", "oxford", "cambridge", "yale",
    "princeton", "berkeley", "caltech", "johns hopkins", "cornell",
    "columbia university", "university of chicago", "carnegie mellon",
    "nasa", "noaa", "cdc", "fbi", "cia", "nih", "who",
    "world health organization", "national institutes of health",
    "the lancet", "lancet", "jama", "new england journal",
    "nature", "scientific american", "pnas", "bmj",
    "pew research", "pew", "gallup", "mckinsey", "deloitte", "nielsen",
    "harvard business review", "mayo clinic", "cleveland clinic",
)

# Phrases that assert evidence exists.
_ATTRIBUTION_CUES = (
    "study", "studies", "research", "researchers", "scientists",
    "survey", "surveyed", "poll", "polled", "experiment",
    "clinical trial", "according to", "data from", "report found",
    "reports found", "found that", "peer-reviewed", "published in",
    "statistics show", "evidence shows",
)

# Markers that the supplied research is itself sourced. If the research
# cites something, the script is allowed to say "a study found".
_SOURCE_MARKERS = _ATTRIBUTION_CUES + (
    "http", "www.", "source:", "doi", "journal", "et al", "reported by",
)

_SCALE_WORDS = ("million", "billion", "trillion")

_NUM_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _digits(text: str) -> set[str]:
    """Every number in `text`, comma-stripped, for containment tests."""
    out = set()
    for m in _NUM_RE.finditer(text or ""):
        raw = m.group(0).replace(",", "")
        out.add(raw)
        # 15.0 and 15 are the same claim.
        if raw.endswith(".0"):
            out.add(raw[:-2])
    return out


def _supported_number(num: str, fact_digits: set[str], facts_low: str) -> bool:
    if num in fact_digits:
        return True
    # "1 billion" in the research supports "a billion" in the script.
    if num in ("1", "1.0") and any(w in facts_low for w in _SCALE_WORDS):
        return True
    return False


def unsupported_claims(narration: str, facts_text: str) -> list[str]:
    """Return human-readable problems for claims the research never made.

    `facts_text` should be everything the writer was given - the fact
    list, the research summary, the title. Anything the model was
    legitimately working from counts as support.

    Returns [] when the narration invents nothing checkable.
    """
    if not isinstance(narration, str) or not narration.strip():
        return []
    facts_text = facts_text or ""
    low = narration.lower()
    facts_low = facts_text.lower()
    fact_digits = _digits(facts_text)
    problems: list[str] = []

    # 1. Percentages.
    for m in re.finditer(r"(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent)", low):
        num = m.group(1).replace(",", "")
        if not _supported_number(num, fact_digits, facts_low):
            problems.append(
                f"invented statistic: '{m.group(0).strip()}' does not appear in the "
                f"research. Remove it or replace it with a fact you were given."
            )

    # 2. Scaled or large quantities.
    for m in re.finditer(
        r"(\d[\d,]*(?:\.\d+)?)\s*(million|billion|trillion)?", low
    ):
        num = m.group(1).replace(",", "")
        scale = m.group(2)
        try:
            val = float(num)
        except ValueError:
            continue
        # Small bare counts are narration, not evidence - see docstring.
        if not scale and val < 100:
            continue
        if _supported_number(num, fact_digits, facts_low):
            continue
        # A year is handled below; don't report it twice.
        if not scale and 1800 <= val <= 2099 and val == int(val):
            continue
        shown = m.group(0).strip()
        problems.append(
            f"invented figure: '{shown}' does not appear in the research."
        )

    # 3. Years.
    for m in re.finditer(r"\b(1[89]\d{2}|20\d{2})\b", low):
        y = m.group(1)
        if y not in fact_digits:
            problems.append(
                f"invented date: the year {y} does not appear in the research."
            )

    # 4. Borrowed authority.
    for name in _AUTHORITY_NAMES:
        if re.search(rf"\b{re.escape(name)}\b", low) and name not in facts_low:
            problems.append(
                f"invented source: '{name}' is never mentioned in the research. "
                f"Do not attribute claims to institutions you were not given."
            )

    # 5. Evidence claimed where the research cites none.
    if not any(mark in facts_low for mark in _SOURCE_MARKERS):
        for cue in _ATTRIBUTION_CUES:
            if re.search(rf"\b{re.escape(cue)}\b", low):
                problems.append(
                    f"unsupported attribution: the narration says '{cue}' but the "
                    f"research contains no source. State the idea directly instead "
                    f"of claiming evidence for it."
                )
                break

    # De-duplicate, preserving order - the same invented year can appear
    # twice and one message is enough.
    seen = set()
    unique = []
    for p in problems:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique

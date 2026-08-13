"""Structural retention checks on finished narration.

Separate from modules/factcheck.py on purpose: that module asks "is this
TRUE", this one asks "does this KEEP WATCHING". A script can be perfectly
factual and still lose the viewer at second twelve.

THE ECHO PROBLEM
----------------
A Short has one job in its final seconds: make the ending land somewhere
the opening did not. When the closer merely re-says the hook in fresh
words, the viewer has learned nothing by staying, and the format's whole
retention curve flattens.

The prompt already carries a restatement-vs-reframe rule. It does not
hold. Two of three sampled scripts echoed their own hook:

  hook   "Gold-plated copper outlives Earth by a billion years."
  later  "The gold-plated copper will survive roughly a billion years."

  hook   "Being reliable costs more than your time."
  closer "Being reliable doesn't cost your time - it costs you."

Both are the same sentence twice. So the check moved from the prompt,
where it was a suggestion, into the retry loop, where it is a condition.

TUNING
------
Jaccard overlap of content words against the hook, threshold 0.5, both
sentences needing at least 3 content words. Measured against real
output rather than picked from the air:

  "The gold-plated copper will survive..."  0.57  -> flagged
  "Being reliable doesn't cost your time"   1.00  -> flagged
  "Nothing on floor 3." vs a hook about
  floor 3 motion sensors                    0.25  -> allowed

That last one is the case that matters. It shares a location with the
hook and repeats none of its meaning; a naive containment check flags
it, and a guard that flags ordinary callbacks would have to be turned
off. Jaccard punishes short sentences that share a word or two far less
than it punishes genuine restatement.
"""

from __future__ import annotations

import re

_STOPWORDS = frozenset("""
a an the and or but if then than that this these those there here
is are was were be been being am do does did doing done
have has had having will would shall should can could may might must
of in on at to from by for with without into onto over under
it its it's you your yours i me my we our us they them their
as so just only even still yet not no nor too very much many more most
what when where who whom which why how all any both each few other some
one two three
""".split())

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
_WORD = re.compile(r"[a-z0-9][a-z0-9'\-:]*")


def _content_words(sentence: str) -> set[str]:
    """Meaning-bearing words, crudely normalised for plural/tense."""
    out = set()
    for w in _WORD.findall((sentence or "").lower()):
        # Everything from the apostrophe on is dropped, which does three
        # jobs at once: "humanity's" -> "humanity" (it previously
        # tokenised to "humanity'" and silently failed to match, hiding a
        # real spoiler), "Marcus's" -> "marcus", and contractions like
        # "you're" -> "you", which is a stopword and correctly falls out.
        # Left intact, "you're" counted as a distinctive reveal word.
        w = re.sub(r"'.*$", "", w)
        if w in _STOPWORDS or len(w) < 2:
            continue
        # costs/cost and outlives/outlive should count as the same idea.
        if len(w) > 4 and w.endswith("es"):
            w = w[:-2]
        elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.add(w)
    return out


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_SPLIT.split(text or "") if s.strip()]


def hook_echoes(narration: str, threshold: float = 0.5) -> list[str]:
    """Return problems for sentences that restate the opening line.

    Returns [] when every later sentence advances the idea.
    """
    sents = _sentences(narration)
    if len(sents) < 3:
        return []

    hook = sents[0]
    hook_words = _content_words(hook)
    if len(hook_words) < 3:
        return []

    problems = []
    for i, s in enumerate(sents[1:], start=2):
        words = _content_words(s)
        if len(words) < 3:
            continue
        union = hook_words | words
        if not union:
            continue
        overlap = len(hook_words & words) / len(union)
        if overlap >= threshold:
            where = "closing line" if i == len(sents) else f"sentence {i}"
            problems.append(
                f"the {where} restates the hook instead of advancing it "
                f"(\"{s[:70]}\" repeats \"{hook[:70]}\"). The ending must land "
                f"somewhere the opening did not - reframe the idea, reveal a "
                f"consequence, or turn it on the viewer. Do not re-say it."
            )
            # One is enough; fixing it usually fixes the rest.
            break
    return problems


def title_spoils(title: str, narration: str, threshold: float = 0.5) -> list[str]:
    """Return a problem when the title gives away the video's ending.

    Shorts rank on watch-through, not on metadata, so a title carrying
    the payoff is actively self-defeating: it harvests the impression
    and then removes the reason to stay for the answer.

    Compared against the FINAL THIRD of the narration, not the whole
    thing, and that choice is the whole design:

      - A title that echoes the HOOK is fine, often ideal. "Why being
        reliable gets you used, not thanked" is the opening premise and
        it is a good title - it opens the loop.
      - A title that echoes the ENDING is the failure. "Why 15 billion
        miles away is still humanity's last trace" hands over the
        closing line, so the viewer has already had the payoff before
        pressing play.

    The signal is NOT bulk similarity, which was measured and does not
    separate: real spoilers and clean titles both sit around 0.0-0.3
    overlap with the ending, because a title is a handful of words and
    an ending is several sentences.

    What separates them is WHICH words are shared. A spoiler carries the
    vocabulary the ending INTRODUCES - the words the video has been
    withholding:

      "Why 15 billion miles away is still humanity's last trace"
        shares 'trace', 'humanity' - both appear nowhere before the
        final third. That is the reveal, printed on the thumbnail.

      "The night guard saw his own face on the monitor"
        shares 'face'. One word, and it is the entire twist.

      "Why being reliable gets you used, not thanked"     0 reveal words
      "3:14 AM on Floor Three"                            0 reveal words

    So the test is: does the title contain any word that the narration
    saves for its ending? One is enough, because the withheld word IS
    the payoff. Words the opening already said are free - a title
    echoing the hook is good practice, not a spoiler.
    """
    if not isinstance(title, str) or not title.strip():
        return []
    sents = _sentences(narration)
    if len(sents) < 3:
        return []

    # Final third, minimum two sentences - the reveal is rarely one line.
    tail_start = max(1, len(sents) - max(2, len(sents) // 3))
    tail_words = _content_words(" ".join(sents[tail_start:]))
    setup_words = _content_words(" ".join(sents[:tail_start]))

    # Vocabulary the ending introduces and the setup never used.
    reveal_words = {w for w in (tail_words - setup_words) if len(w) >= 4}
    if not reveal_words:
        return []

    shared = _content_words(title) & reveal_words
    if not shared:
        return []

    return [
        f"the title gives away the ending (\"{title[:70]}\" uses "
        f"{', '.join(sorted(shared))} — words the narration withholds until its "
        f"final lines). Shorts are ranked on watch-through, so a title carrying "
        f"the payoff wins the impression and loses the view. Title the QUESTION "
        f"the video answers or the situation it opens, never the answer itself. "
        f"Echoing the OPENING is fine."
    ]

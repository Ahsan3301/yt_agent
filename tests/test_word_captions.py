"""Tests for plan_word_events — CapCut-style per-word highlight events."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.editor import plan_word_events


def test_one_event_per_word():
    text = "I hear it again."
    events = plan_word_events(text, audio_duration=4.0)
    # 4 words → 4 events.
    assert len(events) == 4


def test_events_are_sequential_and_nonoverlapping():
    text = "One two three four five six seven eight nine ten."
    events = plan_word_events(text, audio_duration=10.0)
    for a, b in zip(events, events[1:]):
        assert a["end"] <= b["start"] + 1e-6, f"overlap: {a} -> {b}"


def test_total_duration_matches_audio():
    text = "One two three four five six."
    events = plan_word_events(text, audio_duration=6.0)
    total_end = events[-1]["end"]
    assert abs(total_end - 6.0) < 0.05


def test_active_word_is_highlighted():
    """The active word should appear inside a color + bold override.

    Color and font size are configurable via settings.json, so we don't pin
    them here — just verify the override structure and the right word is
    inside it.
    """
    import re
    text = "Hello world."
    events = plan_word_events(text, audio_duration=2.0)
    # Override pattern: {\c&H<6hex>&\b1\fs<digits>}<word>{\r}
    pat = lambda word: re.compile(
        r"\{\\c&H[0-9A-Fa-f]{6}&\\b1\\fs\d+\}" + re.escape(word) + r"\{\\r\}"
    )
    assert pat("Hello").search(events[0]["text"]), events[0]["text"]
    assert pat("world.").search(events[1]["text"]), events[1]["text"]


def test_full_chunk_visible_in_every_event():
    """Every word in the chunk should appear in every per-word event."""
    text = "alpha beta gamma."
    events = plan_word_events(text, audio_duration=3.0)
    for e in events:
        assert "alpha" in e["text"]
        assert "beta" in e["text"]
        assert "gamma" in e["text"]


def test_empty_input_returns_empty():
    assert plan_word_events("", audio_duration=5.0) == []

"""Tests for editor.caption_chunks: punctuation-aware chunking + timing."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.editor import caption_chunks, _chunk_durations


def test_short_sentence_one_chunk():
    chunks = caption_chunks("Hello there.")
    assert chunks == ["Hello there."]


def test_breaks_on_sentence_boundary():
    text = "I hear it again. The knock comes at exactly 3 AM. Always."
    chunks = caption_chunks(text, max_words=5)
    # Sentence boundaries preserved as chunk boundaries.
    assert any(c.endswith(".") for c in chunks)
    assert all(len(c.split()) <= 5 for c in chunks)


def test_long_clause_split_into_max_words():
    text = "this is a really long clause with many many words and no punctuation at all here"
    chunks = caption_chunks(text, max_words=4)
    assert all(len(c.split()) <= 4 for c in chunks)
    # All words preserved.
    assert " ".join(chunks).split() == text.split()


def test_durations_sum_to_total_and_weight_by_length():
    chunks = ["Short.", "A much longer chunk here"]
    durs = _chunk_durations(chunks, total_duration=10.0)
    assert abs(sum(durs) - 10.0) < 1e-6
    # Longer chunk gets more time.
    assert durs[1] > durs[0]


def test_empty_input_returns_empty():
    assert caption_chunks("") == []
    assert caption_chunks("   ") == []

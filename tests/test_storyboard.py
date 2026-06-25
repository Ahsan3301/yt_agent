"""Tests for storyboard.assign_timing."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.storyboard import assign_timing


def test_assign_timing_sums_to_total():
    shots = [
        {"narration_excerpt": "Short."},
        {"narration_excerpt": "A much longer second sentence with more characters."},
        {"narration_excerpt": "Mid length closing line here."},
    ]
    assign_timing(shots, total_duration=30.0)
    assert abs(shots[-1]["end"] - 30.0) < 1e-6
    assert shots[0]["start"] == 0.0


def test_assign_timing_is_proportional_to_chars():
    shots = [
        {"narration_excerpt": "a"},                            # 1 char
        {"narration_excerpt": "b" * 10},                       # 10 chars
    ]
    assign_timing(shots, total_duration=11.0)
    d0 = shots[0]["end"] - shots[0]["start"]
    d1 = shots[1]["end"] - shots[1]["start"]
    # Char-weighted: shot 1 should get ~10x shot 0.
    assert d1 / d0 > 8.0


def test_assign_timing_is_contiguous():
    shots = [{"narration_excerpt": "one"}, {"narration_excerpt": "two"}, {"narration_excerpt": "three"}]
    assign_timing(shots, total_duration=12.0)
    for a, b in zip(shots, shots[1:]):
        assert abs(a["end"] - b["start"]) < 1e-9, "shots should be contiguous"


def test_empty_shots():
    assert assign_timing([], total_duration=10.0) == []

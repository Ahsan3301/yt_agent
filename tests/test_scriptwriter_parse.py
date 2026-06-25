"""Tests for scriptwriter response parsing + validation."""
import json
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.scriptwriter import _strip_fences, _validate


def _good_script():
    return {
        "narration": " ".join(["word"] * 160),
        "youtube_title": "What lives in the basement",
        "description": "desc",
        "tags": ["a", "b"],
    }


def test_strip_fences_removes_json_block():
    raw = "```json\n{\"a\": 1}\n```"
    assert _strip_fences(raw) == '{"a": 1}'


def test_strip_fences_handles_plain_backticks():
    raw = "```\n{\"a\": 1}\n```"
    assert _strip_fences(raw) == '{"a": 1}'


def test_strip_fences_leaves_clean_json_alone():
    raw = '{"a": 1}'
    assert _strip_fences(raw) == raw


def test_validate_accepts_good_script():
    assert _validate(_good_script()) == []


def test_validate_flags_short_narration():
    s = _good_script()
    s["narration"] = "too short"
    problems = _validate(s)
    assert any("too short" in p for p in problems)


def test_validate_flags_missing_fields():
    s = _good_script()
    del s["youtube_title"]
    problems = _validate(s)
    assert any("youtube_title" in p for p in problems)


def test_validate_flags_long_title():
    s = _good_script()
    s["youtube_title"] = "x" * 200
    problems = _validate(s)
    assert any("too long" in p for p in problems)

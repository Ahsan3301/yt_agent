"""Tests for editor._plan_segments — each source used EXACTLY once."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest.mock import patch

from modules import editor


def _vid(name, dur):
    return {"type": "video", "path": name, "_dur": dur}


def _img(name):
    return {"type": "image", "path": name}


def _plan(sources, target):
    """Patch get_video_duration to read _dur from the source dict."""
    def fake(p):
        for s in sources:
            if s["path"] == p:
                return s.get("_dur", 0.0)
        return 0.0
    with patch.object(editor, "get_video_duration", side_effect=fake):
        return editor._plan_segments(sources, target)


def test_each_source_used_exactly_once():
    sources = [_vid("a.mp4", 10), _vid("b.mp4", 10), _vid("c.mp4", 10), _vid("d.mp4", 10)]
    segs = _plan(sources, target=20.0)
    used = [s[0]["path"] for s in segs]
    assert sorted(used) == ["a.mp4", "b.mp4", "c.mp4", "d.mp4"]
    assert len(used) == len(set(used))


def test_mixes_video_and_image_sources():
    sources = [_vid("v1.mp4", 10), _img("i1.jpg"), _vid("v2.mp4", 10), _img("i2.jpg")]
    segs = _plan(sources, target=18.0)
    types = [s[0]["type"] for s in segs]
    assert types.count("video") == 2
    assert types.count("image") == 2


def test_image_segments_have_zero_start_offset():
    sources = [_img("i1.jpg"), _img("i2.jpg")]
    segs = _plan(sources, target=8.0)
    for src, start, dur in segs:
        assert start == 0.0
        assert dur >= editor.MIN_SEGMENT


def test_unusable_videos_are_dropped():
    sources = [_vid("ok.mp4", 10), _vid("tiny.mp4", 0.2), _vid("ok2.mp4", 10)]
    segs = _plan(sources, target=10.0)
    used = [s[0]["path"] for s in segs]
    assert "tiny.mp4" not in used


def test_empty_pool_returns_empty():
    assert _plan([], target=10.0) == []


def test_segment_durations_clamped():
    # 10 sources, target 5s → would be 0.5s each, but MIN_SEGMENT clamps up.
    sources = [_vid(f"v{i}.mp4", 10) for i in range(10)]
    segs = _plan(sources, target=5.0)
    for src, start, dur in segs:
        assert dur >= editor.MIN_SEGMENT

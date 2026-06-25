"""
thumbnail.py — Generate a 1280x720 YouTube thumbnail.

Pulls a keyframe from the final (or first) video clip via ffmpeg, then overlays
a bold 3-5 word headline derived from the YouTube title. Designed to look
decent without manual asset work — single dark gradient, bold sans, drop shadow.
"""
import os
import logging
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

log = logging.getLogger(__name__)

THUMB_W, THUMB_H = 1280, 720

# Words that add no value to a thumbnail headline.
_STOPWORDS = {
    "the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or",
    "but", "with", "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "my", "your", "our",
}


def _extract_frame(video_path, dest_path, timestamp="00:00:02"):
    """Grab a single frame from `video_path` at `timestamp`."""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", timestamp, "-i", video_path, "-frames:v", "1",
        "-q:v", "2", dest_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(dest_path):
        log.warning(f"frame extraction failed: {result.stderr[-200:]}")
        return None
    return dest_path


def _shorten_title(title, max_words=5):
    """Trim a YouTube title into a punchy 3-5 word headline."""
    words = [w.strip(" \"'.,;:!?") for w in title.split()]
    keep = [w for w in words if w and (len(words) <= max_words or w.lower() not in _STOPWORDS)]
    if not keep:
        keep = words[:max_words]
    return " ".join(keep[:max_words]).upper()


def _find_font(size):
    """Try several common bold sans fonts; fall back to Pillow's default."""
    candidates = [
        "C:/Windows/Fonts/impact.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def generate_thumbnail(video_path, youtube_title, output_path):
    """
    Render a thumbnail PNG. Returns path on success, None on failure.
    Safe to call without ffmpeg/Pillow problems crashing the pipeline —
    failure just means no thumbnail is uploaded.
    """
    try:
        work_dir = os.path.dirname(output_path) or "."
        Path(work_dir).mkdir(parents=True, exist_ok=True)
        frame_path = os.path.join(work_dir, "_thumb_frame.jpg")

        bg = None
        if video_path and os.path.exists(video_path):
            if _extract_frame(video_path, frame_path):
                bg = Image.open(frame_path).convert("RGB").resize((THUMB_W, THUMB_H))
        if bg is None:
            bg = Image.new("RGB", (THUMB_W, THUMB_H), (10, 10, 20))

        # Dark gradient overlay for legibility.
        overlay = Image.new("RGBA", (THUMB_W, THUMB_H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        for y in range(THUMB_H):
            alpha = int(180 * (y / THUMB_H))  # darker at bottom
            draw.line([(0, y), (THUMB_W, y)], fill=(0, 0, 0, alpha))
        composed = Image.alpha_composite(bg.convert("RGBA"), overlay)

        # Headline
        headline = _shorten_title(youtube_title or "")
        if headline:
            font = _find_font(140)
            d = ImageDraw.Draw(composed)
            # Measure to center
            try:
                bbox = d.textbbox((0, 0), headline, font=font, stroke_width=6)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            except AttributeError:
                tw, th = d.textsize(headline, font=font)
            x = (THUMB_W - tw) // 2
            y = int(THUMB_H * 0.55)

            # Shadow
            shadow = Image.new("RGBA", composed.size, (0, 0, 0, 0))
            sd = ImageDraw.Draw(shadow)
            sd.text((x + 6, y + 6), headline, font=font, fill=(0, 0, 0, 200))
            shadow = shadow.filter(ImageFilter.GaussianBlur(4))
            composed = Image.alpha_composite(composed, shadow)

            d = ImageDraw.Draw(composed)
            d.text(
                (x, y), headline, font=font,
                fill=(255, 240, 80),               # YouTube-yellow
                stroke_width=6, stroke_fill=(0, 0, 0),
            )

        composed.convert("RGB").save(output_path, "JPEG", quality=88)
        log.info(f"Thumbnail: {output_path}")
        return output_path

    except Exception as e:
        log.warning(f"Thumbnail generation failed: {e}")
        return None

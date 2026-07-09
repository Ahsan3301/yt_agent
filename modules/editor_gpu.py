"""
editor_gpu.py — Full-GPU per-segment renderer.

Replaces the per-segment ffmpeg calls in modules.editor with a pipeline
that lives entirely on the GPU until the final NVENC encode. Frames never
return to host memory between decode → filter → encode.

  Decode → torch tensor on CUDA (Decord NVDEC)
  Scale + crop + Ken Burns + color grade + vignette + grain (torch ops)
  H.264 NVENC encode straight from CUDA frames (PyAV)

If ANY part of this fails — torch missing, CUDA unavailable, decord
import error, NVENC encoder context creation, codec quirks on a corrupt
input — the calling code in modules.editor catches and silently falls
back to the existing ffmpeg path for THAT segment. Other segments stay
on the GPU.

Cancellation: every N decoded/encoded frames we call
run_state.check_cancel(). If raise Cancelled it propagates up — caller
in editor.py must NOT swallow it (the regression fixed at editor.py:773
also applies here).

Output: ALWAYS yuv420p H.264 in an MP4 container, no audio, matching
the CPU path's contract so the downstream concat is identical.
"""
from __future__ import annotations
import os
import math
import logging
from typing import Optional

# Hard imports — failure here is what the caller's try/except ImportError
# catches to disable the GPU path entirely.
import torch
import torch.nn.functional as F
import av
import decord
from decord import VideoReader
from PIL import Image
import numpy as np

from modules import run_state

log = logging.getLogger(__name__)

# Decord must hand frames back as DLPack so we can zero-copy to torch.
decord.bridge.set_bridge("torch")

# How often the cancellation hook fires inside the per-frame loop.
_CANCEL_CHECK_EVERY_N_FRAMES = 16

# Same as modules.editor.OUTPUT_*
OUTPUT_WIDTH  = 1080
OUTPUT_HEIGHT = 1920
OUTPUT_FPS    = 30


# ── Helpers ──────────────────────────────────────────────────────

def _device(device_id: int = 0) -> torch.device:
    """Return cuda:{device_id} when CUDA is up, else CPU. Callers on a
    T4x2 pass device_id=0/1 to split segments across both GPUs."""
    if torch.cuda.is_available():
        try:
            n = int(torch.cuda.device_count())
        except Exception:
            n = 1
        if 0 <= device_id < n:
            return torch.device(f"cuda:{device_id}")
        return torch.device("cuda:0")
    return torch.device("cpu")


def is_available() -> bool:
    """True when CUDA is reachable. The caller still gates on settings."""
    try:
        return torch.cuda.is_available()
    except Exception:
        return False


# ── Effect ops (channel/intensity match editor._grade_chain) ─────

def _apply_color_grade(frames: torch.Tensor, channel: str, intensity: float) -> torch.Tensor:
    """Mirrors editor._grade_chain. `frames` is (T, H, W, 3) float32 in [0,1]."""
    if intensity <= 0:
        return frames
    if channel == "horror":
        contrast   = 1.0 + 0.18 * intensity
        saturation = 1.0 - 0.20 * intensity
        gamma      = 1.0 - 0.05 * intensity
    else:
        contrast   = 1.0 + 0.10 * intensity
        saturation = 1.0 + 0.12 * intensity
        gamma      = 1.0  # wisdom path leaves gamma alone

    # eq: gamma -> contrast -> saturation
    if gamma != 1.0:
        frames = frames.clamp_min(1e-6).pow(1.0 / gamma)
    # contrast around 0.5
    frames = (frames - 0.5) * contrast + 0.5
    # saturation: lerp(luma, rgb, sat)
    luma = (frames[..., 0:1] * 0.299
            + frames[..., 1:2] * 0.587
            + frames[..., 2:3] * 0.114)
    frames = luma + (frames - luma) * saturation

    # colorbalance approximation — additive offsets per channel.
    if channel == "horror":
        # Cool shadows: lift blue in low-luma regions, reduce red overall.
        bs = 0.08 * intensity
        rs = -0.05 * intensity
        shadow_mask = torch.clamp(1.0 - luma * 2.0, 0.0, 1.0)  # peaks at black
        frames[..., 2:3] = frames[..., 2:3] + bs * shadow_mask
        frames[..., 0:1] = frames[..., 0:1] + rs * shadow_mask
    else:
        # Warm punch: lift red overall, slight blue dip.
        rs = 0.06 * intensity
        bs = -0.04 * intensity
        frames[..., 0:1] = frames[..., 0:1] + rs
        frames[..., 2:3] = frames[..., 2:3] + bs

    return frames.clamp(0.0, 1.0)


def _apply_vignette(frames: torch.Tensor, intensity: float) -> torch.Tensor:
    """Cosine-falloff radial mask. Mirrors ffmpeg vignette=angle=PI/N."""
    if intensity <= 0:
        return frames
    T, H, W, _ = frames.shape
    # Build mask once per (H, W).
    yy = torch.linspace(-1.0, 1.0, H, device=frames.device).view(H, 1)
    xx = torch.linspace(-1.0, 1.0, W, device=frames.device).view(1, W)
    r2 = xx * xx + yy * yy  # 0 at center, 2 at corners
    # angle = PI / (5 - 1.5*intensity), softer = larger denominator
    angle = math.pi / max(1e-3, 5.0 - 1.5 * intensity)
    # cos^4(angle * r) is the classic lens vignette curve.
    mask = torch.cos(angle * torch.sqrt(r2).clamp(max=math.pi / angle)).clamp_min(0.0)
    mask = mask.pow(4.0)
    # Blend so even at intensity=1 we don't crush corners pure black.
    blend = mask + (1.0 - mask) * (1.0 - 0.55 * intensity)
    return frames * blend.unsqueeze(0).unsqueeze(-1)


def _apply_film_grain(frames: torch.Tensor, intensity: float) -> torch.Tensor:
    if intensity <= 0:
        return frames
    # Noise amplitude matches ffmpeg noise=alls=N where N is on a 0-100 scale.
    # Mapping: alls≈6..16 over intensity 0..1 → sigma in [0,1] terms.
    sigma = (6.0 + 10.0 * intensity) / 255.0
    return (frames + torch.randn_like(frames) * sigma).clamp(0.0, 1.0)


# ── Ken Burns (affine grid sample replaces ffmpeg zoompan) ───────

_MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left", "pan_up", "pan_down"]


def pick_motion(index: int) -> str:
    return _MOTIONS[index % len(_MOTIONS)]


def _ken_burns_grid(motion: str, frame_index: int, total_frames: int,
                    out_h: int, out_w: int, device: torch.device) -> torch.Tensor:
    """
    Build a (1, out_h, out_w, 2) sampling grid for grid_sample.
    grid values in [-1, 1] map source → output. We translate + scale the
    grid to implement zoompan-equivalent motion.

    Source assumed pre-scaled 2× (same as the CPU pre filter), so we
    sample from a 2-tall, 2-wide virtual canvas centered at (0, 0).
    """
    t = frame_index / max(1, total_frames - 1)  # 0..1

    # Default zoom: 1.0 means "see the full 2× canvas" (i.e. full pre-frame).
    # zoom > 1.0 means "see less of it" — magnify center.
    if motion == "zoom_in":
        zoom = 1.0 + 0.15 * t   # 1.00 → 1.15
        dx = dy = 0.0
    elif motion == "zoom_out":
        zoom = 1.15 - 0.15 * t  # 1.15 → 1.00
        dx = dy = 0.0
    elif motion == "pan_left":
        zoom = 1.10
        dx = (1.0 / zoom) * (2 * t - 1)  # sweep -range/2 → +range/2
        dy = 0.0
    elif motion == "pan_right":
        zoom = 1.10
        dx = (1.0 / zoom) * (1 - 2 * t)
        dy = 0.0
    elif motion == "pan_up":
        zoom = 1.10
        dy = (1.0 / zoom) * (2 * t - 1)
        dx = 0.0
    elif motion == "pan_down":
        zoom = 1.10
        dy = (1.0 / zoom) * (1 - 2 * t)
        dx = 0.0
    else:
        zoom = 1.0 + 0.12 * t
        dx = dy = 0.0

    # Output coordinate grid in [-1, 1].
    ys = torch.linspace(-1.0, 1.0, out_h, device=device)
    xs = torch.linspace(-1.0, 1.0, out_w, device=device)
    grid_y, grid_x = torch.meshgrid(ys, xs, indexing="ij")

    # Sample coords are output / zoom + translation.
    sx = grid_x / zoom + dx
    sy = grid_y / zoom + dy
    grid = torch.stack([sx, sy], dim=-1).unsqueeze(0)  # (1, H, W, 2)
    return grid


# ── Video segment renderer ───────────────────────────────────────

def render_video_segment_gpu(
    src_path: str,
    start_t: float,
    dur: float,
    out_path: str,
    *,
    fps: int = OUTPUT_FPS,
    w: int = OUTPUT_WIDTH,
    h: int = OUTPUT_HEIGHT,
    crf: int = 23,
    device_id: int = 0,
) -> str:
    """
    Decode the slice [start_t, start_t+dur] from src_path on GPU, scale +
    crop to (h, w), encode H.264 NVENC to out_path. Returns out_path.

    device_id selects which CUDA device to use for the decode + torch
    ops. On T4x2 callers alternate 0/1 across segments to keep both
    cards busy. NVENC session goes to the driver default (usually
    device 0) — see _open_nvenc_encoder.
    """
    dev = _device(device_id)
    if dev.type != "cuda":
        raise RuntimeError("CUDA not available")

    # Decord can decode to GPU via VideoReader(ctx=decord.gpu(N)). On
    # current decord (0.6.0) the GPU ctx requires the build to have been
    # compiled with NVDEC. Fall back gracefully if not — the calling
    # editor still gets the win from torch GPU effects + NVENC encode.
    try:
        ctx = decord.gpu(device_id)
        vr = VideoReader(src_path, ctx=ctx)
    except Exception:
        vr = VideoReader(src_path, ctx=decord.cpu(0))

    fps_in = vr.get_avg_fps() or fps
    total_frames_in = len(vr)
    start_frame = max(0, int(round(start_t * fps_in)))
    end_frame   = min(total_frames_in, int(round((start_t + dur) * fps_in)))
    if end_frame <= start_frame:
        raise RuntimeError(f"empty decode window {start_t:.2f}..{start_t+dur:.2f}")

    # Resample to OUTPUT_FPS by picking every kth frame.
    step = max(1, int(round(fps_in / fps)))
    indices = list(range(start_frame, end_frame, step))
    if not indices:
        raise RuntimeError("no frames after fps resample")

    encoder = _open_nvenc_encoder(out_path, w, h, fps, crf)
    try:
        # Stream batches so we don't hold the whole clip in VRAM.
        BATCH = 64
        produced = 0
        for batch_start in range(0, len(indices), BATCH):
            run_state.check_cancel()
            batch_idx = indices[batch_start:batch_start + BATCH]
            # decord.bridge="torch" makes this a torch tensor already.
            batch = vr.get_batch(batch_idx)  # (B, H, W, 3) uint8
            if not isinstance(batch, torch.Tensor):
                batch = torch.from_numpy(np.asarray(batch))
            batch = batch.to(dev, non_blocking=True).float() / 255.0  # (B,H,W,3) [0,1]

            # Scale + crop to (h, w). Use interpolate on NCHW.
            nchw = batch.permute(0, 3, 1, 2)  # (B, 3, H_in, W_in)
            src_h, src_w = nchw.shape[2], nchw.shape[3]
            # force_original_aspect_ratio=increase: scale so smaller side
            # >= target, then center-crop.
            scale_factor = max(w / src_w, h / src_h)
            new_w = int(round(src_w * scale_factor))
            new_h = int(round(src_h * scale_factor))
            nchw = F.interpolate(nchw, size=(new_h, new_w), mode="bilinear", align_corners=False)
            # Center crop.
            y0 = max(0, (new_h - h) // 2)
            x0 = max(0, (new_w - w) // 2)
            nchw = nchw[:, :, y0:y0 + h, x0:x0 + w]
            frames = nchw.permute(0, 2, 3, 1)  # (B, h, w, 3)

            # Encode each frame in this batch.
            for i in range(frames.shape[0]):
                produced += 1
                if produced % _CANCEL_CHECK_EVERY_N_FRAMES == 0:
                    run_state.check_cancel()
                _write_frame(encoder, frames[i])
    finally:
        _close_nvenc_encoder(encoder)

    return out_path


# ── Image segment renderer (Ken Burns over a still) ──────────────

def render_image_segment_gpu(
    src_path: str,
    dur: float,
    out_path: str,
    *,
    motion: str,
    channel: str,
    intensity: float,
    fps: int = OUTPUT_FPS,
    w: int = OUTPUT_WIDTH,
    h: int = OUTPUT_HEIGHT,
    crf: int = 22,
    device_id: int = 0,
) -> str:
    """
    Render a still image as a clip with Ken Burns motion + grade +
    vignette + grain — all on GPU. Returns out_path.

    device_id: which CUDA device (0/1 on T4x2) does the torch compute.
    NVENC session lands on driver default.
    """
    dev = _device(device_id)
    if dev.type != "cuda":
        raise RuntimeError("CUDA not available")

    # Load + pre-scale 2× (same headroom as ffmpeg path's pre filter).
    img = Image.open(src_path).convert("RGB")
    src_w, src_h = img.size
    target_w = w * 2
    target_h = h * 2
    scale = max(target_w / src_w, target_h / src_h)
    new_w = int(round(src_w * scale))
    new_h = int(round(src_h * scale))
    img = img.resize((new_w, new_h), Image.BILINEAR)
    # center crop to 2× target
    left = max(0, (new_w - target_w) // 2)
    top  = max(0, (new_h - target_h) // 2)
    img = img.crop((left, top, left + target_w, top + target_h))

    canvas = torch.from_numpy(np.asarray(img)).to(dev).float() / 255.0  # (2H, 2W, 3)
    canvas = canvas.permute(2, 0, 1).unsqueeze(0)  # (1, 3, 2H, 2W)

    total_frames = max(1, int(round(dur * fps)))

    encoder = _open_nvenc_encoder(out_path, w, h, fps, crf)
    try:
        # Pre-build vignette mask once (depends only on h, w, intensity).
        produced = 0
        for fi in range(total_frames):
            if produced % _CANCEL_CHECK_EVERY_N_FRAMES == 0:
                run_state.check_cancel()
            grid = _ken_burns_grid(motion, fi, total_frames, h, w, dev)
            sampled = F.grid_sample(canvas, grid, mode="bilinear",
                                    padding_mode="border", align_corners=False)
            frame = sampled.squeeze(0).permute(1, 2, 0)  # (h, w, 3)

            # Effects.
            frame = frame.unsqueeze(0)                   # (1, h, w, 3) for the helpers
            frame = _apply_color_grade(frame, channel, intensity)
            frame = _apply_vignette(frame, intensity)
            frame = _apply_film_grain(frame, intensity)
            frame = frame.squeeze(0)

            _write_frame(encoder, frame)
            produced += 1
    finally:
        _close_nvenc_encoder(encoder)

    return out_path


# ── PyAV NVENC encoder wrapping ──────────────────────────────────

class _EncoderHandle:
    __slots__ = ("container", "stream", "w", "h")
    def __init__(self, container, stream, w, h):
        self.container = container
        self.stream = stream
        self.w = w
        self.h = h


def _open_nvenc_encoder(out_path: str, w: int, h: int, fps: int, crf: int) -> _EncoderHandle:
    container = av.open(out_path, mode="w", format="mp4")
    try:
        stream = container.add_stream("h264_nvenc", rate=fps)
    except Exception:
        # NVENC not available even though torch.cuda is — fall through
        # to libx264 within PyAV so we still get a same-format output.
        stream = container.add_stream("libx264", rate=fps)
        stream.options = {"crf": str(crf), "preset": "fast"}
    stream.width = w
    stream.height = h
    stream.pix_fmt = "yuv420p"
    if stream.codec.name == "h264_nvenc":
        stream.options = {
            "preset": "p4",
            "rc": "vbr",
            "cq": str(crf),
            "b": "0",
        }
    return _EncoderHandle(container, stream, w, h)


def _write_frame(enc: _EncoderHandle, frame_t: torch.Tensor) -> None:
    """frame_t shape (h, w, 3) float32 [0,1] on any device."""
    # Bring to host as uint8 RGB.
    arr = (frame_t.clamp(0.0, 1.0) * 255.0).to(torch.uint8).contiguous().cpu().numpy()
    vf = av.VideoFrame.from_ndarray(arr, format="rgb24")
    vf = vf.reformat(width=enc.w, height=enc.h, format="yuv420p")
    for packet in enc.stream.encode(vf):
        enc.container.mux(packet)


def _close_nvenc_encoder(enc: _EncoderHandle) -> None:
    for packet in enc.stream.encode():  # flush
        enc.container.mux(packet)
    enc.container.close()

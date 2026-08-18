"""Agnes AI - image and video generation.

Self-contained: cooldown state, the video rate gate, both generate
bodies and their readiness rules.

Image and video live in ONE file because they share state. Both read the
same AGNES_API_KEY and both respect the same _AGNES_COOLDOWN_UNTIL set
on a 401/402/429 - an auth or quota failure on either endpoint should
stop us hammering the other. Splitting them into two files would put
that shared cooldown somewhere neither owns, which is the arrangement
this refactor exists to remove.

The video endpoint additionally rate-limits at 2 requests/minute
(measured against the live API), so it has its own gate on top of the
shared cooldown.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading as _threading
import time

import requests
import requests as _rq   # both names: the moved bodies use each

from modules.providers.base import Provider, register
from modules.providers.prompt import _distill_prompt_for_flux

log = logging.getLogger(__name__)


def _archive_clips_enabled() -> bool:
    """Archive-footage toggle, still owned by shotfinder.

    Read through a lazy import because shotfinder imports this package.
    This is the last shotfinder dependency Agnes has; it goes when the
    archive helpers find their own home.
    """
    try:
        from modules.shotfinder import _archive_clips_enabled as _f
        return _f()
    except Exception:
        return False


# ── Agnes AI image provider (agnes-ai.com) ────────────────────────
# Free OpenAI-compatible multimodal API (Sapiens AI, Singapore).
# Per-channel: the render's AGNES_API_KEY is set by backend.channel_agnes
# from the channel's own key (agnes_source='own'). Empty key → provider
# skipped by _provider_ready. Generous free image quota (thousands/day),
# so it's a strong CF-pool-exhaustion fallback — but quality is
# inconsistent per reviews, so slot it BELOW the flux providers.
_AGNES_BASE = os.getenv("AGNES_API_BASE", "https://apihub.agnes-ai.com/v1")
_AGNES_IMAGE_MODEL = os.getenv("AGNES_IMAGE_MODEL", "agnes-image-2.1-flash")
_AGNES_COOLDOWN_UNTIL = 0.0   # set on 401/402/429 so we stop hammering


def _agnes_key() -> str:
    return (os.getenv("AGNES_API_KEY", "") or "").strip()


# ── Agnes AI VIDEO provider ───────────────────────────────────────
# Generates an actual moving clip per shot instead of a still image
# with a Ken Burns pan. Native output is 720x1280 — already the Shorts
# aspect ratio, so nothing is cropped or letterboxed.
#
# This is a DIFFERENT endpoint from the chat/image ones and is
# asynchronous: POST /v1/videos returns a task id, then you poll
# GET /v1/videos/<id> until status=completed and read metadata.url.
# Calling the video model through /chat/completions returns
# 403 "Model is blocked", which reads like an account restriction but
# only means the model is not served on that endpoint.
#
# Cost control: ~90 s per 5 s clip, so generating every shot this way
# would add 15-30 min to a render. AGNES_VIDEO_SHOTS caps how many
# shots get a real clip; the rest fall through to the image chain. The
# cap applies to the FIRST shots because Shorts retention is decided in
# the opening seconds — that is where motion earns the most.
_AGNES_VIDEO_MODEL = os.getenv("AGNES_VIDEO_MODEL", "agnes-video-v2.0")
_AGNES_VIDEO_POLL_SECONDS = int(os.getenv("AGNES_VIDEO_POLL_SECONDS", "180"))


# NOTE: _archive_clips_enabled travelled with this block but STAYS in
# shotfinder, because _archive_clip_for_shot (which is not Agnes and is
# not moving) calls it. The extracted copy is removed here and the lazy
# shim above is used instead — two definitions would have diverged the
# moment someone changed the default.


# The live endpoint enforces "2 requests per 1 minute" on video
# creation (measured: HTTP 429 rate_limit_exceeded). Pace ourselves to
# that rather than firing six shots and letting most of them bounce —
# a bounced create used to cost the shot its motion entirely.
_AGNES_VIDEO_RPM = int(os.getenv("AGNES_VIDEO_RPM", "2") or 2)
_AGNES_VIDEO_MAX_TRIES = int(os.getenv("AGNES_VIDEO_MAX_TRIES", "4") or 4)
_agnes_video_calls: list = []
_agnes_video_lock = _threading.Lock()


def _agnes_video_gate() -> None:
    """Block until another video create is allowed under the RPM cap.

    Shots are generated concurrently, so this has to be shared state
    behind a lock rather than a per-call sleep.
    """
    if _AGNES_VIDEO_RPM <= 0:
        return
    while True:
        with _agnes_video_lock:
            now = time.time()
            # Drop calls older than the window.
            while _agnes_video_calls and now - _agnes_video_calls[0] > 60.0:
                _agnes_video_calls.pop(0)
            if len(_agnes_video_calls) < _AGNES_VIDEO_RPM:
                _agnes_video_calls.append(now)
                return
            wait = 60.0 - (now - _agnes_video_calls[0]) + 0.5
        time.sleep(max(1.0, min(wait, 60.0)))


def _agnes_video_shots() -> int:
    """How many opening shots get a generated clip. 0 disables it.

    Read per call rather than cached at import so the dashboard setting
    takes effect on the next render without restarting a worker.
    Default 2: enough for the hook to move, cheap enough that it adds
    roughly three minutes rather than half an hour.
    """
    try:
        return max(0, min(10, int(os.getenv("AGNES_VIDEO_SHOTS", "2"))))
    except Exception:
        return 2

def _agnes_video_generate(prompt: str, output_dir: str, idx: int, seconds: float = 5.0,
                          init_image_url: str = ""):
    """Generate one clip. Returns a shot-source dict or None.

    Never raises: a video miss must fall through to the image chain
    rather than fail the shot, since a missing shot kills the render.
    """
    import requests as _rq
    key = _agnes_key()
    if not key:
        return None
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        # Parameters per the Agnes Video V2.0 reference:
        #   wiki.agnes-ai.com/en/docs/agnes-video-v20.md
        #
        # width/height are what select the aspect ratio — there is no
        # aspect_ratio/size/ratio parameter, and passing one is accepted
        # with HTTP 200 and silently ignored. Omitting width/height
        # entirely gives the 1152x768 LANDSCAPE default, which is wrong
        # for Shorts. The service normalises whatever it is given to the
        # nearest preset tier (720x1280 comes back as 704x1280).
        #
        # Duration is num_frames / frame_rate, and num_frames MUST
        # satisfy 8n+1 (max 441). 24fps rather than 16: the docs' own
        # duration table is built on 24, and 16fps reads as judder on a
        # slow push-in, which is most of what we ask for.
        _secs = max(2.0, min(float(seconds or 5.0), 10.0))
        # Snap UP to the next legal 8n+1, never down: a clip shorter than
        # its shot leaves a gap the editor has to fill by freezing or
        # stretching. Rounding up reproduces the reference table exactly
        # (5s -> 121 frames, 10s -> 241).
        _frames = int(round(_secs * 24))
        _frames = max(9, min(441, ((_frames - 1 + 7) // 8) * 8 + 1))
        # Direction, not just description.
        #
        # The prompt handed in here is the DIFFUSION prompt — it
        # describes a scene, not a shot. A video model given no camera
        # or action instruction produces a near-static frame with drifting
        # detail, which reads as "artifacting" and "movement not on
        # point" because nothing is deliberately moving.
        #
        # One camera move plus one physical action gives the model
        # something coherent to animate, so its motion budget goes into
        # intended movement instead of hallucinated wobble.
        _moves = ("slow dolly-in", "slow push-in", "gentle handheld drift",
                  "slow tilt up", "steady tracking shot")
        _directed = (
            f"{prompt[:900]}. "
            f"Cinematography: {_moves[idx % len(_moves)]}, "
            f"single continuous take, stable framing, natural motion, "
            f"consistent lighting throughout the shot."
        )
        body = {
            "model": _AGNES_VIDEO_MODEL,
            "prompt": _directed[:1200],
            # 1080x1920, not 720x1280. The model normalises to 480p/720p/
            # 1080p tiers (wiki.agnes-ai.com/en/docs/agnes-video-v20.md),
            # so asking for 720p meant every clip was then scaled UP 1.5x
            # to the 1080x1920 output — softening detail and smearing
            # exactly the fine texture that reads as "artifacting". The
            # 1080p tier is available; generate at output resolution and
            # the upscale disappears.
            "width": int(os.getenv("AGNES_VIDEO_W", "1080")),
            "height": int(os.getenv("AGNES_VIDEO_H", "1920")),
            "num_frames": _frames, "frame_rate": 24,
            # Documented and never sent. This is the standard lever for
            # artifact reduction — more denoising steps mean fewer of
            # the warped hands, smeared faces and boiling textures that
            # show up on a default-step generation.
            "num_inference_steps": int(os.getenv("AGNES_VIDEO_STEPS", "40")),
            "negative_prompt": (
                "blurry, low quality, distorted, deformed, warped face, "
                "extra limbs, extra fingers, melting features, flickering, "
                "morphing, jitter, ghosting, duplicated subject, "
                "watermark, text, subtitles, letterboxing, static, still image"
            ),
        }
        # Image-to-video when we already have a still for this shot.
        # Animating our own 9:16 frame beats text-to-video on both
        # fidelity and consistency: the composition is already the one
        # the shot called for, so the model interpolates motion instead
        # of reinventing the scene.
        if init_image_url:
            # Accepts a public URL or a base64 data URI — both verified
            # against the live endpoint before relying on it, so a local
            # portrait needs no upload anywhere.
            body["image"] = init_image_url
            log.info(f"agnes-video: shot {idx} driven by a character reference")
        # Retry the two errors the live endpoint actually returns under
        # load. Measured against it directly:
        #
        #   429 {"code":"rate_limit_exceeded"} — "allows 2 requests per
        #       1 minute(s)". Six shots means we WILL hit this.
        #   503 {"code":"video_queue_full"}    — their queue is busy.
        #
        # Both are transient and explicitly retryable, and the previous
        # code treated every >=400 as fatal and returned None. The caller
        # reads None as "no motion available" and quietly substitutes a
        # still, so a momentary rate limit permanently downgraded that
        # shot. That is the likeliest reason motion looked inconsistent
        # across a video and across niches — nothing errored, shots just
        # went missing.
        _RETRYABLE = (408, 409, 425, 429, 500, 502, 503, 504)
        r = None
        for _attempt in range(_AGNES_VIDEO_MAX_TRIES):
            _agnes_video_gate()          # client-side 2/min limiter
            r = _rq.post(f"{_AGNES_BASE}/videos", headers=headers, timeout=60, json=body)
            if r.status_code < 400:
                break
            if r.status_code not in _RETRYABLE or _attempt == _AGNES_VIDEO_MAX_TRIES - 1:
                log.warning(f"agnes-video: create failed HTTP {r.status_code}: {r.text[:160]}")
                return None
            # Honour Retry-After when present, else back off. The window
            # is a minute, so waiting out a rate limit is cheap next to
            # losing the shot.
            try:
                _wait = float(r.headers.get("Retry-After") or 0)
            except Exception:
                _wait = 0
            _wait = _wait or min(90.0, 20.0 * (_attempt + 1))
            log.info(f"agnes-video: shot {idx} got HTTP {r.status_code} "
                     f"({(r.text or '')[:60]}) — retrying in {_wait:.0f}s "
                     f"[{_attempt + 1}/{_AGNES_VIDEO_MAX_TRIES}]")
            time.sleep(_wait)
        task_id = (r.json() or {}).get("task_id") or (r.json() or {}).get("id")
        if not task_id:
            log.warning("agnes-video: no task id in create response")
            return None
    except Exception as e:
        log.warning(f"agnes-video: create error: {e}")
        return None

    deadline = time.time() + _AGNES_VIDEO_POLL_SECONDS
    url = ""
    while time.time() < deadline:
        time.sleep(10)
        try:
            p = _rq.get(f"{_AGNES_BASE}/videos/{task_id}", headers=headers, timeout=30)
            d = p.json() if p.status_code < 400 else {}
        except Exception:
            continue
        status = str(d.get("status") or "")
        if status in ("completed", "succeeded", "success", "finished"):
            url = str((d.get("metadata") or {}).get("url") or "")
            break
        if status in ("failed", "error"):
            log.warning(f"agnes-video: task {task_id} reported {status}")
            return None
    if not url:
        log.warning(f"agnes-video: task {task_id} did not finish within "
                    f"{_AGNES_VIDEO_POLL_SECONDS}s — falling back to a still")
        return None

    dest = os.path.join(output_dir, f"agnes_video_{idx:02d}.mp4")
    try:
        with _rq.get(url, stream=True, timeout=120) as vr:
            vr.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in vr.iter_content(1 << 16):
                    if chunk:
                        f.write(chunk)
    except Exception as e:
        log.warning(f"agnes-video: download failed: {e}")
        return None

    # An HTML error page saved as .mp4 would sail through the editor and
    # produce a broken segment, so verify the container before trusting it.
    try:
        with open(dest, "rb") as f:
            if f.read(12)[4:8] != b"ftyp":
                log.warning("agnes-video: downloaded file is not an mp4")
                os.remove(dest)
                return None
    except Exception:
        return None

    log.info(f"agnes-video: shot {idx} -> {os.path.getsize(dest)//1024} KB clip")
    return {"type": "video", "path": dest, "origin": "agnes-video", "score": 8}

def _agnes_generate(prompt, output_dir, trial, negative_prompt="", ref_image_path=""):
    """Generate one image via Agnes AI. Returns (path, seed) on success,
    (None, seed) on any failure. OpenAI-images-style endpoint:
      POST {base}/v1/images/generations
      body: {model, prompt, size, extra_body:{response_format:"url"}}
      resp: {data:[{url}]}  → we download the PNG and re-save as JPG.
    """
    global _AGNES_COOLDOWN_UNTIL
    seed = int(hashlib.md5(f"{prompt}|{trial}|agnes".encode()).hexdigest()[:8], 16)
    key = _agnes_key()
    if not key:
        return None, seed
    if time.time() < _AGNES_COOLDOWN_UNTIL:
        return None, seed

    # Agnes runs a Gemini-Flash-class image model — natural-language
    # prompts work best (same as Flux). Reuse the flux distiller.
    final_prompt = _distill_prompt_for_flux(prompt)[:700]
    body = {
        "model": _AGNES_IMAGE_MODEL,
        "prompt": final_prompt,
        # `size` is a quality tier (1K/2K/3K/4K) and `ratio` picks the
        # aspect — per the model reference. We previously sent an exact
        # "576x1024", which the service accepted as a legacy value and
        # normalised anyway; asking for 2K/9:16 gets a bigger source
        # frame, so the editor's crop to 1080x1920 upscales less.
        "size": os.getenv("AGNES_IMAGE_SIZE", "2K"),
        "ratio": "9:16",
        "extra_body": {"response_format": "url"},
    }
    # Character reference. The cast description alone keeps a face
    # roughly on-model for a video clip but visibly drifts between
    # separate stills, because two different prompts produce two
    # different people no matter how the person is described.
    #
    # image-to-image fixes that properly: the FIRST shot featuring a
    # character becomes the anchor, and every later shot with that
    # character is generated with the anchor attached, so the model
    # matches a face it can see instead of one it has to imagine.
    #
    # Sent as a base64 data URI, which the reference explicitly allows
    # alongside public URLs — that removes the need to upload each
    # still somewhere public first.
    if ref_image_path and os.path.exists(ref_image_path):
        try:
            import base64 as _b64
            with open(ref_image_path, "rb") as _f:
                _enc = _b64.b64encode(_f.read()).decode("ascii")
            body["extra_body"]["image"] = [f"data:image/jpeg;base64,{_enc}"]
            # SPECIES-NEUTRAL. This said "keep the PERSON'S face, hair
            # and clothing identical" — which, handed a reference of a
            # four-legged dog, reads as an instruction to make it a
            # person. Observed live on the animation niche: the cast
            # sheet was a terrier standing on all fours in a scarf, and
            # the shots came back with the same dog upright on two legs
            # in a flat cap and a grey overcoat. The reference was
            # attached and working; the sentence describing it was
            # asking for the drift.
            #
            # "Body plan" is doing real work here — it is what stops a
            # quadruped becoming a biped — and the explicit ban on
            # adding garments stops the model dressing a character the
            # reference shows undressed.
            body["prompt"] = (
                f"{final_prompt}. The character must match the reference image "
                f"EXACTLY: same species, same body plan and number of limbs, same "
                f"posture type, same face, same markings and colours, same clothing. "
                f"Do not add any garment or accessory that is not in the reference. "
                f"Change only the scene, the pose and the camera angle."
            )[:900]
            log.info("agnes: generating with a character reference")
        except Exception as _e:
            log.warning(f"agnes: could not attach character reference: {_e}")
    dest = os.path.join(output_dir, f"agnes_{seed:08x}.jpg")
    try:
        r = requests.post(
            f"{_AGNES_BASE}/images/generations",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            json=body, timeout=120,
        )
        if r.status_code in (401, 402, 403, 429):
            # Auth/quota problem — cool down 10 min so we don't burn the
            # per-shot attempt budget re-hitting a dead/exhausted key.
            _AGNES_COOLDOWN_UNTIL = time.time() + 600
            log.warning(f"agnes: HTTP {r.status_code} — cooling provider 10 min")
            return None, seed
        r.raise_for_status()
        data = (r.json() or {}).get("data") or []
        if not data:
            return None, seed
        img_url = str(data[0].get("url") or "").strip()
        if not img_url:
            # Fall back to b64 if the account is configured for it.
            b64 = data[0].get("b64_json")
            if b64:
                import base64 as _b64
                with open(dest, "wb") as f:
                    f.write(_b64.b64decode(b64))
                return (dest, seed) if _agnes_ok(dest) else (None, seed)
            return None, seed
        # Download the URL.
        ir = requests.get(img_url, stream=True, timeout=120)
        ir.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in ir.iter_content(chunk_size=8192):
                f.write(chunk)
        return (dest, seed) if _agnes_ok(dest) else (None, seed)
    except Exception as e:
        log.warning(f"agnes gen failed: {e}")
        return None, seed


def _agnes_ok(path: str) -> bool:
    """Reject truncated/degenerate downloads (same guard SDXL uses)."""
    try:
        if not os.path.exists(path) or os.path.getsize(path) < 4096:
            return False
        from PIL import Image as _Img
        import numpy as _np
        with _Img.open(path) as im:
            im = im.convert("RGB")
            arr = _np.asarray(im).astype(_np.float32)
        if float(arr.std()) < 6 or float(arr.mean()) < 4:
            log.warning("agnes: degenerate image (near-uniform) — treating as failure")
            return False
        # Normalise to JPG so the editor pipeline (which globs *.jpg for
        # some paths) + storage stay consistent with other providers.
        # We're always downloading raw response bytes into a `.jpg`-
        # named file — those bytes may actually be PNG/WebP. Re-open
        # + save as JPEG to make the file's contents match its
        # extension. 2026-07-21: this branch previously had `if not
        # path.lower().endswith(".jpg"): return True` which was
        # inverted (it skipped the re-encode for non-jpg paths, when
        # non-jpg paths are exactly the ones that NEED it). Today
        # dest is always .jpg so the bug was latent; fixing so the
        # intent matches the behaviour.
        if path.lower().endswith(".jpg"):
            with _Img.open(path) as im:
                im.convert("RGB").save(path, "JPEG", quality=92)
        return True
    except Exception:
        # If PIL isn't available or the check errored, accept the file
        # as long as it's non-trivial in size (belt-and-braces).
        try:
            return os.path.exists(path) and os.path.getsize(path) >= 4096
        except Exception:
            return False

# ── Registration ──────────────────────────────────────────────

def _ready_image() -> "tuple[bool, str]":
    if not _agnes_key():
        return False, "no AGNES_API_KEY (channel agnes_source=off, or no key in the pool)"
    wait = int(_AGNES_COOLDOWN_UNTIL - time.time())
    if wait > 0:
        return False, f"cooling after an auth/quota error ({wait}s remaining)"
    return True, ""


def _ready_video() -> "tuple[bool, str]":
    ok, why = _ready_image()
    if not ok:
        return ok, why
    # The 2/min rate limit and the 503 video_queue_full response are
    # handled with pacing and retries in the generate path, not gated
    # here. A busy queue is transient, and refusing the provider for it
    # would silently downgrade the shot to a still - the exact failure
    # the retry logic was added to stop.
    return True, ""


def _gen_image(prompt, output_dir, trial, negative_prompt="", ref_image_path="", **_):
    return _agnes_generate(prompt, output_dir, trial,
                           negative_prompt=negative_prompt,
                           ref_image_path=ref_image_path)


def _gen_video(prompt, output_dir, idx, seconds=5.0, init_image_url="", **_):
    return _agnes_video_generate(prompt, output_dir, idx,
                                 seconds=seconds,
                                 init_image_url=init_image_url)


register(Provider(
    name="agnes",
    kind="image",
    generate=_gen_image,
    ready=_ready_image,
    supports_reference=True,
    blurb="Agnes AI image model. Primary provider - accepts a character "
          "reference image, which is what keeps a face stable across the "
          "shots of one video.",
))

register(Provider(
    name="agnes_video",
    kind="video",
    generate=_gen_video,
    ready=_ready_video,
    supports_reference=True,
    blurb="Agnes AI video model. Generates a real moving clip per shot at "
          "1080x1920 instead of panning a still. Rate-limited to 2 "
          "requests/minute upstream, paced and retried in the generate path.",
))

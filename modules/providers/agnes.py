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
# asynchronous: POST /v1/videos returns a task, then you poll
# GET /agnesapi?video_id=<id>&model_name=<model> (note: NO /v1) until
# status=completed and read the top-level `url`.
# Calling the video model through /chat/completions returns
# 403 "Model is blocked", which reads like an account restriction but
# only means the model is not served on that endpoint.
#
# AGNES VIDEO 2.5 (2026-10-12). v2.0 was discontinued 2026-09-25 and
# every create since returned 503 model_not_found — 99 failures and 0
# clips in the 72h before this was noticed. 2.5 is not a rename; the
# request shape changed almost entirely. Each point below was checked
# against the live endpoint, not just the docs:
#
#   * width / height / num_frames / frame_rate / num_inference_steps
#     are FORBIDDEN fields (HTTP 400 "width is a forbidden field").
#     Shape is now aspect_ratio="9:16" plus a size TIER ("720P"/"1080P").
#   * negative_prompt is also forbidden ("not an allowed request
#     field"), so the negatives cannot be sent at all.
#   * `mode` is required: "keyframe" with first_frame for image-to-video,
#     "text" without. first_frame accepts our base64 data URI (verified:
#     completed in 159s, valid mp4) — no upload step needed.
#   * seconds is a STRING in ["4", "12"]; "3" is rejected. Our beats are
#     2-3.5s, so clips are generated at 4s and the editor trims them.
#   * flash only accepts size "720P" (rejected otherwise) and returns
#     704x1280; full 2.5 offers 1080P.
#   * Video creates are still limited to 2/min, and REJECTED requests
#     count against it — two 400s used up the window and the next two
#     creates bounced with 429.
#
# Cost control: ~90 s per 5 s clip, so generating every shot this way
# would add 15-30 min to a render. AGNES_VIDEO_SHOTS caps how many
# shots get a real clip; the rest fall through to the image chain. The
# cap applies to the FIRST shots because Shorts retention is decided in
# the opening seconds — that is where motion earns the most.
# Flash by default, and for a money reason rather than a quality one.
# Full agnes-video-2.5 is $0.040/s at 1080P — $0.16 per 4s clip — and
# the account held $0.03 on 2026-10-12 ("insufficient_user_quota ...
# required: $0.160000"), so it could not produce a single clip. Flash
# is free for a limited time and was verified working on our key.
#
# The cost of that choice is resolution: flash is 720P only (704x1280),
# so clips are upscaled ~1.5x to the 1080x1920 output — the softening
# that the 1080 move under v2.0 existed to remove. Once the balance is
# topped up, AGNES_VIDEO_MODEL=agnes-video-2.5 restores 1080P without a
# code change; the size follows the model automatically.
_AGNES_VIDEO_MODEL = os.getenv("AGNES_VIDEO_MODEL", "agnes-video-2.5-flash")
# The size tier for non-flash models. Flash ignores this and always
# sends 720P, since anything else is rejected before generation.
_AGNES_VIDEO_SIZE = os.getenv("AGNES_VIDEO_SIZE", "1080P")
# Retrieval lives on the API root, not under /v1 like the create call.
_AGNES_VIDEO_POLL_BASE = os.getenv(
    "AGNES_VIDEO_POLL_BASE",
    os.getenv("AGNES_API_BASE", "https://apihub.agnes-ai.com/v1").rstrip("/").removesuffix("/v1"),
)

# Process-wide off switch for errors that retrying cannot fix.
#
# v2.0's death showed the cost of not having one: model_not_found came
# back as HTTP 503, our retry list treats 503 as transient, so EVERY
# shot spent ~2.5 minutes retrying a model that no longer existed
# before falling back. Same for an empty balance. Once either is seen,
# stop asking for a while — every shot would get the same answer.
# Time-boxed rather than permanent so a top-up or a provider fix is
# picked up without restarting the worker.
_AGNES_VIDEO_OFF_UNTIL = 0.0
_AGNES_VIDEO_OFF_REASON = ""
_AGNES_VIDEO_OFF_SECONDS = int(os.getenv("AGNES_VIDEO_OFF_SECONDS", "1800"))


def _agnes_video_off(reason: str) -> None:
    global _AGNES_VIDEO_OFF_UNTIL, _AGNES_VIDEO_OFF_REASON
    _AGNES_VIDEO_OFF_UNTIL = time.time() + _AGNES_VIDEO_OFF_SECONDS
    _AGNES_VIDEO_OFF_REASON = reason
    log.warning(f"agnes-video: DISABLED for {_AGNES_VIDEO_OFF_SECONDS}s — {reason}. "
                f"Shots fall through to stills/other sources until then.")
# 180 -> 600. Measured: a task exceeded 180s while the provider's
# queue was full (503 video_queue_full on a neighbouring shot), and
# the shot degraded to a still. The task was still processing
# server-side — we gave up, it did not. Waiting is nearly free;
# abandoning a clip costs the shot.
_AGNES_VIDEO_POLL_SECONDS = int(os.getenv("AGNES_VIDEO_POLL_SECONDS", "600"))


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
    import math
    import requests as _rq
    key = _agnes_key()
    if not key:
        return None
    if time.time() < _AGNES_VIDEO_OFF_UNTIL:
        log.info(f"agnes-video: shot {idx} skipped — off ({_AGNES_VIDEO_OFF_REASON})")
        return None
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    model = _AGNES_VIDEO_MODEL
    try:
        # Seconds: a string in ["4", "12"]. Round UP, never down — a
        # clip shorter than its shot leaves a gap the editor has to fill
        # by freezing or stretching, while a longer one is just trimmed.
        _secs = int(math.ceil(float(seconds or 5.0)))
        _secs = max(4, min(12, _secs))
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
        # The quality clause carries what negative_prompt used to, and it
        # is phrased POSITIVELY on purpose. 2.5 forbids negative_prompt,
        # and pasting the old list ("extra limbs, watermark, text ...")
        # into the prompt would ask the model to draw those things: a
        # term named in a prompt tends to be summoned, negated or not —
        # measured on the image side, where naming an object in a
        # "don't" clause put it in frame.
        _directed = (
            f"{prompt[:900]}. "
            f"Cinematography: {_moves[idx % len(_moves)]}, "
            f"single continuous take, stable framing, natural motion, "
            f"consistent lighting throughout the shot. "
            f"Crisp clean detail, steady anatomy, and every character keeps "
            f"the same body, posture and outfit from first frame to last."
        )
        is_flash = "flash" in model.lower()
        body = {
            "model": model,
            "prompt": _directed[:1200],
            "seconds": str(_secs),
            "aspect_ratio": "9:16",
            # Flash rejects anything but 720P before generation, so do not
            # let a 1080P setting meant for full 2.5 break it.
            "size": "720P" if is_flash else _AGNES_VIDEO_SIZE,
            "mode": "text",
        }
        # Image-to-video when we already have a still for this shot.
        # Animating our own 9:16 frame beats text-to-video on both
        # fidelity and consistency: the composition is already the one
        # the shot called for, so the model interpolates motion instead
        # of reinventing the scene. The data URI shotfinder builds is
        # accepted as first_frame directly — verified live.
        if init_image_url:
            body["mode"] = "keyframe"
            body["first_frame"] = init_image_url
            log.info(f"agnes-video: shot {idx} driven by a character reference")
        # Retry only what is genuinely transient.
        #
        #   429 rate_limit — "2 requests per 1 minute". Six shots WILL hit it.
        #   503 video_queue_full — their queue is busy.
        #
        # A momentary rate limit must not cost a shot its motion: the
        # caller reads None as "no motion available" and quietly
        # substitutes a still.
        #
        # But a 503 is NOT always transient. v2.0's discontinuation came
        # back as 503 model_not_found, and an empty balance as 403
        # insufficient_user_quota. Retrying those just burns minutes per
        # shot, so they switch video off for the process instead.
        _RETRYABLE = (408, 409, 425, 429, 500, 502, 503, 504)
        r = None
        for _attempt in range(_AGNES_VIDEO_MAX_TRIES):
            _agnes_video_gate()          # client-side 2/min limiter
            r = _rq.post(f"{_AGNES_BASE}/videos", headers=headers, timeout=60, json=body)
            if r.status_code < 400:
                break
            _txt = r.text or ""
            if "model_not_found" in _txt:
                _agnes_video_off(f"model {model} not available on this key (HTTP {r.status_code})")
                return None
            if "insufficient_user_quota" in _txt or "insufficient_quota" in _txt:
                _agnes_video_off(f"Agnes balance too low for {model} — top up, or use a flash model")
                return None
            if r.status_code not in _RETRYABLE or _attempt == _AGNES_VIDEO_MAX_TRIES - 1:
                log.warning(f"agnes-video: create failed HTTP {r.status_code}: {_txt[:200]}")
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
                     f"({_txt[:60]}) — retrying in {_wait:.0f}s "
                     f"[{_attempt + 1}/{_AGNES_VIDEO_MAX_TRIES}]")
            time.sleep(_wait)
        j = r.json() or {}
        # Retrieval is keyed by video_id. On 2.5 it equals the task id,
        # but the docs name video_id for polling, so prefer it.
        video_id = j.get("video_id") or j.get("task_id") or j.get("id")
        if not video_id:
            log.warning(f"agnes-video: no video id in create response: {str(j)[:160]}")
            return None
    except Exception as e:
        log.warning(f"agnes-video: create error: {e}")
        return None

    deadline = time.time() + _AGNES_VIDEO_POLL_SECONDS
    url = ""
    while time.time() < deadline:
        time.sleep(6)
        try:
            p = _rq.get(f"{_AGNES_VIDEO_POLL_BASE}/agnesapi",
                        params={"video_id": video_id, "model_name": model},
                        headers=headers, timeout=30)
            d = p.json() if p.status_code < 400 else {}
        except Exception:
            continue
        status = str(d.get("status") or "")
        if status == "completed":
            # Top-level `url` on 2.5. metadata.url was v2.0's location —
            # kept as a fallback only so a provider-side revert does not
            # silently lose finished clips.
            url = str(d.get("url") or (d.get("metadata") or {}).get("url") or "")
            break
        if status == "failed":
            _err = d.get("error") or {}
            _msg = _err.get("message") if isinstance(_err, dict) else str(_err)
            log.warning(f"agnes-video: task {video_id} failed: {str(_msg)[:200]}")
            return None
    if not url:
        log.warning(f"agnes-video: task {video_id} did not finish within "
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
    # NEGATIVES WERE ACCEPTED AND NEVER SENT. This function has taken a
    # `negative_prompt` argument since it was written and dropped it on
    # the floor — the body above never carried one. Every global
    # negative and every per-niche negative_style was dead config for
    # the primary image provider.
    #
    # Folded into the prompt text ONLY. The negative_prompt FIELD is no
    # longer sent.
    #
    # It used to go both ways, on the reasoning that the field returned
    # 200 but a 200 only proves acceptance, not that a Gemini-class model
    # honours it. Agnes then started rejecting the field outright —
    # HTTP 400 "negative_prompt is not supported by text image queue" —
    # and because every call carried it, EVERY Agnes image failed: 655 of
    # 655 in the 72h before 2026-10-12. Renders kept finishing only
    # because shots fell through to Cloudflare, Pollinations and stock,
    # which quietly cost the animated niches their consistent look.
    # The prompt text is the half that demonstrably reaches the model.
    if negative_prompt:
        final_prompt = f"{final_prompt}. Avoid: {negative_prompt[:260]}"
        body["prompt"] = final_prompt
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
            # Stated POSITIVELY. "Do not add clothing" still puts
            # clothing in the model's head; "wearing exactly what the
            # reference shows and nothing else" describes the target
            # image instead. Measured need for this: with the earlier
            # negative phrasing, an eight-shot render still produced one
            # cat in a hood, one standing upright on two legs, and one
            # in the wrong colour.
            body["prompt"] = (
                f"{final_prompt}. This is the SAME character as the reference "
                f"image: identical species, identical fur colour and markings, "
                f"identical face. It moves the way the reference shows it moving "
                f"— an animal on all fours stays on all fours, on the ground. It "
                f"is wearing exactly what the reference shows and nothing else. "
                f"Only the scene, the pose and the camera angle differ."
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
        if r.status_code >= 400:
            # Log the BODY. raise_for_status() alone produced "400 Client
            # Error: Bad Request" 655 times while the actual reason — a
            # field the API had started rejecting — sat unread in the
            # response. One line of body would have named it immediately.
            log.warning(f"agnes gen failed: HTTP {r.status_code}: {(r.text or '')[:240]}")
            return None, seed
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

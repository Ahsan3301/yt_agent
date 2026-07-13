# truststore makes Python use the OS certificate store (Windows/macOS) so
# corporate proxies + self-signed certs work without bundling extra CAs.
# On Linux it's unnecessary (the system CA bundle just works) AND it
# triggers a urllib3-internal infinite recursion when boto3 does R2
# uploads over HTTPS — manifests as "maximum recursion depth exceeded"
# at exactly the worst possible moment (after a successful render, on
# the upload step). All our workers run on Linux (Colab / Kaggle / HF
# Space) so we only inject on Windows/macOS where it's both needed and
# safe.
import sys as _sys
if _sys.platform.startswith(("win", "darwin", "cygwin")):
    import truststore as _truststore
    _truststore.inject_into_ssl()


"""
main.py — YouTube Automation Agent Orchestrator
Runs the full pipeline:
  Research → Script → Voiceover → Footage → Edit → Upload

Usage:
  python main.py                  # run once
  python main.py --schedule       # run daily at 10:00 AM
  python main.py --dry-run        # skip upload (test mode)
  python main.py --channel wisdom # override channel type
"""
import os
import sys
import json
import time
import logging
import argparse
import datetime
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

# ── Logging setup ──────────────────────────────────────────────
# On Windows the default file handler picks cp1252 and chokes on non-ASCII
# characters (→, …, em-dashes, etc). Force UTF-8 on the file handler, and
# force the stdout stream to UTF-8 too so the console doesn't crash either.
Path("logs").mkdir(exist_ok=True)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(
            f"logs/agent_{datetime.date.today()}.log",
            encoding="utf-8",
        ),
    ],
)
log = logging.getLogger("agent")

# ── Import modules ─────────────────────────────────────────────
from modules import config
from modules import run_state
from modules.researcher   import research
from modules.scriptwriter import write_script
from modules.voiceover    import generate_voiceover
from modules.footage      import get_footage
from modules.storyboard   import plan_shots, assign_timing
from modules.shotfinder   import fetch_shots
from modules.editor       import assemble_video
from modules.uploader     import upload_video


def _refine_user_script(manual_script: str, manual_title: str, channel_cfg: dict, language: str | None = None) -> dict:
    """Take a user-pasted script and polish it: tighten phrasing, add a
    punchy first-3-second hook in the channel's style, generate a
    YouTube title + description + tags.

    The user's words are PRESERVED — we don't rewrite them away. The hook
    is prepended only if the script doesn't already open with one.

    Falls back to using the raw script as-is if NIM is unreachable.
    """
    from modules import nim as _nim
    body = manual_script.strip()
    hook_style = channel_cfg.get("hook_style", "open with the most surprising claim")
    tone = channel_cfg.get("tone", "engaging")
    channel_name = channel_cfg.get("display_name") or channel_cfg.get("name") or "video"
    # Effective language: explicit arg > channel_cfg > default en. Feeds
    # into the polish prompt so the LLM doesn't translate a German
    # user-script back into English, and so the youtube_title/description
    # come out in the same language as the narration.
    _lang = (language or channel_cfg.get("language") or "en").lower()[:2]
    _lang_names = {
        "en":"English","de":"German","fr":"French","es":"Spanish",
        "it":"Italian","pt":"Portuguese","ru":"Russian","tr":"Turkish",
        "nl":"Dutch","pl":"Polish","ar":"Arabic","ur":"Urdu","hi":"Hindi",
        "bn":"Bengali","ja":"Japanese","ko":"Korean","zh":"Chinese",
        "vi":"Vietnamese","th":"Thai","id":"Indonesian",
    }
    _lang_full = _lang_names.get(_lang, _lang)

    image_style = channel_cfg.get("image_style", "professional photography")
    perspective = channel_cfg.get(
        "perspective",
        "third_person_objective — narrate ABOUT the subject, not as personal anecdote.",
    )
    prompt = f"""You are polishing a user-written script for a YouTube Shorts
video. The script must hit hard — Shorts metrics live and die on the
first 3 seconds and on completion rate.

Language: {_lang_full} ({_lang}) — the narration, youtube_title, and
description MUST be written IN THIS LANGUAGE. Do NOT translate the
user's script to English. Do NOT respond in English if the language
is anything other than English. The `tags` and `search_keywords`
arrays MAY stay in English for YouTube SEO reach.

Channel: {channel_name}
Tone target: {tone}
Narrator perspective: {perspective}
Hook guidance: {hook_style}

User's draft script:
\"\"\"
{body}
\"\"\"

Your job — IN THIS ORDER:

1. EVALUATE THE OPENING. If the user's first sentence is an
   introduction ("Today I'll talk about...", "Have you ever
   wondered...", "Let me tell you about...", a greeting, or anything
   slow), REPLACE IT with a 1-2 sentence hook that follows the channel's
   hook guidance above. The hook MUST be a pattern interrupt — drop
   the viewer mid-action, mid-claim, or mid-question. NEVER an intro.
   If the user's opening IS already a strong hook, leave it alone.

1b. FIX THE PERSPECTIVE if it conflicts with the channel's narrator
    perspective above. If the channel calls for third-person but the
    user wrote first-person ("when I lost $40K..."), rewrite into the
    correct perspective WHILE PRESERVING the facts and the user's
    voice. The viewer should not feel like they're listening to a
    single person's diary unless the channel explicitly calls for that.

2. POLISH THE BODY. Tighten phrasing, vary sentence rhythm
   (short. then medium-length. then occasionally longer), inject
   specificity (replace vague words with concrete nouns/numbers when
   the user's facts support it), cut filler phrases like "basically",
   "in conclusion", "the fact is", "you see", "if you think about it",
   "it's important to note".
   CRITICAL: PRESERVE the user's content, claims, examples, and voice.
   Do NOT invent new facts. Do NOT add claims the user didn't make.
   Polish means SUBTRACT or REORDER, not ADD information.

3. ADD AN OPEN-LOOP IF MISSING. If the script doesn't plant a
   question or stakes early that the body resolves, weave one into
   the second sentence using only the user's existing material.

4. PUNCH THE ENDING. The last sentence must land — a memorable
   one-liner, a callback to the hook, or a flip of framing. NEVER
   "thanks for watching" or "subscribe". If the user's ending is
   limp, rewrite it using ideas from the script itself.

5. METADATA:
   - youtube_title:   under 60 chars. Curiosity gap, not hype. Strong
                       nouns, numbers, or questions. No ALL CAPS,
                       no emoji, no "you won't believe" / "shocked".
   - description:     150-200 words. First 2 sentences re-hook the
                       click. Previews value without spoiling. Natural
                       keyword density.
   - search_keywords: 5-8 phrases, 4-7 words each. Each phrase
                       describes a SHOT (subject + lighting/mood +
                       setting). Visual style for this channel:
                       {image_style}.
   - tags:            8-12 YouTube tags, mix of specific + broad.

Return ONLY this JSON (no markdown fences):
{{
  "narration":       "<polished script>",
  "youtube_title":   "<under 60 chars>",
  "description":     "<150-200 words>",
  "search_keywords": ["visual phrase 1", "visual phrase 2", ...],
  "tags":            ["tag1", "tag2", ...]
}}"""

    try:
        raw = _nim.chat(
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=1800,
            temperature=0.4,
        )
        import json as _json
        data = _json.loads(raw) if isinstance(raw, str) else (raw if isinstance(raw, dict) else _json.loads(str(raw)))
        # Sanity defaults — never let a missing field break downstream.
        if not data.get("narration"):
            data["narration"] = body
        if manual_title and not data.get("youtube_title"):
            data["youtube_title"] = manual_title.strip()[:100]
        data.setdefault("description", "")
        data.setdefault("search_keywords", [])
        data.setdefault("tags", [])
        return data
    except Exception as e:
        log.warning(f"_refine_user_script: NIM call failed ({e}); using script verbatim")
        return {
            "narration":       body,
            "youtube_title":   (manual_title or body.split(".")[0])[:100],
            "description":     "",
            "search_keywords": [],
            "tags":            [],
        }


def _step(summary, name, fn, *, run_id: str = "", checkpoint_payload=None):
    """Time a pipeline step, record it in summary, and emit progress to run_state.

    Idempotency: if `run_id` is set AND the checkpoint says this stage
    is already complete, return the stored artifact instead of running
    `fn` again. The pipeline calling this is responsible for passing
    the right `checkpoint_payload(result)` so future resumes can
    reconstruct the stage's outputs.
    """
    run_state.check_cancel()
    # Resume short-circuit — only if the checkpoint has an artifact for
    # this stage. (A stage completed via a fresh run shouldn't be
    # short-circuited.)
    if run_id:
        try:
            from modules import checkpoint as _cp
            if _cp.completed(run_id, name):
                stored = _cp.artifact(run_id, name)
                if stored is not None:
                    log.info(f"[STAGE:{name}] resuming from checkpoint (skipping)")
                    summary["steps"][name] = {"ok": True, "seconds": 0, "resumed": True}
                    run_state.step_done(name)
                    return stored.get("result") if isinstance(stored, dict) else stored
        except Exception as _e:
            log.debug(f"checkpoint resume skipped: {_e}")

    run_state.step_started(name)
    t0 = time.time()
    try:
        result = fn()
        summary["steps"][name] = {"ok": result is not None and result is not False, "seconds": round(time.time() - t0, 2)}
        run_state.step_done(name)
        run_state.check_cancel()
        # Persist the stage artifact for future resumes.
        if run_id and result is not None and result is not False:
            try:
                from modules import checkpoint as _cp
                payload = checkpoint_payload(result) if callable(checkpoint_payload) else {"result": result}
                _cp.save(run_id, name, data=payload)
            except Exception as _e:
                log.debug(f"checkpoint save skipped: {_e}")
        return result
    except run_state.Cancelled:
        summary["steps"][name] = {"ok": False, "seconds": round(time.time() - t0, 2), "error": "cancelled"}
        raise
    except Exception as e:
        summary["steps"][name] = {"ok": False, "seconds": round(time.time() - t0, 2), "error": repr(e)}
        raise


def run_pipeline(
    channel_type=None,
    dry_run=False,
    resume_run_id: str = "",
    # ── Manual mode params ─────────────────────────────────────
    # When any of these are set, the pipeline skips the auto-generated
    # equivalent. Topic-only: skip research. Full script: skip research +
    # script. Images: feed straight into shotfinder, fetch only what's
    # not covered.
    manual_topic: str = "",
    manual_script: str = "",
    manual_title: str = "",
    manual_images: list | None = None,
    manual_channel_desc: str = "",
    # Tri-state web research override:
    #   None  -> use the channel's web_research_enabled default
    #   True  -> force ON
    #   False -> force OFF
    # Lets the dashboard's per-job toggle override channel defaults.
    web_research: Optional[bool] = None,
    # Real-events mode — when True, scriptwriter is forced to anchor
    # the narration in documented real events (or accurately retold
    # mythology). Niche-aware framing chosen inside scriptwriter.
    real_events: Optional[bool] = None,
    # Script language (ISO-2 code). Default "en"; channel preset or
    # job-level override can flip it to "ur", "hi", etc. Affects both
    # the scriptwriter LLM instruction AND the edge-tts voice selection.
    language: Optional[str] = None,
    # Voice override — if the user picked a specific voice from the
    # niche catalog in the wizard, pass it here. Overrides the channel
    # preset's default voice but NOT the language-default fallback.
    voice_override: Optional[str] = None,
    # Which YouTube account to publish to — id of the
    # youtube_accounts/<id> doc. None falls back to the legacy single
    # api_keys/YOUTUBE_REFRESH_TOKEN credential.
    youtube_account_id: Optional[str] = None,
    # Per-channel tone override from the channels doc. Overrides the
    # niche preset's tone (which is baked into modules/channels.py)
    # ONLY for this render — no global bleed. Empty/None = niche default.
    tone_override: Optional[str] = None,
    # Per-channel YouTube privacy override — "public"/"unlisted"/"private".
    # None = fall back to settings.upload.privacy (global default).
    privacy_override: Optional[str] = None,
):
    """
    Execute the full automation pipeline for one video.

    Returns True on success, False on failure.

    `resume_run_id`: if set, reuse that run_id and skip stages whose
    checkpoint says they're complete. Used by the job worker when a
    previous render of this run died mid-pipeline (e.g. worker crashed
    in edit stage; we resume from edit instead of redoing research).

    Manual mode (all optional):
      manual_topic       — a topic seed; replaces research's auto-pick.
      manual_script      — a full narration; replaces research+script
                            entirely.
      manual_title       — overrides the LLM-generated YouTube title.
      manual_images      — list of public URLs (R2 staging) to use as
                            shot footage. Pipeline fills any remaining
                            slots from the normal footage providers.
      manual_channel_desc — used for custom (unknown) channels;
                            channels.synthesize_custom() uses this to
                            build a preset on the fly.
    """
    from modules import channels as _ch

    channel_type = channel_type or config.CHANNEL_TYPE
    # Resolve the channel config UP FRONT — every later step reads from it.
    channel_cfg = _ch.resolve(channel_type, manual_channel_desc)
    # SINGLE SOURCE OF TRUTH for language across the whole pipeline. The
    # job-level `language` param wins; otherwise fall back to the
    # channel preset's language; otherwise 'en'. Merge it back into
    # channel_cfg so every step that reads channel_cfg.language (SEO
    # writer, storyboard, scriptwriter fallback, custom-niche
    # synthesizer) sees the SAME value — no more "narration=de but
    # SEO=en" split. eff_language is still defined again below at the
    # voiceover step for backward-compat with existing references.
    _pipeline_lang = (
        (language or channel_cfg.get("language") or "en") or "en"
    ).lower()[:2]
    channel_cfg["language"] = _pipeline_lang
    # Per-channel tone override — if the dashboard channels doc supplied
    # one, it wins over the niche preset's default so a horror channel's
    # "chilling" doesn't bleed into a science channel that reuses the
    # settings.tone knob. Empty string skipped.
    # Compute the effective tone override once — used in two places:
    #   1. Mutated onto channel_cfg (local var here) so downstream steps
    #      that read channel_cfg in main.py see it.
    #   2. Stashed on `content` after research so it survives into
    #      write_script (which re-fetches channel_cfg from CHANNEL_PRESETS
    #      and would otherwise drop the mutation — this was the 2026-07-13
    #      audit's HIGH-1 bug).
    _tone_clean = ""
    if tone_override:
        _tone_clean = str(tone_override).strip()[:40]
        if _tone_clean:
            channel_cfg["tone"] = _tone_clean
    # Verification log — every render's PB run_logs starts with a
    # single line summarising the language + voice + GPU state so we
    # can audit any published video by grep. Cheap and self-documenting.
    try:
        from modules import gpu_topology as _gt_v
        _gpu_summary = (
            f"multi_gpu={_gt_v.supports_multi_gpu} "
            f"devices={_gt_v.device_ids} "
            f"kokoro_dev={_gt_v.kokoro_device}"
        )
    except Exception:
        _gpu_summary = "gpu_topology_unavailable"
    log.info(
        f"pipeline_lang={_pipeline_lang!r} "
        f"channel={channel_type!r} "
        f"voice_override={voice_override!r} "
        f"{_gpu_summary}"
    )
    # run_id — timestamp + 3-char random tail. Two workers that boot
    # the exact same second would previously collide on the timestamp
    # alone and overwrite each other's output/videos/<run_id>/ dir.
    # The random suffix costs nothing and closes that race.
    if resume_run_id:
        run_id = resume_run_id
    else:
        import secrets, string
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        tail = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(3))
        run_id = f"{ts}_{tail}"
    if resume_run_id:
        log.info(f"resume mode: run_id={run_id} — completed stages will be skipped")
    work_dir = os.path.join("output", "videos", run_id)
    Path(work_dir).mkdir(parents=True, exist_ok=True)

    manual_images = list(manual_images or [])
    manual_mode = bool(manual_topic or manual_script or manual_images)

    summary = {
        "run_id": run_id,
        "channel": channel_type,
        "channel_cfg": {k: channel_cfg.get(k) for k in ("display_name", "tone", "color_grade")},
        "dry_run": dry_run,
        "manual_mode": manual_mode,
        # Language of the entire pipeline output — persisted so publish
        # side-jobs (backend/side_jobs.py) can set YouTube's
        # defaultLanguage/defaultAudioLanguage even when the render is
        # published hours later from the /library UI.
        "language": _pipeline_lang,
        "started_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "steps": {},
    }

    log.info("=" * 50)
    log.info(f"Starting pipeline | channel={channel_type} | run={run_id}")
    log.info("=" * 50)

    # Preference-visibility audit (2026-07-13). The user asked that no
    # preference silently gets ignored. Log at pipeline start:
    #   - The full image_gen.priority list from settings.
    #   - Which providers are READY on THIS worker.
    #   - If a top-3 priority provider is NOT ready, WARN loudly.
    #
    # The audit does its own basic probes (env vars + CUDA + settings
    # toggle) — it can't call shotfinder._provider_ready because that
    # lives inside fetch_shots() as a closure. The probes here mirror
    # the checks _provider_ready does but at coarser granularity —
    # good enough for the pipeline-start alert.
    try:
        from modules.config import load_settings as _ls_pref
        _ig = (_ls_pref().get("image_gen") or {})
        _prio = list(_ig.get("priority") or [])
        _enabled = dict(_ig.get("enabled") or {})

        def _probe(name: str) -> tuple[bool, str]:
            if _enabled.get(name, True) is False:
                return False, "disabled in /settings"
            if name == "cloudflare":
                if not (os.getenv("CLOUDFLARE_ACCOUNTS_JSON", "").strip()
                        or (os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
                            and os.getenv("CLOUDFLARE_API_TOKEN", "").strip())):
                    return False, "no CLOUDFLARE_ACCOUNTS_JSON / CLOUDFLARE_ACCOUNT_ID+TOKEN"
                return True, ""
            if name == "huggingface":
                if not os.getenv("HF_TOKEN", "").strip():
                    return False, "no HF_TOKEN"
                return True, ""
            if name in ("local_sdxl", "local_flux2_klein"):
                try:
                    import torch as _t_pref
                    if not _t_pref.cuda.is_available():
                        return False, "no CUDA device"
                except Exception as _te:
                    return False, f"torch not usable: {_te}"
                # Klein-4B extra: needs Flux2KleinPipeline import.
                if name == "local_flux2_klein":
                    try:
                        from diffusers import Flux2KleinPipeline as _fkp  # noqa: F401
                    except Exception as _fe:
                        return False, f"Flux2KleinPipeline import failed: {_fe}"
                return True, ""
            if name in ("pollinations", "horde"):
                return True, ""  # always network-available
            return True, ""

        _ready, _skipped = [], []
        for _p in _prio:
            _ok, _why = _probe(_p)
            (_ready if _ok else _skipped).append(_p if _ok else (_p, _why))

        log.info(f"  image_gen.priority: {_prio}")
        log.info(f"  image_gen ready on this worker: {_ready}")
        # WARN for TOP-3 misses only — tail is expected to be fallback.
        _top3 = set(_prio[:3])
        for _p, _reason in _skipped:
            if _p in _top3:
                _slot = _prio.index(_p) + 1
                _next = _prio[_slot] if _slot < len(_prio) else "(end)"
                log.warning(
                    f"  ⚠️  TOP-{_slot} image provider {_p!r} unavailable on this worker: "
                    f"{_reason}. Chain will fall to slot {_slot+1} → {_next}. If you want "
                    f"{_p!r} specifically, edit the channel's allowed_workers so a "
                    f"compatible worker claims the render."
                )
    except Exception as _pref_e:
        log.debug(f"preference-visibility audit skipped: {_pref_e}")

    run_state.start(run_id=run_id, channel=channel_type, dry_run=dry_run)
    # Stream this run's logs to Firestore runs_index/<id>/logs so the
    # dashboard's LogsPanel can subscribe in real-time. Best-effort —
    # if Firestore isn't configured the sink no-ops and we fall back
    # to the worker's /api/logs polling path.
    try:
        from backend import logbuf as _logbuf
        _logbuf.attach_run(run_id)
    except Exception:
        pass

    try:
        # ── STEP 1: Research (or manual topic) ───────────────────
        if manual_script:
            log.info("[1/6] Manual script provided — script generation skipped.")
            content = {
                "raw_title": manual_title or (manual_topic[:80] if manual_topic else "user-provided script"),
                "type":      channel_type,
                "keywords":  [],
                "manual":    True,
            }
            # BUT still run the browser research agent when the user
            # asked for it — they want supporting hero images and facts
            # even though the narration is fixed. Query is derived from
            # the script's first two sentences so the agent knows what
            # to search for. Facts don't overwrite the script (they
            # wrote it deliberately); image_urls DO feed manual_images
            # so shot fetching uses real photos instead of AI-generating
            # everything.
            if web_research is None:
                want_research = bool(channel_cfg.get("web_research_enabled"))
            else:
                want_research = bool(web_research)
            if want_research:
                try:
                    from modules import research_agent as _ra
                    import re as _re
                    _sents = _re.split(r"(?<=[.!?])\s+", manual_script.strip())
                    _q = " ".join(_sents[:2])[:220].strip()
                    if not _q:
                        _q = (manual_title or manual_topic or "").strip()
                    if _ra.is_available() and _q:
                        log.info(f"  research_agent (manual-script mode): "
                                 f"query='{_q[:80]}...'")
                        bundle = _ra.research_topic(
                            topic=_q,
                            max_steps=10,   # bumped from 6 — the model spends 3-4 steps exploring before starting to converge; 6 was too tight under NIM 429 throttling and caused "exhausted step budget" with no final JSON. overall_timeout_sec=180 still bounds runaway agents.
                            channel_cfg=channel_cfg,
                            overall_timeout_sec=180,
                            language=_pipeline_lang,
                        )
                        if bundle:
                            content["facts"]   = bundle.get("facts") or []
                            content["sources"] = bundle.get("sources") or []
                            content["keywords"] = bundle.get("search_keywords") or []
                            imgs = bundle.get("image_urls") or []
                            if imgs:
                                seen = set(manual_images or [])
                                added = 0
                                for u in imgs:
                                    if u and u not in seen and len(manual_images) < 8:
                                        manual_images.append(u)
                                        seen.add(u)
                                        added += 1
                                if added:
                                    log.info(f"  research_agent contributed {added} hero images "
                                             f"(total manual_images now {len(manual_images)})")
                    elif not _ra.is_available():
                        log.info("  research_agent: requested but playwright unavailable — skipping")
                    else:
                        log.info("  research_agent: no query derivable from script — skipping")
                except Exception as e:
                    log.warning(f"  research_agent (manual-script mode) failed: {e}")
            summary["steps"]["research"] = {
                "ok": True, "seconds": 0.0, "skipped_manual": True,
                "manual_script_agent_facts": len(content.get("facts") or []),
            }
        elif manual_topic:
            log.info(f"[1/6] Manual topic: {manual_topic[:80]} — building research bundle.")
            # Decide whether to run the NIM-controlled browser agent.
            # Per-job override (web_research=) takes precedence; else
            # the channel's web_research_enabled default.
            if web_research is None:
                want_research = bool(channel_cfg.get("web_research_enabled"))
            else:
                want_research = bool(web_research)
            research_bundle = None
            if want_research:
                try:
                    from modules import research_agent as _ra
                    # Build a research query the browser agent can act on.
                    # Priority:
                    #   1. manual_topic — the user typed a topic explicitly.
                    #   2. First 2 sentences (or 220 chars) of manual_script —
                    #      when the user pasted a full script but no topic,
                    #      we derive the search query from what the script
                    #      is ABOUT so the agent fetches images/facts that
                    #      match the story, not generic channel-niche stuff.
                    #   3. manual_title — last-resort seed.
                    _research_query = (manual_topic or "").strip()
                    if not _research_query and manual_script:
                        _script_txt = manual_script.strip()
                        import re as _re
                        # Grab the first 2 sentences, capped at 220 chars.
                        _sents = _re.split(r"(?<=[.!?])\s+", _script_txt)
                        _research_query = " ".join(_sents[:2])[:220].strip()
                    if not _research_query and manual_title:
                        _research_query = manual_title.strip()

                    if _ra.is_available() and _research_query:
                        log.info(f"  research_agent: starting NIM-driven browser research "
                                 f"| query='{_research_query[:80]}...'")
                        research_bundle = _ra.research_topic(
                            topic=_research_query,
                            max_steps=10,   # bumped from 6 — the model spends 3-4 steps exploring before starting to converge; 6 was too tight under NIM 429 throttling and caused "exhausted step budget" with no final JSON. overall_timeout_sec=180 still bounds runaway agents.
                            channel_cfg=channel_cfg,
                            overall_timeout_sec=180,
                            language=_pipeline_lang,
                        )
                    elif not _ra.is_available():
                        log.info("  research_agent: requested but playwright unavailable — skipping")
                    else:
                        log.info("  research_agent: no research query available (no topic/script/title) — skipping")
                except Exception as e:
                    log.warning(f"  research_agent failed: {e} — continuing without research")
            else:
                log.info("  research_agent: disabled for this job")
            content = {
                "raw_title": manual_topic.strip(),
                "type":      channel_type,
                "keywords":  (research_bundle or {}).get("search_keywords") or [],
                "facts":     (research_bundle or {}).get("facts") or [],
                "sources":   (research_bundle or {}).get("sources") or [],
                "manual":    True,
            }
            # Merge agent-scraped hero images WITH the user's uploaded
            # images. Previously the agent's images were dropped when
            # the user provided their own — which is exactly when web
            # research + evidence is most valuable (they picked a
            # reference and want more like it). Now: user's images go
            # first (they wanted THOSE specifically), agent's images
            # fill remaining slots up to 8. Dedup by URL so we don't
            # queue the same photo twice.
            agent_imgs = (research_bundle or {}).get("image_urls") or []
            if agent_imgs:
                seen = set(manual_images or [])
                added = 0
                for u in agent_imgs:
                    if u and u not in seen and len(manual_images) < 8:
                        manual_images.append(u)
                        seen.add(u)
                        added += 1
                if added:
                    log.info(f"  research_agent contributed {added} hero images "
                             f"(total manual_images now {len(manual_images)})")
            summary["steps"]["research"] = {
                "ok": True, "seconds": 0.0, "skipped_manual": True,
                "agent_used": bool(research_bundle),
                "agent_facts": len((research_bundle or {}).get("facts") or []),
            }
        else:
            log.info("[1/6] Researching content...")
            # Pass language so premise dedup is scoped per (niche, language).
            # Previously ALL calls shared one global data/used_premises.json
            # which caused a German horror channel to publish the same
            # script 3× — both because the file was ephemeral on Kaggle
            # (reset every boot) AND because the non-horror NIM-fallback
            # path returned footage_keywords[0] every single time.
            content = _step(summary, "research", lambda: research(
                channel_type, language=_pipeline_lang,
            ), run_id=run_id)
            if not content:
                log.error("Research failed. Aborting.")
                return _finish(summary, work_dir, False)
        log.info(f"Topic: {content['raw_title'][:80]}")
        # Stash premise metadata on the summary so runs_db.write_run
        # persists them. researcher._seed_from_db reads these fields
        # on the next boot to seed the used-set — that's what keeps
        # premise dedup alive across ephemeral Kaggle worker restarts.
        summary["premise_key"] = str(content.get("premise_key") or content.get("raw_title") or "")[:200]
        summary["premise"]     = str(content.get("raw_title") or "")[:400]
        summary["language"]    = str(content.get("language") or _pipeline_lang or "en")[:8]

        # On T4x2, kick SDXL pre-warm on both GPUs in a background thread
        # NOW so it races the ~30-90 sec script LLM call AND the ~30-60
        # sec TTS call that follows. Previously this fired at [3/6]
        # voiceover start — moving it to [2/6] script start doubles the
        # window it has to finish, which matters most on the first job
        # after a cold Kaggle boot where the SDXL fetch/materialize
        # runs long. Joined right before fetch_shots. Single-GPU path
        # is a no-op (regression-free).
        _sdxl_warm_thread = None
        try:
            from modules import gpu_topology as _gt_warm
            if _gt_warm.supports_multi_gpu:
                import threading as _th_warm
                from modules.shotfinder import _local_sdxl_load as _sdxl_warm_load
                _warm_devs = list(_gt_warm.sdxl_ready_devices)
                def _warm_all():
                    from concurrent.futures import ThreadPoolExecutor as _TPE
                    try:
                        with _TPE(max_workers=len(_warm_devs),
                                  thread_name_prefix="sdxl-warm-bg") as _wex:
                            list(_wex.map(_sdxl_warm_load, _warm_devs))
                    except Exception as _we:
                        log.debug(f"bg SDXL warm crashed: {_we}")
                log.info(f"[2/6] bg SDXL warm on cuda:{_warm_devs} overlapping script+TTS")
                _sdxl_warm_thread = _th_warm.Thread(
                    target=_warm_all, name="sdxl-warm-overlap", daemon=True,
                )
                _sdxl_warm_thread.start()
        except Exception as _wex:
            log.debug(f"bg SDXL warm skipped: {_wex}")

        # ── STEP 2: Script (or manual + refine) ──────────────────
        if manual_script:
            log.info("[2/6] Refining user-provided script (hook + polish)...")
            script = _step(summary, "script", lambda: _refine_user_script(
                manual_script=manual_script,
                manual_title=manual_title,
                channel_cfg=channel_cfg,
                language=_pipeline_lang,
            ), run_id=run_id)
        else:
            log.info("[2/6] Writing script with LLM...")
            # Inject job-level language + real_events into the research
            # bundle so write_script picks them up.
            if language is not None:
                content["language"] = (language or "en").lower()[:2]
            elif channel_cfg.get("language"):
                content["language"] = channel_cfg["language"]
            if real_events is not None:
                content["real_events"] = bool(real_events)
            # Per-channel tone override reaches scriptwriter via `content`
            # — scriptwriter re-fetches channel_cfg from CHANNEL_PRESETS
            # (dropping the mutation main.py did above), so this is the
            # only path that survives. Empty string skipped.
            if _tone_clean:
                content["tone_override"] = _tone_clean
            script = _step(summary, "script", lambda: write_script(content), run_id=run_id)
        if not script:
            log.error("Script generation failed. Aborting.")
            return _finish(summary, work_dir, False)
        if manual_title:
            script["youtube_title"] = manual_title.strip()[:100]
        log.info(f"Title: {script.get('youtube_title')}")
        log.info(f"Script length: {len(script.get('narration','').split())} words")

        # ── STEP 3: Voiceover ─────────────────────────────────────
        log.info("[3/6] Generating voiceover...")
        audio_dir = os.path.join(work_dir, "audio")
        # Resolve effective language for voiceover — same value as the
        # pipeline-wide _pipeline_lang set above, kept as a local for
        # backward compat with existing references below.
        eff_language = _pipeline_lang
        # (SDXL bg warm was kicked at [2/6] script start above — it's
        # still running here overlapping TTS. Joined before fetch_shots.)
        audio_path = _step(summary, "voiceover", lambda: generate_voiceover(
            script["narration"], channel_type, audio_dir,
            language=eff_language,
            voice_override=voice_override,
        ), run_id=run_id)
        if not audio_path:
            log.error("Voiceover generation failed. Aborting.")
            return _finish(summary, work_dir, False)

        # ── STEP 3.5: Publish-ready SEO metadata ─────────────────
        # Narration is now frozen. Run the SEO writer BEFORE render so
        # every published video ships with per-niche viral metadata
        # (title/description/tags/hashtags/pinned comment/thumbnail
        # ideas/category id) tuned to the actual chosen words. Persisted
        # into summary so autopublish + manual publish both find it —
        # replaces the old "Run <id>" default that shipped when
        # summary didn't carry script metadata.
        log.info("[3.5/6] Writing publish-ready SEO metadata...")
        try:
            from modules import seo_writer
            # Optional: borrow top-ranking peer title(s) to inform tone.
            borrowed_titles = None
            try:
                from modules.config import load_settings as _ls
                _seo_cfg = (_ls().get("seo") or {})
                if _seo_cfg.get("borrow_from_ranking", True):
                    from modules import seo_borrower as _sb
                    topic_seed = (content or {}).get("raw_title") or script.get("youtube_title") or ""
                    if topic_seed:
                        try:
                            viral = _sb.find_viral(topic_seed)
                            if viral and viral.get("title"):
                                borrowed_titles = [viral["title"]]
                        except Exception as _sb_e:
                            log.debug(f"seo_borrower.find_viral skipped: {_sb_e}")
            except Exception:
                pass
            publish_ready = _step(summary, "seo", lambda: seo_writer.write_seo_metadata(
                narration=script["narration"],
                script=script,
                channel_cfg=channel_cfg,
                research_data=content,
                borrowed_titles=borrowed_titles,
            ), run_id=run_id)
        except Exception as _seo_err:
            log.warning(f"SEO writer failed hard, using script metadata only: {_seo_err}")
            publish_ready = None

        if publish_ready:
            # Merge canonical fields into script so uploader.upload_video
            # (which reads youtube_title/description/tags off script)
            # picks up the SEO-tuned metadata without a signature change.
            script["youtube_title"] = publish_ready.get("youtube_title") or script.get("youtube_title") or ""
            script["description"]   = publish_ready.get("description")   or script.get("description") or ""
            script["tags"]          = publish_ready.get("tags")          or script.get("tags") or []
            # Persist BOTH the raw script AND the publish_ready block so
            # side_jobs.py + history UI can render either shape.
            summary["script"] = {
                "narration":       script.get("narration", ""),
                "youtube_title":   script.get("youtube_title", ""),
                "description":     script.get("description", ""),
                "tags":            script.get("tags", []),
                "search_keywords": script.get("search_keywords", []),
            }
            summary["publish_ready"] = publish_ready
            # Top-level mirrors — side_jobs.py:_publish_youtube walks
            # data.youtube_title → data.title → data.description → data.tags.
            summary["youtube_title"] = script.get("youtube_title", "")
            summary["title"]         = script.get("youtube_title", "")
            summary["description"]   = script.get("description", "")
            summary["tags"]          = script.get("tags", [])
            log.info(f"SEO metadata locked | source={publish_ready.get('_source','?')} "
                     f"title='{summary['youtube_title'][:60]}' tags={len(summary['tags'])} "
                     f"hashtags={len(publish_ready.get('hashtags',[]))} "
                     f"category={publish_ready.get('youtube_category_id')}")
        else:
            # Fallback: still persist whatever the scriptwriter produced.
            summary["script"] = {
                "narration":       script.get("narration", ""),
                "youtube_title":   script.get("youtube_title", ""),
                "description":     script.get("description", ""),
                "tags":            script.get("tags", []),
                "search_keywords": script.get("search_keywords", []),
            }
            summary["youtube_title"] = script.get("youtube_title", "")
            summary["title"]         = script.get("youtube_title", "")
            summary["description"]   = script.get("description", "")
            summary["tags"]          = script.get("tags", [])

        # ── STEP 4: Footage ───────────────────────────────────────
        log.info("[4/6] Fetching stock footage (storyboard-driven)...")
        clips_dir = os.path.join(work_dir, "clips")
        from modules.editor import get_audio_duration
        voice_seconds = get_audio_duration(audio_path)
        # ~6s per shot — keeps the count manageable for vision-judging.
        num_shots = max(6, int(voice_seconds / 6.0) + 1)
        log.info(f"Voiceover {voice_seconds:.1f}s → planning {num_shots} shots")

        # Storyboard: NIM breaks the narration into shots with per-shot
        # visual_description, search_query, and ai_prompt.
        shots = plan_shots(
            script["narration"], num_shots, channel=channel_type,
            language=_pipeline_lang, tone_override=_tone_clean,
        )
        footage = None

        if shots:
            assign_timing(shots, voice_seconds)
            for i, sh in enumerate(shots):
                log.info(f"  shot {i+1}: [{sh['start']:.1f}-{sh['end']:.1f}s] "
                         f"{sh['search_query']!r}")
            summary["shots"] = shots

            # ── Manual images: download user-provided URLs into clips_dir,
            #    fan them across the EARLIEST shots, let fetch_shots fill
            #    the rest. The user's images are treated as preferred —
            #    we never throw any away.
            preset_sources: list[dict] = []
            if manual_images:
                Path(clips_dir).mkdir(parents=True, exist_ok=True)
                import requests as _rq
                for idx, src_url in enumerate(manual_images):
                    try:
                        r = _rq.get(src_url, timeout=30, stream=True)
                        r.raise_for_status()
                        ext = ".jpg"
                        if "png" in (r.headers.get("content-type") or "").lower():
                            ext = ".png"
                        path = os.path.join(clips_dir, f"manual_{idx:02d}{ext}")
                        with open(path, "wb") as f:
                            for chunk in r.iter_content(64 * 1024):
                                f.write(chunk)
                        preset_sources.append({"type": "image", "path": path, "origin": "manual_upload"})
                        log.info(f"  manual image {idx+1}/{len(manual_images)}: downloaded → {path}")
                    except Exception as e:
                        log.warning(f"  manual image {idx+1} failed to download ({src_url}): {e}")

            # Join the bg SDXL warm before dispatching shots. If it's
            # already done this returns immediately; if it's still
            # loading GPU 1's pipe we wait so the round-robin dispatch
            # doesn't hit an un-warmed cuda:1 on shot 2.
            if _sdxl_warm_thread is not None and _sdxl_warm_thread.is_alive():
                log.info("waiting for bg SDXL warm to finish before shot dispatch...")
                _sdxl_warm_thread.join(timeout=300)
            sources = _step(summary, "footage", lambda: fetch_shots(
                shots, clips_dir, channel=channel_type,
                preset_sources=preset_sources,
                tone_override=_tone_clean, language=_pipeline_lang,
            ), run_id=run_id)
            # Music separately — same provider chain as before, just no images.
            from modules.footage import get_music, MUSIC_KEYWORDS
            from modules.config import load_settings as _ls
            music_q = (_ls().get("music_keywords") or {}).get(channel_type) \
                       or MUSIC_KEYWORDS.get(channel_type, "background music")
            music = get_music(music_q, clips_dir)
            footage = {"sources": sources, "music": music}
        else:
            # Storyboard failed. Synthesize a minimal storyboard from
            # the script by splitting the narration into num_shots
            # roughly-equal chunks. This is a DEGRADED mode but keeps
            # the AI-image path alive (CF + Pollinations still fire on
            # per-chunk prompts), which is way better than the old
            # keyword-pool path that only hit stock APIs.
            log.warning("=" * 70)
            log.warning("  STORYBOARD PARSE FAILED — synthesizing stub from script narration.")
            log.warning("  Each shot's visual_description = its narration chunk. Not ideal, but")
            log.warning("  AI image providers (Cloudflare + Pollinations) will still fire.")
            log.warning("=" * 70)
            summary["storyboard_fallback"] = True
            import re as _re
            _narr = (script.get("narration") or "").strip()
            # Split on sentence boundaries; regroup into num_shots buckets.
            _sents = [s.strip() for s in _re.split(r"(?<=[.!?])\s+", _narr) if s.strip()]
            _n = max(1, min(num_shots, len(_sents)))
            _stride = max(1, len(_sents) // _n)
            _synth_shots = []
            for _i in range(_n):
                _lo = _i * _stride
                _hi = len(_sents) if _i == _n - 1 else (_i + 1) * _stride
                _chunk = " ".join(_sents[_lo:_hi]).strip() or _narr[:200]
                _synth_shots.append({
                    "narration_excerpt": _chunk[:240],
                    "visual_description": _chunk[:240],
                    "search_query": _chunk[:80],
                    "ai_prompt": _chunk[:400],
                })
            from modules.storyboard import assign_timing as _assign_t
            shots = _assign_t(_synth_shots, voice_duration)
            log.info(f"synth storyboard: {len(shots)} shots from {len(_sents)} sentences")

            if _sdxl_warm_thread is not None and _sdxl_warm_thread.is_alive():
                log.info("waiting for bg SDXL warm to finish before shot dispatch...")
                _sdxl_warm_thread.join(timeout=300)
            sources = _step(summary, "footage", lambda: fetch_shots(
                shots, clips_dir, channel=channel_type,
                preset_sources=[],
                tone_override=_tone_clean, language=_pipeline_lang,
            ), run_id=run_id)
            from modules.footage import get_music, MUSIC_KEYWORDS
            from modules.config import load_settings as _ls
            music_q = (_ls().get("music_keywords") or {}).get(channel_type) \
                       or MUSIC_KEYWORDS.get(channel_type, "background music")
            music = get_music(music_q, clips_dir)
            footage = {"sources": sources, "music": music}

        if not footage["sources"]:
            log.error("No footage downloaded. Check API keys. Aborting.")
            return _finish(summary, work_dir, False)

        # ── STEP 5: Edit ──────────────────────────────────────────
        log.info("[5/6] Assembling video with ffmpeg...")
        final_video = _step(summary, "edit", lambda: assemble_video(
            voiceover_path=audio_path,
            sources=footage["sources"],
            music_path=footage["music"],
            narration_text=script["narration"],
            output_dir=work_dir,
            channel=channel_type,
        ), run_id=run_id)
        if not final_video:
            log.error("Video assembly failed. Aborting.")
            return _finish(summary, work_dir, False)
        summary["final_video"] = final_video

        # ── STEP 6: Upload ────────────────────────────────────────
        if dry_run:
            log.info("[SKIP] Dry run — skipping YouTube upload")
            log.info(f"Video ready at: {final_video}")
            summary["steps"]["upload"] = {"ok": True, "skipped": True, "seconds": 0}
        else:
            log.info("[6/6] Uploading to YouTube...")
            # NOTE: legacy seo_borrower.borrow_seo call was here — it now
            # runs inside seo_writer.write_seo_metadata (step 3.5) via the
            # borrow_from_ranking toggle, so the borrowed material makes
            # it into the persisted publish_ready block instead of
            # mutating script at upload time.
            video_id = _step(summary, "upload", lambda: upload_video(
                final_video, script, channel_type,
                youtube_account_id=youtube_account_id,
                language=eff_language,
                privacy_override=privacy_override,
            ), run_id=run_id)
            if video_id:
                summary["video_id"]  = video_id
                summary["video_url"] = f"https://youtu.be/{video_id}"
                summary["published"] = {
                    "video_id":   video_id,
                    "youtube_url": f"https://youtu.be/{video_id}",
                    "account_id": youtube_account_id or "",
                    "channel":    channel_type,
                    "title":      script.get("youtube_title", ""),
                    "at":         int(time.time()),
                }
                log.info(f"Published: {summary['video_url']}")
            else:
                log.error("Upload failed.")
                return _finish(summary, work_dir, False)

        log.info(f"Pipeline complete! Run: {run_id}")
        return _finish(summary, work_dir, True)

    except run_state.Cancelled as e:
        log.warning(f"Pipeline cancelled: {e}")
        summary["error"] = "cancelled by user"
        summary["cancelled"] = True
        return _finish(summary, work_dir, False)
    except Exception as e:
        log.exception(f"Pipeline crashed: {e}")
        summary["error"] = repr(e)
        return _finish(summary, work_dir, False)


def _finish(summary, work_dir, ok):
    summary["finished_at"] = datetime.datetime.now().isoformat(timespec="seconds")
    summary["ok"] = ok
    try:
        # Atomic write — worker restart mid-write used to corrupt
        # this file, and backend/jobs.py reads it on the next boot
        # to recover a run's terminal state. Write to .tmp + rename.
        _sum_path = os.path.join(work_dir, "run_summary.json")
        _sum_tmp = _sum_path + ".tmp"
        with open(_sum_tmp, "w") as f:
            json.dump(summary, f, indent=2)
        os.replace(_sum_tmp, _sum_path)
    except OSError as e:
        log.warning(f"Could not write run_summary.json: {e}")
    run_state.finish(
        ok=ok,
        video_path=summary.get("final_video"),
        video_url=summary.get("video_url"),
        error=summary.get("error"),
    )
    return ok


def main():
    parser = argparse.ArgumentParser(description="YouTube Automation Agent")
    parser.add_argument("--schedule", action="store_true", help="Run daily on schedule")
    parser.add_argument("--dry-run", action="store_true", help="Skip upload step")
    parser.add_argument("--channel", choices=["horror", "wisdom"], help="Override channel type")
    parser.add_argument("--count", type=int, default=None, help="Number of videos to produce")
    args = parser.parse_args()

    # CLI flags > settings.json > module defaults.
    s = config.load_settings().get("content", {})
    count = args.count or int(s.get("videos_per_run", config.VIDEOS_PER_RUN))
    channel = args.channel or s.get("channel") or config.CHANNEL_TYPE

    # ── Preflight: fail fast on missing keys / binaries ──
    try:
        config.preflight(skip_upload=args.dry_run)
    except config.PreflightError as e:
        log.error(str(e))
        sys.exit(2)

    if args.schedule:
        import schedule

        def job():
            try:
                for _ in range(count):
                    run_pipeline(channel_type=channel, dry_run=args.dry_run)
                    time.sleep(30)
            except KeyboardInterrupt:
                raise
            except Exception:
                # Never let one bad run kill the scheduler loop.
                log.exception("Scheduled job crashed; will retry on next interval.")

        schedule.every().day.at("10:00").do(job)
        log.info(f"Scheduler started. Will run daily at 10:00 AM ({count} video(s)).")
        while True:
            try:
                schedule.run_pending()
            except Exception:
                log.exception("schedule.run_pending crashed; sleeping and continuing.")
            time.sleep(60)
    else:
        success_count = 0
        for i in range(count):
            if count > 1:
                log.info(f"\n>>> Video {i+1} of {count}")
            ok = run_pipeline(channel_type=channel, dry_run=args.dry_run)
            if ok:
                success_count += 1
            if i < count - 1:
                time.sleep(15)

        log.info(f"\nDone. {success_count}/{count} videos succeeded.")
        sys.exit(0 if success_count == count else 1)


if __name__ == "__main__":
    main()

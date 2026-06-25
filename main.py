import truststore
truststore.inject_into_ssl()


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


def _step(summary, name, fn):
    """Time a pipeline step, record it in summary, and emit progress to run_state."""
    run_state.check_cancel()
    run_state.step_started(name)
    t0 = time.time()
    try:
        result = fn()
        summary["steps"][name] = {"ok": result is not None and result is not False, "seconds": round(time.time() - t0, 2)}
        run_state.step_done(name)
        run_state.check_cancel()
        return result
    except run_state.Cancelled:
        summary["steps"][name] = {"ok": False, "seconds": round(time.time() - t0, 2), "error": "cancelled"}
        raise
    except Exception as e:
        summary["steps"][name] = {"ok": False, "seconds": round(time.time() - t0, 2), "error": repr(e)}
        raise


def run_pipeline(channel_type=None, dry_run=False):
    """
    Execute the full automation pipeline for one video.
    Returns True on success, False on failure.
    """
    channel_type = channel_type or config.CHANNEL_TYPE
    run_id = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    work_dir = os.path.join("output", "videos", run_id)
    Path(work_dir).mkdir(parents=True, exist_ok=True)

    summary = {
        "run_id": run_id,
        "channel": channel_type,
        "dry_run": dry_run,
        "started_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "steps": {},
    }

    log.info("=" * 50)
    log.info(f"Starting pipeline | channel={channel_type} | run={run_id}")
    log.info("=" * 50)

    run_state.start(run_id=run_id, channel=channel_type, dry_run=dry_run)

    try:
        # ── STEP 1: Research ──────────────────────────────────────
        log.info("[1/6] Researching content...")
        content = _step(summary, "research", lambda: research(channel_type))
        if not content:
            log.error("Research failed. Aborting.")
            return _finish(summary, work_dir, False)
        log.info(f"Topic: {content['raw_title'][:80]}")

        # ── STEP 2: Script ────────────────────────────────────────
        log.info("[2/6] Writing script with LLM...")
        script = _step(summary, "script", lambda: write_script(content))
        if not script:
            log.error("Script generation failed. Aborting.")
            return _finish(summary, work_dir, False)
        log.info(f"Title: {script.get('youtube_title')}")
        log.info(f"Script length: {len(script.get('narration','').split())} words")

        # ── STEP 3: Voiceover ─────────────────────────────────────
        log.info("[3/6] Generating voiceover...")
        audio_dir = os.path.join(work_dir, "audio")
        audio_path = _step(summary, "voiceover", lambda: generate_voiceover(script["narration"], channel_type, audio_dir))
        if not audio_path:
            log.error("Voiceover generation failed. Aborting.")
            return _finish(summary, work_dir, False)

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
        shots = plan_shots(script["narration"], num_shots)
        footage = None

        if shots:
            assign_timing(shots, voice_seconds)
            for i, sh in enumerate(shots):
                log.info(f"  shot {i+1}: [{sh['start']:.1f}-{sh['end']:.1f}s] "
                         f"{sh['search_query']!r}")
            summary["shots"] = shots
            sources = _step(summary, "footage", lambda: fetch_shots(
                shots, clips_dir, channel=channel_type,
            ))
            # Music separately — same provider chain as before, just no images.
            from modules.footage import get_music, MUSIC_KEYWORDS
            from modules.config import load_settings as _ls
            music_q = (_ls().get("music_keywords") or {}).get(channel_type) \
                       or MUSIC_KEYWORDS.get(channel_type, "background music")
            music = get_music(music_q, clips_dir)
            footage = {"sources": sources, "music": music}
        else:
            # Storyboard failed. This is a DEGRADED mode — the keyword
            # pool produces generic shots that aren't tied to specific
            # lines of narration. We log loudly and record it in the
            # summary so the GUI can flag it.
            log.warning("=" * 70)
            log.warning("  STORYBOARD UNAVAILABLE — falling back to keyword-pool footage.")
            log.warning("  Clips will be on-genre but NOT aligned to specific narration lines.")
            log.warning("  Causes: NIM key missing, NIM timeout, or all shots malformed.")
            log.warning("=" * 70)
            summary["storyboard_fallback"] = True
            story_keywords = script.get("search_keywords") or []
            sources_needed = num_shots
            footage = _step(summary, "footage", lambda: get_footage(
                channel_type, clips_dir,
                sources_needed=sources_needed,
                extra_keywords=story_keywords,
                premise=content.get("raw_title") or "",
            ))

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
        ))
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
            video_id = _step(summary, "upload", lambda: upload_video(final_video, script, channel_type))
            if video_id:
                summary["video_id"] = video_id
                summary["video_url"] = f"https://youtu.be/{video_id}"
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
        with open(os.path.join(work_dir, "run_summary.json"), "w") as f:
            json.dump(summary, f, indent=2)
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

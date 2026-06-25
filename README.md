# YT Agent

End-to-end automation for gothic-horror YouTube Shorts.

Story → narration → voiceover → storyboard → vision-validated images →
caption-burned video → upload. All from a one-command launcher.

```
python launch.py
```

That starts both servers and opens **http://localhost:3000** in your browser.

---

## Stack

| Layer        | Tech |
|--------------|------|
| Frontend     | **Next.js 16** (App Router, Turbopack) · **React 19** · **Tailwind v4** · TypeScript 6 |
| Backend API  | **FastAPI** on `:8000` (proxied by Next.js dev at `/api/*`) |
| LLM (script + storyboard) | **NVIDIA NIM** — `nvidia/nemotron-3-super-120b-a12b` (reasoning off by default) · Groq llama-3.3-70b as fallback |
| Vision judge | NVIDIA NIM — `meta/llama-3.2-11b-vision-instruct` (scores stock previews before licensing) |
| TTS          | edge-tts (default) · kokoro (local, optional) |
| Footage      | Shutterstock (vision-gated) · Pexels · Coverr · Pixabay · Openverse · Pollinations AI |
| Video        | ffmpeg (libx264 + ASS captions + sidechain ducking + Ken Burns + grade + grain) |
| Music        | Pixabay + Openverse |
| Upload       | YouTube Data API v3 (OAuth2) |

---

## Project layout

```
yt_agent/
├── launch.py              one-command start (backend + frontend)
├── main.py                pipeline orchestrator (also a CLI entry point)
├── requirements.txt       Python deps
├── .env                   API keys (gitignored)
│
├── backend/               FastAPI server
│   └── server.py          /api/* endpoints (settings, keys, run, state, runs/, …)
│
├── modules/               Python pipeline (untouched by frontend choices)
│   ├── config.py          settings.json + .env + preflight
│   ├── nim.py             NVIDIA NIM client (streaming, rate-limited, vision)
│   ├── scriptwriter.py    LLM → narration + youtube_title + tags
│   ├── storyboard.py      LLM → shot list with per-shot visual + queries
│   ├── shotfinder.py      per-shot, multi-provider, vision-validated image picker
│   ├── image_prompter.py  story-specific text-to-image prompt crafting
│   ├── footage.py         providers (Shutterstock/Pexels/Coverr/Pixabay/Openverse/Pollinations)
│   ├── voiceover.py       edge-tts + kokoro TTS
│   ├── editor.py          ffmpeg assembly: motion + grade + grain + captions + ducking
│   ├── researcher.py      premise generator (horror) + RSS/pytrends (wisdom)
│   ├── thumbnail.py       Pillow-based YouTube thumbnails
│   ├── uploader.py        OAuth + chunked YouTube upload
│   ├── run_state.py       JSON file the frontend polls for live progress
│   └── _net.py            retry helper (exponential backoff)
│
├── web/                   Next.js 16 dashboard
│   ├── app/
│   │   ├── layout.tsx     shell with sidebar
│   │   ├── globals.css    Tailwind v4 @theme + component classes
│   │   ├── page.tsx       Dashboard (run + live progress + last result)
│   │   ├── settings/      Tabbed settings (Content/Voice/Video/Upload/Keywords)
│   │   ├── history/       Past runs + embedded video + storyboard view
│   │   └── keys/          .env management
│   ├── components/Sidebar.tsx
│   ├── lib/api.ts         typed fetch wrappers
│   ├── package.json
│   ├── postcss.config.mjs
│   ├── next.config.js
│   └── tsconfig.json
│
├── tests/                 pytest (28 tests covering caption chunking, segment planner,
│                          scriptwriter validation, storyboard timing, word captions)
├── config/                settings.json + client_secret.json + youtube_token.json
├── data/                  used_premises.json, used_clips.json, run_state.json
├── logs/                  daily agent logs
└── output/                generated runs (one folder per video)
```

---

## First-time setup

```powershell
# 1. Python deps (~1 min)
pip install -r requirements.txt

# 2. ffmpeg + ffprobe on PATH
winget install Gyan.FFmpeg     # or: choco install ffmpeg

# 3. Node 20+ (one-time check)
node --version

# 4. Launch — runs `npm install` automatically on first start
python launch.py
```

Then add your API keys in the GUI's **API Keys** tab (or paste straight into `.env`):

| Key                          | Why                       | Required? |
|------------------------------|---------------------------|-----------|
| `NVIDIA_NIM_API_KEY`         | LLM + vision judge        | yes       |
| `SHUTTERSTOCK_API_TOKEN`     | Premium licensed images   | recommended (500/mo free) |
| `PEXELS_API_KEY`             | Free stock video + photo  | recommended |
| `PIXABAY_API_KEY`            | Free stock + music        | recommended |
| `COVERR_API_KEY`             | Curated cinematic clips   | optional |
| `GROQ_API_KEY`               | LLM fallback              | optional |
| `YOUTUBE_CLIENT_SECRETS_FILE`| OAuth for YouTube upload  | only for non-dry runs |

---

## Usage

### Via the dashboard (recommended)

```powershell
python launch.py
```

→ open <http://localhost:3000> · pick channel + dry-run · hit **Run pipeline now**

### Via the CLI (no frontend)

```powershell
python main.py                       # one video, dry-run by default
python main.py --channel horror
python main.py --count 2
python main.py --schedule            # daily at 10:00
```

### Production mode

```powershell
python launch.py --prod              # builds Next.js then serves it
```

---

## What's smart about the pipeline

1. **Storyboard-first.** The LLM breaks the narration into ordered shots with
   per-shot `narration_excerpt`, `visual_description`, `search_query`,
   `ai_prompt`. Timing is char-weighted over the actual voiceover duration.
2. **Vision-validated image picking.** Each candidate from Shutterstock /
   Pexels is judged against THIS shot's visual description by the NIM
   11B vision model *using the free watermarked preview* — quota is only
   ever spent on images that pass.
3. **AI gen as a fallback per shot.** If no stock provider clears the bar,
   `image_prompter` writes a fresh cinematic prompt (rotating camera angle
   on each retry), Pollinations renders it, vision-judge gates it.
4. **No-repeat montage.** Each source plays exactly once, with shot-precise
   `[start, end]` timing. Image segments get cinematic motion (zoom/pan
   variants), color grade, vignette, film grain.
5. **CapCut-style captions.** Word-by-word highlight (yellow + bold +
   larger) sliding through the on-screen sentence.
6. **Live progress.** `run_state.json` is updated at each step transition;
   the dashboard polls every 1.2s.

---

## Tests

```powershell
python -m pytest tests/ -q
```

28 tests — caption chunking, segment planner, scriptwriter validation,
storyboard timing, word-event captions.

---

## Notes

- The old Streamlit GUI is gone. The Next.js dashboard is the only frontend.
- Per-run output lives in `output/videos/<run_id>/`. Each finished run has
  a `run_summary.json` plus `final_video.mp4`.
- `data/run_state.json` is overwritten on every step; safe to delete to
  reset a stuck "running" state if the bg thread ever wedges.

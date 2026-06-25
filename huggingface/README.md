---
title: YT Agent Backend (CPU)
emoji: 🎬
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
short_description: Always-on CPU fallback backend for YT Agent
---

# YT Agent — HuggingFace Space (CPU fallback)

This Space hosts the FastAPI backend for the
[YT Agent](https://github.com/YOUR_USER/yt_agent) pipeline on HF Free
CPU. It's the always-on fallback your Vercel dashboard routes to when no
Colab GPU instance is available.

## Architecture context

```
                                                  ┌─────────────────┐
                                                  │ Colab GPU       │ ⚡ fast, on-demand
                                                  └────────┬────────┘
Vercel dashboard ──reads registry──▶ Hostinger    ──┤
                                                  └────────┬────────┘
                                                  │ HF Space CPU    │ 🐢 slow, always-on (this)
                                                  └─────────────────┘
```

The frontend resolver sorts: **GPU-available → GPU-busy → CPU-available
→ CPU-busy**, so this Space only gets used when no Colab is up.

## Deploying this Space

This `huggingface/` directory IS the Space repo. To deploy:

1. Create a new Docker Space on HuggingFace (any name).
2. Set the Space's secrets (Settings → Variables and secrets) — **only the bootstrap minimum, the rest pulls from Hostinger automatically**:
   - `FTP_HOST` · `FTP_USER` · `FTP_PASS` · `PUBLIC_BASE_URL`
   - `PUBLIC_BACKEND_URL` = `https://YOUR_USER-YOUR_SPACE.hf.space`
3. Push *only this directory's contents plus the project's
   `backend/`, `modules/`, `requirements.txt`, and `main.py`* to the
   Space's repo. The `Dockerfile` in this directory will build the image.

Easiest path: clone the Space's repo, copy these files in, push.

```bash
# from this repo's root
huggingface-cli login
git clone https://huggingface.co/spaces/YOUR_USER/YOUR_SPACE
cp huggingface/Dockerfile huggingface/README.md  YOUR_SPACE/
cp -r backend modules requirements.txt main.py   YOUR_SPACE/
cd YOUR_SPACE
git add . && git commit -m "deploy yt-agent backend" && git push
```

The Space builds in ~5 min and stays warm forever. Registry auto-publishes
this Space's URL within 30s of boot.

## Why is this slow?

CPU video encoding takes ~5× wall-clock vs. GPU. A 60s gothic-horror
short renders in **~6-10 min on the free CPU tier**, vs ~1-2 min on
Colab T4. Everything else (LLM, vision, TTS) is hosted API and runs the
same speed regardless.

If you need speed, click **Launch backend** in the dashboard to fire up
a Colab GPU; this Space stays as the safety net.

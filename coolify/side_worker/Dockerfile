# Oracle-hosted side-worker.
#
# Now supports TWO job kinds:
#   1. Side-jobs (publish_youtube / copy_storage) — original purpose.
#   2. Full CPU renders — fallback when Kaggle+Colab are both offline
#      AND the channel's allowed_workers list includes "oracle" AND
#      the channel's Oracle password matches. local_sdxl is CPU-hostile,
#      so shotfinder auto-skips it (torch.cuda.is_available() is False)
#      and image gen falls through to pollinations → HF → horde.
#
# We deliberately skip torch / diffusers / decord — a full CPU-only
# pipeline still ships in under 500 MB.
#
# Playwright IS installed (below). It was previously skipped here on the
# same "keep the image small" reasoning, but modules/research_agent is
# wired into main.py and gates on browser_agent.is_available(): with
# Playwright absent, EVERY Oracle render silently logged "playwright
# unavailable — skipping" and did no browser research at all. Since
# Oracle serves most renders, the research capability was effectively
# dead in production while appearing configured. ~120 MB of chromium is
# worth far less than a silently disabled feature.
FROM python:3.11-slim

# system deps: ffmpeg (video assembly + duration probe),
# imagemagick + fonts (subtitle burn-in via Pillow), curl for healthchecks.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg imagemagick ca-certificates curl git \
        fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji \
        libjpeg-dev libpng-dev libfreetype6-dev && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy repo
COPY backend/                          /app/backend/
COPY modules/                          /app/modules/
COPY main.py                           /app/main.py
COPY requirements.txt                  /app/requirements.txt
COPY coolify/side_worker/entrypoint.py /app/entrypoint.py

# CPU render deps. requirements.txt covers most of it; we skip the
# transformers/diffusers pins on purpose (torch stack is intentionally
# absent, so those pins are unreachable and would just bloat the image).
# Kokoro is GPU-only; edge-tts covers CPU TTS.
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
        # Original side-job deps
        requests>=2.31 \
        psutil>=5.9 \
        boto3>=1.34 \
        paramiko>=3.4 \
        google-api-python-client>=2.100 \
        google-auth>=2.28 \
        google-auth-oauthlib>=1.2 \
        google-auth-httplib2>=0.2 \
        python-dotenv>=1.0 \
        cryptography>=45.0.0 \
        pyOpenSSL>=25.0.0 \
        pynacl>=1.5 \
        # Browser research (modules/browser_agent + research_agent).
        # The chromium binary is fetched in a separate RUN below.
        playwright>=1.40 \
        # Render deps (CPU path only)
        fastapi>=0.115 \
        uvicorn[standard]>=0.30 \
        pydantic>=2.6 \
        firebase-admin>=6.4 \
        edge-tts>=7.0.0 \
        pytrends>=4.9.2 \
        feedparser>=6.0.11 \
        pillow>=10.0 \
        schedule>=1.2 \
        moviepy>=1.0.3 \
        ffmpeg-python>=0.2.0 \
        imageio>=2.34 \
        imageio-ffmpeg>=0.5 \
        numpy>=1.26 \
        soundfile>=0.12 \
        pydub>=0.25 \
        beautifulsoup4>=4.12 \
        lxml>=5.0 \
        truststore>=0.9 \
        # Cross-platform file lock for used_premises + used_clips
        # concurrency (audit fix #9). Same version pin as requirements.txt.
        filelock>=3.12

# Chromium for Playwright. Separate RUN so a dependency change does not
# re-download 120 MB.
#
# --with-deps matters: the slim base lacks the shared libraries headless
# chromium needs. browser_agent.is_available() launches and closes a
# real browser rather than just importing, so a missing library is
# caught correctly — but it is caught by DISABLING research silently,
# which is precisely how this went unnoticed in production.
RUN python -m playwright install --with-deps chromium

# Env flag consumed by shotfinder + main to short-circuit GPU probes
# faster (torch isn't installed, so imports fail immediately anyway,
# but this shaves a couple of seconds off boot).
ENV YT_AGENT_CPU_ONLY=1

CMD ["python", "-u", "/app/entrypoint.py"]

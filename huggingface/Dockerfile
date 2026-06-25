# Hugging Face Spaces — Docker SDK
# This Dockerfile is what HF builds when you push to your Space's repo.
# Same FastAPI app as backend/server.py, just bound to port 7860 (HF's default).
FROM python:3.11-slim

# ── System deps ───────────────────────────────────────────────
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# HF Spaces requires a non-root user named "user" with UID 1000 for
# write access to /data and other Space-mounted volumes.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    INSTANCE_TIER=cpu \
    INSTANCE_LABEL=hf-space-cpu \
    IDLE_TIMEOUT_SECONDS=0

WORKDIR $HOME/app

# ── Python deps ───────────────────────────────────────────────
COPY --chown=user:user requirements.txt ./
RUN pip install --user --no-cache-dir -q -r requirements.txt

# ── App code ──────────────────────────────────────────────────
# Only copy what we actually need on the backend. The web/ dir is
# Vercel's concern; tests are local-only.
COPY --chown=user:user backend ./backend
COPY --chown=user:user modules ./modules
COPY --chown=user:user main.py ./

# HF maps a writable /data volume — we use it for run state + outputs
# so they persist across container restarts.
RUN mkdir -p $HOME/app/data $HOME/app/logs $HOME/app/output \
             $HOME/app/Config

# HF Spaces serves on port 7860 by default.
EXPOSE 7860

CMD ["uvicorn", "backend.server:app", "--host", "0.0.0.0", "--port", "7860", "--log-level", "info"]

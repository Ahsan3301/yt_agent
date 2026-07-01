# Oracle-hosted side-worker — publishes videos to YouTube + mirrors
# to storage providers. NO rendering happens here (that stays on
# Kaggle/Colab GPU). This image only needs Python + requests +
# psutil + google-api-python-client + boto3 + the repo's backend/
# and modules/ directories.

FROM python:3.11-slim

# system deps needed at runtime — ffmpeg for probing video duration,
# ca-certificates for Google API SSL, curl for healthchecks.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy repo — same as the dashboard image copies for its build.
COPY backend/                  /app/backend/
COPY modules/                  /app/modules/
COPY main.py                   /app/main.py
COPY requirements.txt          /app/requirements.txt
COPY coolify/side_worker/entrypoint.py /app/entrypoint.py

# Only install what the side-jobs actually need. Skip torch/decord/av
# and playwright — those are for rendering, which this worker never does.
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
        requests>=2.31 \
        psutil>=5.9 \
        boto3>=1.34 \
        paramiko>=3.4 \
        google-api-python-client>=2.100 \
        google-auth>=2.28 \
        google-auth-oauthlib>=1.2 \
        google-auth-httplib2>=0.2 \
        pillow>=10.0 \
        python-dotenv>=1.0 \
        cryptography>=41 \
        pynacl>=1.5

CMD ["python", "-u", "/app/entrypoint.py"]

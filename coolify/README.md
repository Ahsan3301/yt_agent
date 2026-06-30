# yt-agent on Coolify

Self-hosted deployment for users with a Coolify server (Oracle ARM
free tier, Hetzner CX22, anything that runs Docker).

This stack replaces the previous Vercel + Firebase + Cloudflare R2
deployment with self-hosted equivalents — same features, same code,
your data lives on your VPS.

## Architecture

```
your-domain.com
   └─ Caddy (TLS + path routing)
        ├─ /          → Next.js dashboard       (port 3000)
        ├─ /pb/       → Pocketbase             (port 8090)
        ├─ /s3/       → MinIO S3 API           (port 9000)
        └─ /minio/    → MinIO admin console    (port 9001)

cron-sidecar (no public port) → curls /api/maintenance/* on schedule
```

Coolify treats this docker-compose stack as a single application —
one log panel, one redeploy button.

## What you need first

- A VPS with Docker + Coolify installed (this guide assumes Coolify 4+).
- At least 4 GB RAM (8+ recommended).
- A domain name with an A record pointing at the VPS public IP.
- (For uploads) A Google Cloud OAuth client — see `USER_GUIDE.docx`
  Chapter 8 for the walkthrough.

## Setup steps

### 1. Add the repo as an Application in Coolify

1. Coolify → Projects → New Resource → **Application**.
2. Source: **Public Repository**.
3. Repository: `https://github.com/Ahsan3301/yt_agent` (or your fork).
4. Branch: `main`.
5. Build pack: **Docker Compose**.
6. Docker Compose file location: `coolify/docker-compose.yml`.
7. Save.

### 2. Set environment variables

In the application's **Environment Variables** panel, paste every
variable from `coolify/.env.example` with real values. Use Coolify's
**Generate** button next to any field for the random-secret entries.

The most important ones:

| Var | Notes |
|---|---|
| `DOMAIN` | Your custom domain. Caddy issues TLS for this on first request. |
| `POCKETBASE_ADMIN_PASSWORD` | Pick a strong one. |
| `MINIO_ROOT_PASSWORD` | Same. |
| `PB_SERVER_TOKEN`, `RENDER_TRIGGER_KEY`, `STORAGE_PROVIDERS_ENC_KEY` | Generate with `openssl rand -hex 32`. |
| `YOUTUBE_OAUTH_CLIENT_ID` + `_SECRET` | Required to upload to YouTube. |

### 3. Point the domain

Coolify → Application → **Domains** → add `your-domain.example.com`.
Coolify wires Traefik to forward port 443 to this stack's Caddy.

### 4. Deploy

Click **Deploy**. First boot takes ~3-5 minutes (image builds + Caddy
issues TLS). Watch the log panel.

When you see `minio-init: bucket yt-agent-videos ready` and
`PocketBase v0.x.x ready to use` and `next.js Ready`, the stack is up.

### 5. First-time admin setup

1. Visit `https://your-domain.example.com/pb/_/` — log in with the
   admin email + password from your env vars.
2. Visit `https://your-domain.example.com/minio/` — log in with the
   MinIO root user + password.
3. Visit `https://your-domain.example.com/` — that's the dashboard.

### 6. Add YouTube OAuth + AI keys

Follow `USER_GUIDE.docx` Chapters 8-10 (same as Vercel deployment —
the Connections / Channels pages work identically).

**One Google-side change**: when registering the OAuth client, the
Authorised redirect URI must be:
```
https://your-domain.example.com/api/youtube/callback
```

### 7. Start a worker (Colab/Kaggle)

GPU rendering still happens on Colab + Kaggle (Oracle ARM has no GPU).
The worker now connects OUTBOUND to your dashboard instead of exposing
a tunnel. In the Colab notebook's secrets cell, set:

```
COOLIFY_BASE_URL = https://your-domain.example.com
WORKER_MODE = outbound_poll
PB_URL = https://your-domain.example.com/pb
PB_SERVER_TOKEN = <same value as the Coolify env var>
```

Then Runtime → Run all. The worker appears in `/workers` within ~30s.

## Migrating from Vercel + Firebase + R2

See `scripts/firestore_to_pocketbase.py` — idempotent one-shot that
copies every Firestore collection into your new Pocketbase instance.

Cutover sequence:
1. Deploy this Coolify stack with empty Pocketbase + MinIO.
2. Run the migration script (it has its own `--help`).
3. Smoke-test against the new dashboard URL.
4. Flip DNS at your registrar.
5. Update the YouTube OAuth redirect URI on Google's side.
6. Re-run the migration script one more time to catch deltas.
7. (Optional) Decommission the Vercel project + Firebase project.

## Day-2 operations

- **Logs**: Coolify → Application → Logs (all four services in one
  panel).
- **Redeploy after a code push**: Coolify → Application → Redeploy.
- **Backup**: `/data/pocketbase` and `/data/minio` are your data
  volumes — snapshot them on whatever schedule you like. Coolify has
  built-in volume backup if you wire it up.
- **Update Pocketbase / MinIO / Caddy versions**: edit the `image:`
  tags in `docker-compose.yml`, push, redeploy.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Caddy logs "ERR_TLS_CERT_AUTHORITY_INVALID" | Domain A record probably wrong. Check `dig your-domain.example.com` resolves to the VPS IP. |
| Dashboard loads but `/pb/_/` is 502 | Pocketbase container didn't boot. Check its logs — usually a permissions issue on `/data/pocketbase`. |
| `minio-init` keeps restarting | Bucket creation failed — usually a typo in `MINIO_ROOT_PASSWORD`. Compare with what's in the MinIO container's env. |
| Video URLs return 403 | Public-read policy didn't apply. From `/minio/` admin, set the bucket's anonymous access to "downloadable". |
| Worker doesn't appear in `/workers` | Confirm `WORKER_MODE=outbound_poll` is set on the worker side AND `PB_SERVER_TOKEN` matches what's in Coolify. |

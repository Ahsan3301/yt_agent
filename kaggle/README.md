# Kaggle on-demand GPU worker

This directory contains the Kaggle Notebook that acts as a free GPU
fallback when Colab is offline. It is **NOT always-on** — a GitHub
Actions workflow (`.github/workflows/kaggle-dispatch.yml`) wakes it
on demand whenever a render is queued in Firestore and no GPU worker
is alive.

After the queued render(s) complete and the worker has been idle for
~10 min, `backend/idle_watchdog.py` calls `os._exit(0)` to release the
GPU runner — preserving the 30 GPU hr/week free budget.

---

## One-time setup (~5 min)

### 1. Create a Kaggle account

https://www.kaggle.com/account/login

Free. Phone verification is required to enable GPU + internet on
notebooks (one-time).

### 2. Generate a Kaggle API token

https://www.kaggle.com/settings/account → scroll to **API** → click
**Create New Token**. This downloads `kaggle.json` containing:

```json
{ "username": "your_kaggle_username", "key": "abc123..." }
```

### 3. Add the token as GitHub repo secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Name | Value |
|---|---|
| `KAGGLE_USERNAME` | The `username` field from `kaggle.json` |
| `KAGGLE_KEY` | The `key` field from `kaggle.json` |

### 4. Update `kernel-metadata.json` with your Kaggle username

Open `kaggle/kernel-metadata.json` and replace the `id` field's
`REPLACE_WITH_YOUR_USERNAME` placeholder with your Kaggle username:

```json
{ "id": "your_kaggle_username/yt-agent-worker", ... }
```

Commit + push that change.

### 5. Push the notebook manually once to register the kernel

On your machine (one-time):

```bash
pip install kaggle
mkdir -p ~/.kaggle && mv ~/Downloads/kaggle.json ~/.kaggle/ && chmod 600 ~/.kaggle/kaggle.json
cd kaggle/
kaggle kernels push
```

This creates the `yt-agent-worker` notebook on your Kaggle account.
You'll be able to see it at `https://www.kaggle.com/<username>/code`.

### 6. Add Kaggle Secrets to the notebook

On Kaggle: open your `yt-agent-worker` notebook → **Add-ons →
Secrets** → click **Add a new secret**.

Add the same `GOOGLE_APPLICATION_CREDENTIALS_JSON` value you set on
Colab/HF Space (the full Firebase service-account JSON, multi-line OK).

Optionally add R2 + SFTP secrets if you want THIS worker to upload
videos (recommended).

| Required | |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Full Firebase service-account JSON |

| Optional (only if Kaggle uploads videos) | |
|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` | Cloudflare R2 |
| `SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASS`, `SFTP_BASE_DIR`, `PUBLIC_BASE_URL` | Hostinger SFTP overflow |

That's it.

---

## How it runs

```
 09:00 UTC               Vercel queues a render in Firestore
   │                          │
   ▼                          ▼
 scheduled-render.yml      jobs/<id> { status: queued, backend_instance_id: null }
                              │
 every 10 min                 │
   ▼                          ▼
 kaggle-dispatch.yml ───── GET /api/maintenance/needs-worker
                              │
                              ▼  needs_worker = true
                          kaggle kernels push
                              │
                              ▼
                          Kaggle starts the notebook on a T4 / P100 ─┐
                              │                                      │
                              ▼                                      │
                          Notebook bootstrap (1-2 min)              │ 30 GPU
                              │                                      │ hr/week
                              ▼                                      │ budget
                          Worker registers in Firestore backends     │
                              │                                      │
                              ▼                                      │
                          claim_queued → run pipeline → upload       │
                              │                                      │
                              ▼                                      │
                          notifier.info("Pipeline complete")         │
                              │                                      │
                              ▼                                      │
                          idle 10 min → os._exit(0) ─────────────────┘
```

---

## Budget math

| Resource | Per render | Per week | Free tier |
|---|---|---|---|
| Kaggle GPU hours | ~5-8 min | ~3 hours (for 20+ renders/wk) | 30 hr |
| GitHub Actions runs | 1 dispatch | ~1000 (every 10 min) | 2000 min |
| Vercel invocations | 1 `/needs-worker` | ~1000 | 100K/day |
| Firestore reads | ~5 | ~5000 | 50K/day |

Comfortable headroom on every axis.

---

## Troubleshooting

**"Push failed: 403 forbidden"** in the dispatch workflow log →
`kernel-metadata.json` `id` field still says `REPLACE_WITH_YOUR_USERNAME`,
or the GitHub repo secrets don't match the `kaggle.json` you generated.

**Notebook starts but never registers in Firestore** → Kaggle Secrets
panel is missing `GOOGLE_APPLICATION_CREDENTIALS_JSON`, or you didn't
toggle the "attach to this notebook" checkbox after adding the secret.

**Worker self-terminates immediately after start** → the queue had no
queued jobs by the time the notebook booted (the cron + boot delay can
race). Push a fresh render from the dashboard and the next 10-min cron
tick will spin it back up.

**Kaggle GPU hours used up too fast** → check
`KAGGLE_AUTO_SHUTDOWN_AFTER_IDLE_SECONDS` in the bootstrap cell. Lower
it (e.g. 300 = 5 min) for tighter discipline, or set it to 60 to
shut down as soon as the queue is empty.

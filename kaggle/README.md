# Kaggle on-demand GPU worker

This directory contains the Kaggle Notebook that acts as a free GPU
fallback when Colab is offline. It is **NOT always-on** — a GitHub
Actions workflow (`.github/workflows/kaggle-dispatch.yml`) OR the
in-cluster cron sidecar wakes it on demand whenever a render is
queued and no GPU worker is alive.

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

### 6. Ship credentials — Dataset is RECOMMENDED over Secrets

Every `kaggle kernels push` creates a new kernel **version**. The
Secrets panel doesn't always carry over reliably across versions, so
the production path is:

1. Create a **private** Kaggle Dataset called `yt-agent-secrets`
   (https://www.kaggle.com/datasets → New Dataset → uncheck "Public")
2. Upload **one file** called `secrets.env` containing:

   ```
   COOLIFY_BASE_URL=https://yt-agent.thyker.online
   PB_URL=https://yt-agent.thyker.online/pb
   POCKETBASE_ADMIN_EMAIL=admin@yt-agent.thyker.online
   POCKETBASE_ADMIN_PASSWORD=your-strong-password
   RENDER_TRIGGER_KEY=<same 32-byte hex as Coolify>
   STORAGE_PROVIDERS_ENC_KEY=<same 32-byte hex as Coolify>
   ```

3. Confirm `kaggle/kernel-metadata.json` lists the dataset under
   `dataset_sources`:

   ```json
   "dataset_sources": ["<your-kaggle-username>/yt-agent-secrets"]
   ```

   Kaggle auto-attaches this dataset to every kernel version, so the
   notebook always sees `/kaggle/input/yt-agent-secrets/secrets.env`.

The notebook reads `secrets.env` at boot — no manual re-attach after
each auto-trigger.

#### Alternative: Kaggle Secrets panel (works but flaky on auto-dispatch)

Add-ons → Secrets → same key names as the .env file. Useful for
interactive testing; less reliable for the auto-trigger workflow.

#### Legacy Vercel + Firestore deployment

Add `GOOGLE_APPLICATION_CREDENTIALS_JSON_B64` (base64-encoded JSON —
Kaggle truncates multi-line secrets) to either the Dataset .env OR
the Secrets panel.

That's it.

---

## Auto-trigger from the dashboard

You DON'T have to run the Kaggle notebook manually. A GitHub Actions
cron (`.github/workflows/kaggle-dispatch.yml`) runs every 5 minutes
and:

1. Calls `${DASHBOARD_BASE_URL}/api/maintenance/needs-worker` on your
   dashboard
2. If response says `needs_worker: true` → runs `kaggle kernels push`
   to spin up a fresh GPU notebook
3. The pushed kernel boots, attaches the `yt-agent-secrets` Dataset,
   and the worker registers in the dashboard within ~60 sec

**One-time setup on the GitHub repo side** (Settings → Secrets and
variables → Actions):

| Type | Name | Value |
|---|---|---|
| Variable | `DASHBOARD_BASE_URL` | `https://yt-agent.thyker.online` *(falls back to `VERCEL_BASE_URL` if you only set that one)* |
| Variable | `VERCEL_BASE_URL` | Same value as above — kept as alias for legacy users |
| Secret | `RENDER_TRIGGER_KEY` | Same 32-byte hex as your Coolify env var |
| Secret | `KAGGLE_USERNAME` | From `kaggle.json` |
| Secret | `KAGGLE_KEY` | From `kaggle.json` |

The dashboard's "Auto-wake Kaggle" toggle lives at
**/settings → Schedule** — turn it off if you want to manage GPU
sessions manually.

## Render-trigger flow

```
 09:00 UTC               Dashboard cron queues today's jobs
   │                          │
   ▼                          ▼
 scheduled-render.yml      jobs/<id> { status: queued, backend_instance_id: null }
                              │
 every 5 min                  │
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

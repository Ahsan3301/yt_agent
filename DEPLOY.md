# Deploying YT Agent

This is the production layout described in your spec:

- **Frontend** on Vercel (auto-deploy from GitHub)
- **Backend** on Google Colab free GPU tier (Cloudflare quick tunnel)
- **Storage** on Hostinger via FTP/FTPS (videos + a shared registry.json)
- Multi-Colab fallback via the registry

```
GitHub ─▶ Vercel (Next.js) ──reads── Hostinger /registry.json
                       │
                       └─routes to──▶ chosen Colab tunnel ──┐
                                                            │
                                            uploads MP4 ────┴─▶ Hostinger /videos/
```

---

## 0. One-time Hostinger setup

1. In your Hostinger File Manager, create a folder: `public_html/yt-agent/`
2. Inside it, create an empty file `registry.json` containing `[]`. (Colab
   will overwrite it on first heartbeat — but the file must exist with
   permission `644` so Vercel can fetch it over HTTPS.)
3. Grab FTP credentials from **Hostinger → Hosting → Files → FTP Accounts**:
   - host (e.g. `ftp.yourdomain.com`)
   - user (often starts with `u`)
   - password
4. Confirm `https://yourdomain.com/yt-agent/registry.json` returns `[]`
   in a browser. If it doesn't, check `.htaccess` rules / directory perms.

---

## 1. Push the repo to GitHub

```powershell
git init
git add .
git commit -m "yt-agent: initial commit"
git branch -M main
git remote add origin https://github.com/<you>/yt_agent.git
git push -u origin main
```

`.gitignore` is already set to keep `.env`, `output/`, `data/`, OAuth
client secrets, and `web/node_modules/` out of the repo.

---

## 2. Deploy the frontend on Vercel

1. https://vercel.com/new → import the GitHub repo
2. **Framework Preset**: Next.js
3. **Root directory**: `web`
4. **Environment Variables** (Production):

   Set these two:

   | Key                          | Value                                                                                       |
   |------------------------------|---------------------------------------------------------------------------------------------|
   | `NEXT_PUBLIC_REGISTRY_URL`   | `https://yourdomain.com/yt-agent/registry.json`                                              |
   | `NEXT_PUBLIC_COLAB_URL`     | `https://colab.research.google.com/github/<your-user>/yt_agent/blob/main/colab/yt_agent_colab.ipynb` |

   `NEXT_PUBLIC_COLAB_URL` powers the dashboard's **"Launch backend"**
   button — when no Colab is registered, the banner shows that button.
   One click opens the notebook in a new tab; you then hit
   *Runtime → Run all*. The dashboard polls the registry every 5s and
   removes the banner automatically once the tunnel registers.

   **Do NOT set `NEXT_PUBLIC_BACKEND_URL`** — Vercel rejects empty values
   and the registry already resolves the backend dynamically. The override
   only exists for local dev / single-known-backend testing.

5. **Deploy.** Vercel gives you a `*.vercel.app` URL. The FastAPI CORS
   layer already allows `https://*.vercel.app` so it works out of the box.

---

## 3. Launch a Colab backend

1. Open `colab/yt_agent_colab.ipynb` in Colab
   (File → Open notebook → GitHub → paste your repo URL → pick `colab/yt_agent_colab.ipynb`)
2. **Runtime → Change runtime type → T4 GPU** (free)
3. **🔑 Secrets** panel (left rail): add every key in `colab/secrets.example`
   with "Notebook access" toggled on.
4. Edit the `REPO_URL` constant in cell 2 to point at your fork.
5. Run all cells top-to-bottom. The last cell is `uvicorn` — leave it running.
6. Within ~30s of the tunnel URL appearing, the registry on Hostinger is
   updated. The Vercel dashboard's next backend call picks up the new URL
   automatically.

Tab to https://your-vercel-app.vercel.app/ → status pill shows
**AVAILABLE** with your Colab instance id.

### Running a second Colab for failover

Open a new browser profile (or incognito) and repeat step 3. The second
instance registers itself with a different `instance_id`. The frontend
sorts entries:
1. Status `available` before `busy`
2. Lowest `queue_depth` first

So if Colab #1 is busy on a long render, Colab #2 picks up new jobs
immediately. No code change needed.

---

## 4. (Optional) HuggingFace Space — always-on CPU fallback

The Colab path is fast but only runs when you click. If you want a
backend that's reachable 24/7 (even if slow), deploy a free HF Docker
Space as a parallel registry entry. The frontend resolver already prefers
GPU → so Colab takes precedence when available; HF only handles requests
when no Colab is up.

**Speed reality check:** CPU video encoding on the HF free tier is ~5-10×
slower than Colab T4. A 60s short renders in ~6-10 min. Everything else
(LLM, vision, TTS) is hosted API — same speed regardless of tier.

### Steps

1. **Create the Space:** https://huggingface.co/new-space →
   - Owner: your HF account
   - Space name: `yt-agent-backend` (or anything)
   - License: choose any
   - Space SDK: **Docker**
   - Hardware: **CPU basic — Free**
   - Visibility: Private (recommended)

2. **Set secrets** (Settings → *Variables and secrets*) — **only the bootstrap minimum**:

   | Secret                       | Value                                    |
   |------------------------------|------------------------------------------|
   | `FTP_HOST`                   | `ftp.yourdomain.com`                      |
   | `FTP_USER`                   | your Hostinger FTP user                   |
   | `FTP_PASS`                   | your Hostinger FTP password               |
   | `PUBLIC_BASE_URL`            | `https://yourdomain.com/yt-agent`         |
   | `PUBLIC_BACKEND_URL`         | `https://YOUR_USER-YOUR_SPACE.hf.space`   |

   That's it. **All API keys (NIM, Shutterstock, Pexels, …) come from the
   dashboard's API Keys page** — Vercel writes them to `keys.json` on
   Hostinger, this Space pulls them on startup. One source of truth.

   Other env vars (already baked into the Dockerfile as defaults):
   `INSTANCE_TIER=cpu`, `IDLE_TIMEOUT_SECONDS=0` (never auto-shutdown).

3. **Push the code.** Clone the Space's empty Git repo, copy in the files,
   commit, push:
   ```bash
   huggingface-cli login
   git clone https://huggingface.co/spaces/YOUR_USER/yt-agent-backend hf-space
   cp huggingface/Dockerfile huggingface/README.md huggingface/.dockerignore  hf-space/
   cp -r backend modules requirements.txt main.py                             hf-space/
   cd hf-space
   git add . && git commit -m "deploy" && git push
   ```

4. **Build + boot.** HF builds the image (~3-5 min) then runs `uvicorn`.
   Within ~30s the Space registers itself in `registry.json` with
   `tier: "cpu"`. Your dashboard sees it.

5. **Verify.** When no Colab is online and you submit a job, the dashboard
   shows a small amber banner: *"CPU fallback running — renders take
   5-10 min. Launch a Colab GPU for ~10× faster."* The job still completes
   and the video gets uploaded to Hostinger normally.

### When does the HF Space actually run jobs?

| State | What handles the job |
|---|---|
| Colab GPU available  | Colab (HF idle)            |
| Colab GPU busy on N jobs | Colab (HF waits) — GPU still beats CPU even queued |
| No Colab registered      | HF Space (slow but works)  |
| Both offline             | Dashboard shows red "Launch backend" |

---

## 5. Idle auto-shutdown (preserves Colab free-tier hours)

The backend self-terminates when there's nothing to do, so an open Colab
session can't burn your daily compute budget overnight.

**How it decides "idle":**
- Every HTTP request from any user (including the dashboard's status
  polling every 4s) counts as activity.
- A finished job counts as activity.
- A queued or running job means "not idle, ever."

**Defaults** (configurable per Colab secret):
- `IDLE_TIMEOUT_SECONDS = 600` — 10 minutes of total silence triggers shutdown
- `IDLE_STARTUP_GRACE = 300` — first 5 minutes after boot are immune (gives you time to submit a job)
- `IDLE_CHECK_INTERVAL = 30` — how often the watchdog checks

**What shutdown does** (in order):
1. Deregister from the Hostinger registry → frontend stops routing to this instance.
2. If running in Colab, calls `google.colab.runtime.unassign()` to release the GPU immediately.
3. Exits the FastAPI process; the notebook cell ends naturally.

**To disable auto-shutdown** (e.g. when you want a Colab session that
stays up while you iterate): set `IDLE_TIMEOUT_SECONDS=0` in the Colab
secrets and re-run cell 4. Not recommended on free tier.

**Watching the countdown:** `GET /api/queue` returns `auto_shutdown_in` (seconds).

---

## 6. Verifying the chain end-to-end

| Step | What to check |
|---|---|
| 1. Colab cell 5 prints `Public backend URL: https://x.trycloudflare.com` | tunnel is up |
| 2. Hit `<that-url>/api/health` in a browser → `{"ok":true}` | FastAPI is reachable |
| 3. After ~30s, `https://yourdomain.com/yt-agent/registry.json` shows your instance | heartbeat works |
| 4. Vercel dashboard status pill is **AVAILABLE** | frontend resolved registry |
| 5. Submit a job from the dashboard → progress bar advances | full chain works |
| 6. When done, the video plays from `https://yourdomain.com/yt-agent/videos/<run>.mp4` | FTP upload worked |

---

## 7. Local development (no Colab, no Vercel)

Same as before — `python launch.py` runs the backend on `:8000` and the
Next.js dev server on `:3000`. Set neither `NEXT_PUBLIC_BACKEND_URL` nor
`NEXT_PUBLIC_REGISTRY_URL`; the dev server proxies `/api/*` to localhost.

You can leave FTP credentials unset locally — `storage.is_configured()`
returns False and uploads are silently skipped. The video stays in
`output/videos/<run>/final_video.mp4` and the dashboard streams it
directly from the backend.

---

## 8. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `registry.json` 403 from Vercel | Hostinger `.htaccess` deny rules — allow `Content-Type: application/json` and `Access-Control-Allow-Origin: *` on the folder. |
| Dashboard shows "no backend available" | Colab cell 5 didn't print a URL, OR the heartbeat hasn't run yet (wait 30-60s after cell 6 starts). |
| Cloudflared error: `failed to connect to the edge` | Quick tunnels are sometimes rate-limited; just re-run the cell — a new URL is generated. |
| FTP upload fails with `ECONNREFUSED` | Hostinger blocks FTPS on some plans. Set `FTP_USE_TLS=0` to fall back to plain FTP. |
| Vercel deployment can't reach the Colab backend | The CORS origin regex covers `*.vercel.app`. If you use a custom domain, add it to `ALLOWED_ORIGINS` on the backend. |
| Backend gets killed after 12 hours | Colab free tier max session length. Start a fresh notebook; the new instance registers automatically. |

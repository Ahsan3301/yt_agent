import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import {
  pickWorkers, newRequestId, logRoute, upsertJob,
  lookupIdempotent, storeIdempotent,
} from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";   // never cache; this is orchestration
export const runtime = "nodejs";          // firebase-admin needs node runtime

/**
 * GET /api/jobs — list recent jobs from Firestore (most-recent first).
 * Replaces the old behaviour of polling each backend for its local jobs.
 */
// Module-level cache: serves identical responses to bursty polling
// (the dashboard polls every 1-4 sec) without re-reading Firestore.
// TTL is short enough that progress updates still feel live but long
// enough to soak the polling spam from multiple browser tabs.
//
// Firestore free tier is 50K reads/day; the dashboard's old behaviour
// was 50 reads * 50 polls/min = 150K reads/hour. This cache caps it
// at 50 reads / 3 sec = 60K reads/hour worst-case, and in practice
// far less because most polls hit the cache.
const _CACHE_TTL_MS = 3000;
const _LIST_LIMIT = 20;
let _cachedList: { at: number; body: unknown[] } | null = null;

export async function GET() {
  const reqId = newRequestId();
  // Cache hit?
  if (_cachedList && Date.now() - _cachedList.at < _CACHE_TTL_MS) {
    return NextResponse.json(_cachedList.body, {
      headers: { "X-Cache": "HIT", "Cache-Control": "no-store" },
    });
  }
  try {
    const snap = await adminDb()
      .collection("jobs")
      .orderBy("queued_at", "desc")
      .limit(_LIST_LIMIT)
      .get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data();
      out.push({ ...d, id: d.id || doc.id });
    });
    _cachedList = { at: Date.now(), body: out };
    logRoute(reqId, "list jobs", { count: out.length, cache: "MISS" });
    return NextResponse.json(out, {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (e) {
    logRoute(reqId, "list jobs failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// Bust the cache when a POST/DELETE happens so the next GET reflects
// the new state immediately. Exported so other route files can call it.
export function _bustJobsCache() {
  _cachedList = null;
}

/**
 * POST /api/jobs — submit a new pipeline run.
 *
 * Always succeeds: if a worker is alive, dispatches immediately. If
 * not, queues the job in Firestore — the next worker that heartbeats
 * picks it up via the registry.py claim loop.
 *
 * Idempotent on the optional `Idempotency-Key` request header: if the
 * same key was used in the last 60 seconds, returns the previously-
 * created job instead of creating a duplicate.
 */
export async function POST(req: NextRequest) {
  _bustJobsCache();   // any new job invalidates the list cache
  const reqId = newRequestId();
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const channel = String(body.channel || "horror");
    const dry_run = body.dry_run !== false; // default true (dry run)
    // Manual mode passthrough — forwarded to backend/jobs.submit().
    const manual_topic        = String(body.manual_topic || "").slice(0, 1000);
    const manual_script       = String(body.manual_script || "").slice(0, 20_000);
    const manual_title        = String(body.manual_title || "").slice(0, 200);
    const manual_channel_desc = String(body.manual_channel_desc || "").slice(0, 500);
    const manual_images       = Array.isArray(body.manual_images)
      ? (body.manual_images as unknown[]).slice(0, 32).map((u) => String(u))
      : [];
    // Tri-state: undefined = use channel default; true/false = override.
    const web_research =
      body.web_research === true ? true :
      body.web_research === false ? false :
      undefined;
    // Same tri-state for real-events research mode.
    const real_events =
      body.real_events === true ? true :
      body.real_events === false ? false :
      undefined;
    // Script language — ISO-2 code (en, ur, hi, es...). null = use
    // channel preset's language. Stored as null in Firestore when
    // unset so Python sees None.
    const language = (typeof body.language === "string" && body.language.trim())
      ? body.language.trim().slice(0, 5).toLowerCase()
      : null;
    // Voice override — one of the niche's voices_by_lang entries.
    const voice_override = (typeof body.voice_override === "string" && body.voice_override.trim())
      ? body.voice_override.trim().slice(0, 80)
      : null;
    // YouTube account id — which connected account to upload to.
    const youtube_account_id = (typeof body.youtube_account_id === "string" && body.youtube_account_id.trim())
      ? body.youtube_account_id.trim().slice(0, 80)
      : null;

    // Idempotency check.
    const idempKey = req.headers.get("Idempotency-Key") || "";
    if (idempKey) {
      const existing = await lookupIdempotent(idempKey);
      if (existing) {
        logRoute(reqId, "idempotent replay", { key: idempKey, job_id: existing });
        const doc = await adminDb().collection("jobs").doc(existing).get();
        if (doc.exists) return NextResponse.json(doc.data());
      }
    }

    // Synthesize the job row (same shape as backend/jobs.py's submit).
    const jobId = _shortId();
    const now = Date.now() / 1000;
    const base = {
      id: jobId,
      status: "queued",
      channel,
      dry_run,
      queued_at: now,
      started_at: null,
      finished_at: null,
      percent: 0,
      current_step: null,
      current_step_label: null,
      video_url: null,
      public_url: null,
      error: null,
      run_id: null,
      backend_instance_id: null,
      backend_url: null,
      created_by: "vercel-gateway",
      req_id: reqId,
      // Manual-mode payload propagated to the worker via adopt_remote.
      manual_topic, manual_script, manual_title,
      manual_channel_desc, manual_images,
      // null in Firestore is fine; backend reads it as Python None.
      web_research: web_research === undefined ? null : web_research,
      real_events:  real_events  === undefined ? null : real_events,
      language,
      voice_override,
      youtube_account_id,
    };

    // Pick a worker. If one is alive, dispatch immediately.
    const workers = await pickWorkers();
    const target = workers[0];

    // Decide UP-FRONT whether to wake Kaggle. We fire the workflow_dispatch
    // in PARALLEL with the worker dispatch so the user doesn't wait. The
    // condition is "no live GPU worker" — a CPU-only worker (HF Space) is
    // OK to dispatch the job to immediately, but we still wake Kaggle so
    // GPU finishes faster than HF would.
    const liveGpu = workers.find(
      (w) => w.tier === "gpu" && w.status === "available",
    );
    let wakePromise: Promise<void> | null = null;
    if (!liveGpu) {
      logRoute(reqId, "no live GPU — triggering kaggle workflow", {
        any_worker: !!target,
        target_tier: target?.tier,
      });
      wakePromise = _maybeWakeKaggle(reqId);
    }

    if (target) {
      logRoute(reqId, "dispatching", { backend: target.instance_id, url: target.url });
      try {
        const r = await fetch(`${target.url.replace(/\/$/, "")}/api/jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": reqId,
            "X-Vercel-Gateway": "1",
          },
          body: JSON.stringify({
            channel, dry_run,
            manual_topic, manual_script, manual_title,
            manual_channel_desc, manual_images, web_research,
            real_events, language, voice_override, youtube_account_id,
          }),
        });
        if (r.ok) {
          const workerJob = await r.json();
          // Replace the synthetic id with the worker's id so subsequent
          // status checks find the same record. (Backend's submit()
          // already wrote to Firestore on the first _persist, so the
          // doc lives at jobs/<workerJob.id>, NOT jobs/<jobId>.)
          const finalId = workerJob.id || jobId;
          await upsertJob(finalId, {
            ...workerJob,
            backend_instance_id: target.instance_id,
            backend_url: target.url,
            req_id: reqId,
          });
          if (idempKey) await storeIdempotent(idempKey, finalId);
          // CRITICAL: await the wake call BEFORE returning the response.
          // Vercel kills the function context the moment we send the
          // response — an un-awaited fetch() to api.github.com gets
          // dropped on the floor, which is exactly the bug we just hit.
          if (wakePromise) {
            await wakePromise.catch((e) =>
              logRoute(reqId, "kaggle wake error", { err: String(e) }),
            );
          }
          return NextResponse.json(workerJob);
        }
        logRoute(reqId, "dispatch http error", { status: r.status });
      } catch (e) {
        logRoute(reqId, "dispatch network error", { err: String(e) });
      }
    }

    // No worker reachable — queue the job for later pickup. The worker
    // claim loop in backend/registry.py will adopt it on next heartbeat.
    await adminDb().collection("jobs").doc(jobId).set({
      ...base,
      updated_at: FieldValue.serverTimestamp(),
    });
    if (idempKey) await storeIdempotent(idempKey, jobId);
    logRoute(reqId, "queued (no worker)", { job_id: jobId });

    // Same await — must complete before Vercel kills us.
    if (wakePromise) {
      await wakePromise.catch((e) =>
        logRoute(reqId, "kaggle wake error", { err: String(e) }),
      );
    }

    return NextResponse.json(base);
  } catch (e) {
    logRoute(reqId, "POST jobs failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * Best-effort: trigger the kaggle-dispatch workflow immediately via the
 * GitHub Actions API so the user doesn't wait for the 10-minute cron
 * tick when their submission lands with no GPU worker alive.
 *
 * Auth: the OAuth `repo` scope from /api/github/auth already includes
 * workflow:write. We pull the saved token from Firestore.
 *
 * Repo: GITHUB_REPO_FULL_NAME env var or sensible default.
 */
async function _maybeWakeKaggle(reqId: string): Promise<void> {
  const repoFullName = process.env.GITHUB_REPO_FULL_NAME || "Ahsan3301/yt_agent";
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    logRoute(reqId, "kaggle wake skipped (invalid repo)", { repoFullName });
    return;
  }

  let token = "";
  try {
    const snap = await adminDb()
      .collection("api_keys")
      .doc("GITHUB_ACCESS_TOKEN")
      .get();
    token = snap.exists ? ((snap.data() as { value?: string }).value || "") : "";
  } catch (e) {
    logRoute(reqId, "kaggle wake firestore read failed", { err: String(e) });
    return;
  }
  if (!token) {
    logRoute(reqId, "kaggle wake skipped (GITHUB_ACCESS_TOKEN not in Firestore)", {
      next_step:
        "Connections page → One-click connect → Sign in with GitHub. Re-run after.",
    });
    return;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/kaggle-dispatch.yml/dispatches`;
  logRoute(reqId, "kaggle wake POST", { url });
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    // 204 No Content = success; anything else is a problem we want visible.
    if (r.status === 204) {
      logRoute(reqId, "kaggle dispatch triggered (204 No Content)", {});
      return;
    }
    const body = await r.text();
    logRoute(reqId, "kaggle dispatch unexpected status", {
      status: r.status,
      body: body.slice(0, 400),
    });
  } catch (e) {
    logRoute(reqId, "kaggle wake fetch threw", { err: String(e) });
  }
}

function _shortId(): string {
  const a = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 12; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}

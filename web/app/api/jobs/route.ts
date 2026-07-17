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
    // Two queries merged (2026-07-17): the newest-N page ALONE dropped
    // ACTIVE jobs whose queued_at is old — e.g. a requeued job that a
    // worker was actively rendering sat outside the newest-20 window,
    // so the queue UI showed "0 running" while the Monitor showed the
    // worker mid-render at 82%. Active rows (queued/claimed/running/
    // needs_publish) are now ALWAYS included regardless of age.
    const [pageSnap, ...activeSnaps] = await Promise.all([
      adminDb().collection("jobs")
        .orderBy("queued_at", "desc")
        .limit(_LIST_LIMIT)
        .get(),
      ...["queued", "claimed", "running", "needs_publish"].map((st) =>
        adminDb().collection("jobs").where("status", "==", st).limit(50).get(),
      ),
    ]);
    const seen = new Set<string>();
    const out: unknown[] = [];
    const push = (doc: { id: string; data: () => Record<string, unknown> }) => {
      const d = doc.data();
      const id = String(d.id || doc.id);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ ...d, id });
    };
    for (const s of activeSnaps) s.forEach(push);
    pageSnap.forEach(push);
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

    // Inherit channel-level config for this niche (2026-07-16).
    // Jobs created through this gateway previously carried NO
    // allowed_workers, NO source_channel_name, and NO cf_* fields:
    //   - claim gate saw an empty allowlist → ANY worker could claim,
    //     including Kaggle on channels where the operator turned
    //     Kaggle off;
    //   - the wake logic below fired unconditionally → Kaggle booted
    //     for jobs it was never allowed to touch;
    //   - channel_cf's fail-closed default treated the missing
    //     cf_source as "off" → Cloudflare was silently skipped for
    //     every gateway-created job even when the channel had a
    //     configured pool.
    // Resolve the first ENABLED channel whose niche matches and stamp
    // its worker + Cloudflare + publish config onto the job, exactly
    // like render-now and scheduled-render do. Explicit body fields
    // still win where present.
    let chanAllowed: string[] = [];
    let chanYt: string | null = null;
    let chanStamp: Record<string, unknown> = {};
    try {
      const chSnap = await adminDb().collection("channels").limit(50).get();
      const match = chSnap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .find((c) => c.enabled !== false && String(c.niche || "").trim() === channel);
      if (match) {
        chanAllowed = Array.isArray(match.allowed_workers)
          ? (match.allowed_workers as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        chanYt = (typeof match.youtube_account_id === "string" && match.youtube_account_id)
          ? String(match.youtube_account_id) : null;
        const cfSource = String(match.cloudflare_source || "off");
        chanStamp = {
          source_channel_name: String(match.name || channel),
          allowed_workers: chanAllowed,
          oracle_password_hash: (typeof match.oracle_password_hash === "string" && match.oracle_password_hash)
            ? match.oracle_password_hash : null,
          cf_source: cfSource,
          cf_own_account_id: cfSource === "own" ? String(match.cloudflare_account_id || "").trim() : "",
          cf_own_api_token:  cfSource === "own" ? String(match.cloudflare_api_token || "").trim() : "",
          cf_pool:           cfSource === "own" ? String(match.cloudflare_pool || "").trim() : "",
          llm_priority: (typeof match.llm_priority === "string" && match.llm_priority.trim())
            ? String(match.llm_priority).trim().slice(0, 60) : "",
          tone_override: (typeof match.tone === "string" && match.tone) ? String(match.tone) : null,
          privacy_override: (match.privacy === "public" || match.privacy === "unlisted" || match.privacy === "private")
            ? String(match.privacy) : null,
        };
      }
    } catch { /* soft-fail → legacy shape, claim gate stays permissive */ }

    // Synthesize the job row (same shape as backend/jobs.py's submit).
    const jobId = _shortId();
    const now = Date.now() / 1000;
    const base = {
      ...chanStamp,
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
      // Explicit body binding wins; else inherit the channel's bound
      // account so gateway-created jobs publish to the right channel.
      youtube_account_id: youtube_account_id || chanYt,
      // Same publish-warning chip semantics as render-now + scheduled-render.
      unbound: !(youtube_account_id || chanYt),
    };

    // Pick a URL-based worker (tunnel mode) for direct HTTP dispatch.
    const workers = await pickWorkers();
    const target = workers[0];

    // Wake-Kaggle logic. Fires ONLY when there's genuinely no worker
    // available — a live worker (URL-based OR outbound-poll) that has
    // headroom should absorb the new job.
    //
    // Headroom = the existing worker isn't so overloaded that queuing
    // this job on it would be worse than a fresh Kaggle boot. Signals:
    //   - GPU util > 90% for the last heartbeat, OR
    //   - Queue depth > 3 already pending on that worker
    // For a P100 + serial-job pipeline, these thresholds mean "the
    // running job hasn't started rendering yet AND enough are already
    // in front of you that another 5-10 min wait would beat a fresh
    // 90-sec boot".
    //
    // Rapid job bursts share the same wake via a 90-sec idempotency
    // window in queue_state.kaggle_dispatch.last_woken_at.
    const anyLive = await _liveGpuWithHeadroom();
    const nowSec = Date.now() / 1000;
    const DEDUP_SEC = 90;
    let wakePromise: Promise<void> | null = null;

    // Kaggle must be in the channel's allowed_workers for a wake to be
    // justified — waking it for an oracle-only channel burns a T4 boot
    // + quota on a job the claim gate will refuse to hand over. Empty
    // list = legacy default (kaggle allowed). 2026-07-16: this wake
    // previously fired unconditionally, and the GH workflow_dispatch
    // path skips the needs-worker probe entirely, so Kaggle booted for
    // every gateway job regardless of the channel's worker toggles.
    const kaggleAllowedForJob = chanAllowed.length === 0 || chanAllowed.includes("kaggle");
    if (!kaggleAllowedForJob) {
      logRoute(reqId, "kaggle wake SKIPPED (channel excludes kaggle)", {
        channel, allowed_workers: chanAllowed,
      });
    } else if (anyLive.ok) {
      logRoute(reqId, "kaggle wake SKIPPED (live worker with headroom)", {
        instance_id: anyLive.instance_id,
        gpu_util:    anyLive.gpu_util,
        queue_depth: anyLive.queue_depth,
      });
    } else {
      const skip = await _wasWokenRecently(nowSec, DEDUP_SEC);
      if (skip) {
        logRoute(reqId, "kaggle wake SUPPRESSED (recent dispatch within 90s)", {});
      } else {
        logRoute(reqId, "kaggle wake TRIGGERED", {
          reason: anyLive.reason,
        });
        wakePromise = _maybeWakeKaggle(reqId).then(() => _markKaggleWoken(nowSec));
      }
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
            real_events, language, voice_override,
            youtube_account_id: youtube_account_id || chanYt,
          }),
        });
        if (r.ok) {
          const workerJob = await r.json();
          // Replace the synthetic id with the worker's id so subsequent
          // status checks find the same record. (Backend's submit()
          // already wrote to Firestore on the first _persist, so the
          // doc lives at jobs/<workerJob.id>, NOT jobs/<jobId>.)
          //
          // chanStamp goes FIRST so the channel-inherited config
          // (allowed_workers, cf_*, oracle hash, tone/privacy, name)
          // survives on the dispatch path too — before 2026-07-17 it
          // was only written on the queued-no-worker branch, so any
          // job that dispatched directly to a live worker lost every
          // channel setting (CF silently off, no worker gating).
          const finalId = workerJob.id || jobId;
          await upsertJob(finalId, {
            ...chanStamp,
            unbound: !(youtube_account_id || chanYt),
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
 * Return whether ANY GPU worker is alive AND has headroom for another
 * queued job. Reads backends collection directly so outbound-poll
 * workers (Kaggle/Colab on Coolify, url='') are counted alongside
 * URL-based tunnel workers.
 *
 * Definition of "has headroom":
 *   - Heartbeat is fresh (last_seen_at within 180 s), AND
 *   - queue_depth on that worker is < 4, AND
 *   - gpu.util_percent < 90 (unset counts as ok).
 *
 * If any GPU worker satisfies all three, we return ok=true and the
 * new job just enqueues behind whatever it's already running. No
 * fresh Kaggle dispatch fires. This is the correct default — a single
 * P100 renders serially and can absorb a small queue.
 */
async function _liveGpuWithHeadroom(): Promise<{
  ok: boolean;
  reason?: string;
  instance_id?: string;
  gpu_util?: number | null;
  queue_depth?: number;
}> {
  try {
    const snap = await adminDb().collection("backends").limit(50).get();
    const nowMs = Date.now();
    const cutoff = nowMs - 180_000;
    let bestReason = "no GPU worker alive";
    for (const d of snap.docs) {
      const v = d.data() as {
        tier?: string;
        last_seen_at?: unknown;
        queue_depth?: number;
        stats?: { gpu?: { util_percent?: number | null } | null };
        instance_id?: string;
      };
      if (v.tier !== "gpu") continue;
      const lastMs = _epochToMs(v.last_seen_at);
      if (lastMs == null || lastMs < cutoff) continue;
      const qd = Number(v.queue_depth ?? 0);
      const gu = v.stats?.gpu?.util_percent;
      if (qd >= 4) {
        bestReason = `existing worker overloaded (queue_depth=${qd})`;
        continue;
      }
      if (typeof gu === "number" && gu >= 90) {
        bestReason = `existing worker GPU saturated (util=${gu}%)`;
        continue;
      }
      return {
        ok: true,
        instance_id: v.instance_id,
        gpu_util:    typeof gu === "number" ? gu : null,
        queue_depth: qd,
      };
    }
    return { ok: false, reason: bestReason };
  } catch (e) {
    return { ok: false, reason: `backends read failed: ${String(e)}` };
  }
}

function _epochToMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e11 ? v : v * 1000;
  if (typeof v === "string" && /^\d/.test(v)) return _epochToMs(Number(v));
  return null;
}

/**
 * Idempotency guard for Kaggle wake. Reads
 * `queue_state.doc('kaggle_dispatch').last_woken_at` and returns true
 * if a wake fired within the given window. Prevents rapid job bursts
 * from firing multiple workflow_dispatches while a fresh Kaggle boot
 * is still coming online (~90 s).
 */
async function _wasWokenRecently(now: number, withinSec: number): Promise<boolean> {
  try {
    const snap = await adminDb().collection("queue_state").doc("kaggle_dispatch").get();
    if (!snap.exists) return false;
    const d = snap.data() as { last_woken_at?: number };
    const t = Number(d.last_woken_at || 0);
    return t > 0 && (now - t) < withinSec;
  } catch { return false; }
}

async function _markKaggleWoken(now: number): Promise<void> {
  try {
    await adminDb().collection("queue_state").doc("kaggle_dispatch").set(
      { last_woken_at: now }, { merge: true },
    );
  } catch { /* soft-fail; worst case is one duplicate dispatch */ }
}

/**
 * Best-effort: trigger the kaggle-dispatch workflow immediately via the
 * GitHub Actions API so the user doesn't wait for the 5-minute cron
 * tick when their submission lands with no GPU worker alive.
 *
 * Auth: the OAuth `repo` scope from /api/github/auth already includes
 * workflow:write. We pull the saved token from the keys blob.
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

  // Read GITHUB_ACCESS_TOKEN from the settings blob at settings/api_keys
  // (this is where /api/keys stores it since the migration to blob form).
  // Fall back to the legacy per-doc path in case some deploys still have
  // that shape.
  let token = "";
  try {
    const blobSnap = await adminDb().collection("settings").doc("api_keys").get();
    if (blobSnap.exists) {
      const blob = (blobSnap.data() as { data?: Record<string, string> }).data || {};
      token = String(blob.GITHUB_ACCESS_TOKEN || "");
    }
    if (!token) {
      // Legacy fallback.
      const snap = await adminDb().collection("api_keys").doc("GITHUB_ACCESS_TOKEN").get();
      token = snap.exists ? ((snap.data() as { value?: string }).value || "") : "";
    }
  } catch (e) {
    logRoute(reqId, "kaggle wake keys read failed", { err: String(e) });
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

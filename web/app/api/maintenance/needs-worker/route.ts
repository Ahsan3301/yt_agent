import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { toEpochMs as _toEpochMs } from "@/lib/timestamps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/maintenance/needs-worker
 *
 * Cheap probe used by the GitHub Actions `kaggle-dispatch.yml` cron to
 * decide whether to wake a Kaggle GPU notebook. Returns:
 *
 *   {
 *     needs_worker: bool,
 *     queued:       number,     // queued jobs with no backend
 *     gpu_alive:    bool,       // any backend with tier=gpu seen <90s
 *     any_alive:    bool,
 *     reason:       string,
 *   }
 *
 * Auth: same X-API-Key as the other maintenance routes.
 */
export async function GET(req: NextRequest) {
  const authed = await requireMaintenanceKey(req);
  if (authed !== true) return authed;

  const db = adminDb();

  // Count queued jobs not yet claimed by anyone AND that the channel
  // allows to run on Kaggle. A queued job whose channel had Kaggle
  // toggled OFF (allowed_workers=['oracle','colab'] etc.) must NEVER
  // trigger a wake-kaggle — the wake burns a T4 boot + Kaggle quota
  // for work Kaggle isn't allowed to touch.
  //
  // 2026-07-15: eligibility now reads the channel's CURRENT
  // allowed_workers (jobs only carry a snapshot from creation time).
  // Before this, toggling Kaggle off on a channel didn't stop wakes
  // for jobs already sitting in the queue — Kaggle booted into an
  // empty queue while Oracle claimed the render.
  let queued = 0;
  let queuedKaggleEligible = 0;
  try {
    // Live channel config keyed by name — one read, reused for every job.
    const channelsByName = new Map<string, string[]>();
    try {
      const chSnap = await db.collection("channels").limit(100).get();
      chSnap.forEach((doc) => {
        const c = doc.data() as { name?: string; allowed_workers?: unknown };
        const name = String(c.name || "").trim();
        if (!name) return;
        const aw = Array.isArray(c.allowed_workers)
          ? (c.allowed_workers as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        channelsByName.set(name, aw);
      });
    } catch { /* soft-fail → job snapshots used below */ }

    const snap = await db
      .collection("jobs")
      .where("status", "==", "queued")
      .limit(50)
      .get();
    snap.forEach((doc) => {
      const v = doc.data() as {
        backend_instance_id?: string | null;
        allowed_workers?: unknown;
        source_channel_name?: string;
      };
      if (v.backend_instance_id) return;
      queued += 1;
      const snapshotArr = Array.isArray(v.allowed_workers)
        ? (v.allowed_workers as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      // Current channel config wins over the job's snapshot.
      const liveArr = channelsByName.get(String(v.source_channel_name || "").trim());
      const allowedArr = (liveArr && liveArr.length > 0) ? liveArr : snapshotArr;
      // Legacy default when allowed_workers is missing/empty: Kaggle
      // was historically the primary → treat as eligible.
      const kaggleAllowed = allowedArr.length === 0 || allowedArr.includes("kaggle");
      if (kaggleAllowed) queuedKaggleEligible += 1;
    });
  } catch (e) {
    return NextResponse.json(
      { error: "firestore jobs read failed", detail: String(e) },
      { status: 500 },
    );
  }

  // Look at live backends. 180 s = same freshness window we use in
  // /api/backends and pickWorkers. Also enforce a resource-headroom
  // guard: if a GPU worker is alive with queue_depth < 4 and gpu util
  // < 90 %, it's a valid target and we do NOT need a fresh boot.
  const cutoff = Date.now() - 180_000;
  let gpu_alive = false;
  let gpu_has_headroom = false;
  let any_alive = false;
  let saturation_reason = "";
  try {
    const snap = await db.collection("backends").limit(50).get();
    for (const d of snap.docs) {
      const v = d.data() as {
        tier?: string;
        last_seen?: unknown;
        last_seen_at?: unknown;
        queue_depth?: number;
        stats?: { gpu?: { util_percent?: number | null } | null };
      };
      const ms = _toEpochMs(v.last_seen_at ?? v.last_seen);
      if (ms == null || ms < cutoff) continue;
      any_alive = true;
      if (v.tier === "gpu") {
        gpu_alive = true;
        const qd = Number(v.queue_depth ?? 0);
        const gu = v.stats?.gpu?.util_percent;
        if (qd >= 4) {
          saturation_reason = `existing GPU worker overloaded (queue_depth=${qd})`;
        } else if (typeof gu === "number" && gu >= 90) {
          saturation_reason = `existing GPU worker saturated (util=${gu}%)`;
        } else {
          gpu_has_headroom = true;
        }
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: "backends read failed", detail: String(e) },
      { status: 500 },
    );
  }

  let needs_worker = false;
  let reason = "";
  if (queued === 0) {
    reason = "no queued jobs";
  } else if (queuedKaggleEligible === 0) {
    // Every queued job has Kaggle EXCLUDED from allowed_workers.
    // Waking Kaggle burns quota + a T4 boot for zero benefit — the
    // claim gate would refuse to hand any queued job to it. Refuse
    // to wake.
    reason = `${queued} queued job(s) but none allow Kaggle (channel(s) opted out)`;
  } else if (gpu_has_headroom) {
    reason = "queued jobs present but a GPU worker with headroom is alive";
  } else if (gpu_alive && !gpu_has_headroom) {
    // Existing GPU is saturated → spin up an extra to parallelise.
    needs_worker = true;
    reason = `${queued} queued job(s); ${saturation_reason}`;
  } else {
    needs_worker = true;
    reason = `${queuedKaggleEligible}/${queued} queued job(s) allow Kaggle and no GPU worker alive`;
  }

  // Optional wake trigger — when ?wake=1 is passed AND we need a worker,
  // fire wake-kaggle inline instead of relying on the separate GH cron
  // (which runs every 5 min max). Keeps the queue-to-worker latency
  // under a minute for the Coolify hourly path. Best-effort; failure
  // is logged but doesn't fail the probe response.
  let woke = false;
  if (needs_worker && new URL(req.url).searchParams.get("wake") === "1") {
    try {
      const base = (process.env.COOLIFY_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
      const wakeUrl = base
        ? `${base}/api/backends/wake-kaggle`
        : new URL("/api/backends/wake-kaggle", req.url).toString();
      // Fire-and-forget with the maintenance api key so the wake
      // endpoint's own auth accepts the call.
      fetch(wakeUrl, {
        method: "POST",
        headers: {
          "X-API-Key": process.env.RENDER_TRIGGER_KEY || "",
        },
      }).catch(() => {});
      woke = true;
    } catch { /* best-effort */ }
  }

  return NextResponse.json({
    needs_worker,
    queued,
    queued_kaggle_eligible: queuedKaggleEligible,
    gpu_alive,
    any_alive,
    reason,
    woke,
  });
}

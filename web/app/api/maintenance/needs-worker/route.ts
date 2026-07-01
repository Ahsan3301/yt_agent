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

  // Count queued jobs not yet claimed by anyone.
  let queued = 0;
  try {
    const snap = await db
      .collection("jobs")
      .where("status", "==", "queued")
      .limit(50)
      .get();
    queued = snap.docs.filter((d) => {
      const v = d.data() as { backend_instance_id?: string | null };
      return !v.backend_instance_id;
    }).length;
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
  } else if (gpu_has_headroom) {
    reason = "queued jobs present but a GPU worker with headroom is alive";
  } else if (gpu_alive && !gpu_has_headroom) {
    // Existing GPU is saturated → spin up an extra to parallelise.
    needs_worker = true;
    reason = `${queued} queued job(s); ${saturation_reason}`;
  } else {
    needs_worker = true;
    reason = `${queued} queued job(s) and no GPU worker alive`;
  }

  return NextResponse.json({
    needs_worker,
    queued,
    gpu_alive,
    any_alive,
    reason,
  });
}

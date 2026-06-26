import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute, pickWorkers } from "@/app/api/_lib/orchestrator";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/cleanup
 *
 * Daily cron from GitHub Actions. Prunes:
 *   - Firestore runs_index + run_summaries > 90 days
 *   - Firestore jobs (terminal status) > 14 days
 *   - Firestore idempotency docs > 7 days
 *   - R2 video files > 30 days  (delegated to a live worker via /api/runs/<id>)
 *
 * Auth: X-API-Key matching api_keys/RENDER_TRIGGER_KEY.
 */
const RETENTION_DAYS = {
  runs: 90,
  jobs: 14,
  idempotency: 7,
  videos: 30,
};

export async function POST(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  const now = Date.now() / 1000;
  const summary = {
    req_id: reqId,
    runs_deleted: 0,
    summaries_deleted: 0,
    jobs_deleted: 0,
    idempotency_deleted: 0,
    videos_requested: 0,
    errors: [] as string[],
  };

  // ── runs_index + run_summaries ──
  try {
    const cutoff = now - RETENTION_DAYS.runs * 86400;
    const snap = await adminDb()
      .collection("runs_index")
      .get();
    const batch = adminDb().batch();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const fin = _toEpoch(d.finished_at);
      if (fin != null && fin < cutoff) {
        batch.delete(doc.ref);
        batch.delete(adminDb().collection("run_summaries").doc(doc.id));
        n += 1;
      }
    });
    if (n > 0) await batch.commit();
    summary.runs_deleted = n;
    summary.summaries_deleted = n;
  } catch (e) {
    summary.errors.push(`runs cleanup: ${String(e)}`);
  }

  // ── jobs (terminal status) ──
  try {
    const cutoff = now - RETENTION_DAYS.jobs * 86400;
    const snap = await adminDb()
      .collection("jobs")
      .where("status", "in", ["complete", "failed", "cancelled"])
      .get();
    const batch = adminDb().batch();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const fin = _toEpoch(d.finished_at) ?? _toEpoch(d.queued_at);
      if (fin != null && fin < cutoff) {
        batch.delete(doc.ref);
        n += 1;
      }
    });
    if (n > 0) await batch.commit();
    summary.jobs_deleted = n;
  } catch (e) {
    summary.errors.push(`jobs cleanup: ${String(e)}`);
  }

  // ── idempotency ──
  try {
    const cutoff = now - RETENTION_DAYS.idempotency * 86400;
    const snap = await adminDb().collection("idempotency").get();
    const batch = adminDb().batch();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const exp = _toEpoch(d.expires_at);
      if (exp != null && exp < cutoff) {
        batch.delete(doc.ref);
        n += 1;
      }
    });
    if (n > 0) await batch.commit();
    summary.idempotency_deleted = n;
  } catch (e) {
    summary.errors.push(`idempotency cleanup: ${String(e)}`);
  }

  // ── R2 videos (requires a live worker since R2 credentials are
  //    worker-side). Fan out delete requests; the worker's
  //    /api/runs/<id> DELETE drops the R2 object too.
  try {
    const cutoff = now - RETENTION_DAYS.videos * 86400;
    const workers = await pickWorkers();
    if (workers.length === 0) {
      summary.errors.push("no worker available for R2 cleanup; will retry tomorrow");
    } else {
      const snap = await adminDb().collection("runs_index").get();
      const toDelete: string[] = [];
      snap.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        const fin = _toEpoch(d.finished_at);
        if (fin != null && fin < cutoff && d.has_video) toDelete.push(doc.id);
      });
      summary.videos_requested = toDelete.length;
      // Fire-and-forget — don't block the cleanup response.
      const w = workers[0];
      for (const id of toDelete) {
        fetch(`${w.url.replace(/\/$/, "")}/api/runs/${id}`, {
          method: "DELETE",
          headers: { "X-Request-Id": reqId, "X-Vercel-Gateway": "1" },
        }).catch(() => {});
      }
    }
  } catch (e) {
    summary.errors.push(`videos cleanup: ${String(e)}`);
  }

  logRoute(reqId, "cleanup done", summary as unknown as Record<string, unknown>);
  return NextResponse.json(summary);
}

function _toEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "_seconds" in v) {
    const t = v as { _seconds: number };
    return t._seconds;
  }
  if (typeof v === "object" && v !== null && "seconds" in v) {
    const t = v as { seconds: number };
    return t.seconds;
  }
  return null;
}

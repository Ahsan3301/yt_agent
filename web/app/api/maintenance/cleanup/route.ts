import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { deleteVideosByRunIds } from "@/lib/storage-delete";

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
  errors: 30,            // Firestore errors collection
  run_logs: 14,          // runs_index/<id>/logs subcollections
};
// Orphaned queued jobs — queued for too long with no backend ever
// claiming them. Usually leftovers from a failed worker start. Clearing
// them prevents Kaggle's watchdog from staying alive forever waiting
// for a job it can never claim.
const ORPHAN_QUEUED_HOURS = 2;

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
    orphan_queued_failed: 0,
    errors_deleted: 0,
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
    // Safety: never delete a terminal-status job whose id is still
    // held by a live backend's active_job_id — the worker's Python
    // process may still be handle()-ing it and would go zombie.
    const activeIds = new Set<string>();
    try {
      const backSnap = await adminDb().collection("backends").limit(20).get();
      const seenCutoff = now - 300;
      backSnap.forEach((doc) => {
        const d = doc.data() as { active_job_id?: string; last_seen_at?: number };
        if (d.active_job_id && Number(d.last_seen_at || 0) > seenCutoff) {
          activeIds.add(String(d.active_job_id));
        }
      });
    } catch { /* soft-fail */ }
    const batch = adminDb().batch();
    let n = 0;
    snap.forEach((doc) => {
      if (activeIds.has(doc.id)) return;
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

  // ── orphan queued jobs ──
  // Anything still status=queued AND backend_instance_id=null after
  // ORPHAN_QUEUED_HOURS is almost certainly a leftover from a failed
  // dispatch (worker died before claim, or duplicate from idempotency
  // race). Mark them failed so the watchdog stops treating them as
  // "claimable work" — keeps Kaggle from staying alive forever.
  //
  // 2026-07-17: threshold is now live-worker-aware. Oracle CPU renders
  // take 40-70 min each, so a 5-job scheduled batch means the tail
  // waits 3-5h in queue while a perfectly healthy worker drains it
  // sequentially — the flat 2h sweep was killing those (user screenshot:
  // 5 jobs "orphaned in queue for >2h" while Oracle was mid-queue).
  // If ANY backend heartbeated within the last 10 min, the queue is
  // being actively worked → use a 24h threshold. Only the genuine
  // no-worker-alive case keeps the aggressive 2h cutoff.
  try {
    let workerAlive = false;
    try {
      const bSnap = await adminDb().collection("backends").limit(50).get();
      const liveCut = now - 600;
      bSnap.forEach((bd) => {
        const b = bd.data() as Record<string, unknown>;
        const seen = _toEpoch(b.last_seen_at) ?? _toEpoch(b.last_seen);
        if (seen != null && seen > liveCut) workerAlive = true;
      });
    } catch { /* soft-fail → conservative 2h behaviour */ }
    const effectiveHours = workerAlive ? 24 : ORPHAN_QUEUED_HOURS;
    const cutoff = now - effectiveHours * 3600;
    const snap = await adminDb()
      .collection("jobs")
      .where("status", "==", "queued")
      .get();
    const batch = adminDb().batch();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d.backend_instance_id) return;
      const q = _toEpoch(d.queued_at);
      if (q != null && q < cutoff) {
        batch.update(doc.ref, {
          status: "failed",
          error: `orphaned in queue for >${effectiveHours}h with no backend claim`,
          finished_at: now,
        });
        n += 1;
      }
    });
    if (n > 0) await batch.commit();
    summary.orphan_queued_failed = n;
  } catch (e) {
    summary.errors.push(`orphan queued cleanup: ${String(e)}`);
  }

  // ── errors collection (persistent error reports from notifier.report_error) ──
  try {
    const cutoff = now - RETENTION_DAYS.errors * 86400;
    const snap = await adminDb()
      .collection("errors")
      .where("ts", "<", cutoff)
      .limit(500)
      .get();
    if (!snap.empty) {
      const batch = adminDb().batch();
      snap.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      summary.errors_deleted = snap.size;
    }
  } catch (e) {
    summary.errors.push(`errors cleanup: ${String(e)}`);
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

  // ── R2 videos: server-side S3 delete (no worker needed) ────
  // The dashboard container already has the S3 creds via env, so we
  // hit the bucket directly instead of asking a live worker to do it.
  // Works even when Kaggle + Colab are both offline.
  try {
    const cutoff = now - RETENTION_DAYS.videos * 86400;
    const snap = await adminDb().collection("runs_index").get();
    const toDelete: string[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const fin = _toEpoch(d.finished_at);
      if (fin != null && fin < cutoff && d.has_video) toDelete.push(doc.id);
    });
    summary.videos_requested = toDelete.length;
    if (toDelete.length > 0) {
      const res = await deleteVideosByRunIds(toDelete);
      logRoute(reqId, "cleanup: server-side video delete",
        { deleted: res.deleted, failed: res.failed });
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

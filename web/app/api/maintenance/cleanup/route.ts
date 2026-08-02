import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { deleteVideosByRunIds } from "@/lib/storage-delete";
import { listStorageVideos } from "@/lib/storage-list";
import { withHeartbeat } from "@/lib/maintenance-heartbeat";
import { getConfig } from "@/lib/platform-config";

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
/** Defaults. Every one is overridable from the dashboard
 *  (Configuration → Retention) so changing how long videos are kept
 *  does not require a code change and a deploy. */
const RETENTION_DEFAULTS = {
  runs: 90,
  jobs: 14,
  idempotency: 7,
  videos: 30,
  errors: 30,            // Firestore errors collection
  run_logs: 14,          // runs_index/<id>/logs subcollections
};

/** Read the retention window for one bucket of data, in days.
 *  Falls back to the default on anything unparseable — a typo in the
 *  config UI must not silently mean "delete everything". */
async function _retentionDays(
  key: keyof typeof RETENTION_DEFAULTS,
  configKey: string,
): Promise<number> {
  const fallback = RETENTION_DEFAULTS[key];
  try {
    const raw = await getConfig(configKey, "");
    const n = Number(String(raw).trim());
    // Reject 0 and negatives explicitly: "0 days" would mean delete
    // everything on the next tick, which is never what someone means
    // to type into a retention box.
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  } catch { /* fall through */ }
  return fallback;
}
// Orphaned queued jobs — queued for too long with no backend ever
// claiming them. Usually leftovers from a failed worker start. Clearing
// them prevents Kaggle's watchdog from staying alive forever waiting
// for a job it can never claim.
const ORPHAN_QUEUED_HOURS = 2;

async function _handler(req: NextRequest) {
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
    // Split out because "requested" used to be the only number reported
    // and it counted rows considered, not bytes actually reclaimed.
    videos_deleted: 0,
    videos_already_absent: 0,
    videos_freed_mb: 0,
    rows_marked_youtube_only: 0,
    // Size-cap enforcement, reported separately from age-based deletes
    // so it is obvious WHY something was removed.
    storage_cap_gb: 0,
    storage_used_mb: 0,
    cap_deleted: 0,
    cap_deleted_unpublished: 0,
    errors: [] as string[],
    orphan_queued_failed: 0,
    errors_deleted: 0,
    run_logs_deleted: 0,
    // Echoed back so the operator can confirm which windows this run
    // actually used, rather than trusting that a config edit took.
    retention_days: {} as Record<string, number>,
  };

  // Resolved once per run so a config edit mid-sweep can't have one
  // section using the old window and another the new one.
  const RETENTION_DAYS = {
    runs:        await _retentionDays("runs",        "RETENTION_RUNS_DAYS"),
    jobs:        await _retentionDays("jobs",        "RETENTION_JOBS_DAYS"),
    idempotency: await _retentionDays("idempotency", "RETENTION_IDEMPOTENCY_DAYS"),
    videos:      await _retentionDays("videos",      "RETENTION_VIDEOS_DAYS"),
    errors:      await _retentionDays("errors",      "RETENTION_ERRORS_DAYS"),
    run_logs:    await _retentionDays("run_logs",    "RETENTION_RUN_LOGS_DAYS"),
  };
  summary.retention_days = RETENTION_DAYS;

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

  // ── run_logs ────────────────────────────────────────────────────
  // RETENTION_DAYS.run_logs was declared from the start but never
  // actually used — no sweep existed anywhere in the codebase. The
  // table therefore grew without bound: one render writes up to 200
  // batches x 200 rows (backend/logbuf.py), all into the single
  // PocketBase SQLite file. It reached 111k rows on a single-user
  // install, and it is the table that fills the VPS disk first.
  //
  // Paged so a large backlog is drained gradually across cron ticks
  // rather than in one query that would time out the whole route
  // (and with it the orphan-job reaper that shares this request).
  try {
    const cutoff = now - RETENTION_DAYS.run_logs * 86400;
    let deleted = 0;
    for (let page = 0; page < 20; page++) {          // <= 10k rows per tick
      const snap = await adminDb()
        .collection("run_logs")
        .where("ts", "<", cutoff)
        .limit(500)
        .get();
      if (snap.empty) break;
      const batch = adminDb().batch();
      snap.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 500) break;                    // drained
    }
    summary.run_logs_deleted = deleted;
  } catch (e) {
    summary.errors.push(`run_logs cleanup: ${String(e)}`);
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
    const snap = await adminDb().collection("runs_index").limit(2000).get();
    // run_id -> doc id, so rows can be marked after their bytes go.
    const docByRun = new Map<string, string>();
    const toDelete: string[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const fin = _toEpoch(d.finished_at);
      if (fin == null || fin >= cutoff || !d.has_video) return;
      // The storage key is videos/<run_id>.mp4. This used to push
      // doc.id, which is a 15-char HASH of run_id — so no key ever
      // matched. And S3/MinIO answer DeleteObject on a missing key
      // with 204, so every one of those "succeeded". Retention has
      // been reporting deleted videos while the bucket only grew.
      const runId = String(d.run_id || doc.id);
      docByRun.set(runId, doc.id);
      toDelete.push(runId);
    });
    summary.videos_requested = toDelete.length;
    if (toDelete.length > 0) {
      const res = await deleteVideosByRunIds(toDelete);
      logRoute(reqId, "cleanup: server-side video delete",
        { deleted: res.deleted, failed: res.failed, missing: res.missing,
          freed_mb: res.freed_mb_estimate });

      // Reclaiming disk must not mean losing the video from the
      // Library. The row survives; it just stops advertising a local
      // file. VideoPlayer builds its source list from public_url,
      // mirrors, then the YouTube embed — so clearing the dead URL
      // makes the YouTube tab the default and playback keeps working
      // for anything that was published.
      for (const runId of res.deletedIds) {
        const docId = docByRun.get(runId);
        if (!docId) continue;
        try {
          const cur = await adminDb().collection("runs_index").doc(docId).get();
          const c = (cur.data() || {}) as Record<string, unknown>;
          const yt = String(c.youtube_video_id || "");
          await adminDb().collection("runs_index").doc(docId).update({
            has_video: false,
            video_url: "",
            public_url: "",
            // Distinguishes "still watchable on YouTube" from "the only
            // copy is gone" — the second is worth seeing in the UI.
            video_storage: yt ? "youtube_only" : "deleted",
          });
          if (yt) summary.rows_marked_youtube_only += 1;
        } catch { /* best-effort — bytes are already gone either way */ }
      }
      summary.videos_deleted = res.deleted;
      summary.videos_already_absent = res.missing;
      summary.videos_freed_mb = res.freed_mb_estimate;
    }

    // ── Size cap ─────────────────────────────────────────────
    // Age alone does not bound disk. Measured here: ~308 MB per render
    // at ~17 renders/day is ~5.2 GB/day, so a 30-day window implies
    // ~150 GB on a 96 GB disk — it fills in under a fortnight and the
    // retention sweep never gets the chance to help. A cap is what
    // actually keeps the box alive.
    //
    // Deletes oldest-first and PUBLISHED-first, because removing a
    // published video costs nothing that matters: the Library row
    // survives and plays from YouTube. Unpublished files are only
    // touched if the cap still cannot be met, since those are the only
    // copy — and that case is reported loudly rather than done quietly.
    const capGb = Number(await getConfig("STORAGE_MAX_GB", "")) || 0;
    if (capGb > 0) {
      const capBytes = capGb * 1e9;
      const vids = await listStorageVideos().catch(() => []);
      let total = vids.reduce((n, v) => n + v.size, 0);
      summary.storage_cap_gb = capGb;
      summary.storage_used_mb = Math.round(total / 1e6);

      if (total > capBytes) {
        const ytByRun = new Map<string, string>();
        const docByRun2 = new Map<string, string>();
        try {
          const snap = await adminDb().collection("runs_index").limit(2000).get();
          snap.forEach((d) => {
            const r = (d.data() || {}) as Record<string, unknown>;
            const rid = String(r.run_id || d.id);
            ytByRun.set(rid, String(r.youtube_video_id || ""));
            docByRun2.set(rid, d.id);
          });
        } catch { /* treat unknown as unpublished — the cautious read */ }

        const ordered = [...vids].sort((a, b) => {
          const aPub = ytByRun.get(a.run_id) ? 0 : 1;
          const bPub = ytByRun.get(b.run_id) ? 0 : 1;
          if (aPub !== bPub) return aPub - bPub;      // published first
          return a.last_modified - b.last_modified;   // then oldest
        });

        const overflow: string[] = [];
        for (const v of ordered) {
          if (total <= capBytes) break;
          overflow.push(v.run_id);
          total -= v.size;
          if (!ytByRun.get(v.run_id)) summary.cap_deleted_unpublished += 1;
        }
        if (overflow.length > 0) {
          const capRes = await deleteVideosByRunIds(overflow);
          for (const runId of capRes.deletedIds) {
            const docId = docByRun2.get(runId);
            if (!docId) continue;
            try {
              await adminDb().collection("runs_index").doc(docId).update({
                has_video: false, video_url: "", public_url: "",
                video_storage: ytByRun.get(runId) ? "youtube_only" : "deleted",
              });
            } catch { /* bytes are gone regardless */ }
          }
          summary.cap_deleted = capRes.deleted;
          summary.videos_freed_mb += capRes.freed_mb_estimate;
          logRoute(reqId, "cleanup: size cap enforced", {
            cap_gb: capGb, deleted: capRes.deleted,
            unpublished: summary.cap_deleted_unpublished,
            freed_mb: capRes.freed_mb_estimate,
          });
        }
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

// Heartbeat wrapper: records that this job ran, and what it did,
// so a job that silently stops shows up as stale on the health page.
export const POST = withHeartbeat("cleanup", _handler);

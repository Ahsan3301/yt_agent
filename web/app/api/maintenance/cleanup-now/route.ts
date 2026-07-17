import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { verifyOraclePassword, hashOraclePassword } from "@/lib/oracle_password";
import { deleteVideosByRunIds } from "@/lib/storage-delete";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/cleanup-now
 *
 * User-triggered cleanup. Password-gated (settings.cleanup_password_hash).
 * Body: { password: string, days?: number }
 *
 * Prunes everything older than `days` (default 1):
 *   - jobs (failed / complete / cancelled)
 *   - orphan queued jobs (any age >2h with no backend)
 *   - runs_index + run_summaries
 *   - errors log entries
 *   - idempotency records
 *   - R2 videos (via a live worker)
 *
 * Logs a row into cleanup_runs so /reports can display history.
 */

const ORPHAN_QUEUED_HOURS = 2;

type CleanupSummary = {
  req_id: string;
  triggered_by: "operator" | "cron";
  days: number;
  runs_deleted: number;
  summaries_deleted: number;
  jobs_deleted: number;
  orphan_queued_failed: number;
  errors_deleted: number;
  idempotency_deleted: number;
  videos_requested: number;
  detail: string[];
  errors: string[];
  freed_estimate_mb: number;
  ts: number;
};

async function _getCleanupPasswordHash(): Promise<string | null> {
  try {
    const doc = await adminDb().collection("settings").doc("cleanup_password").get();
    if (!doc.exists) return null;
    // PB settings schema is {id, data (json), updated_at} — the hash
    // lives inside `data` since PB drops any top-level fields not in
    // the collection schema. Firestore path (if ever used) would still
    // work because it accepts arbitrary top-level fields, but we
    // normalise on `.data.hash` everywhere.
    const d = doc.data() as { data?: { hash?: string }; hash?: string } | undefined;
    return d?.data?.hash || d?.hash || null;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  const reqId = newRequestId();
  const body = await req.json().catch(() => ({})) as { password?: string; days?: number };
  const pwd = String(body.password || "").trim();
  if (!pwd) {
    return NextResponse.json({ error: "password required" }, { status: 401 });
  }

  const storedHash = await _getCleanupPasswordHash();
  if (!storedHash) {
    return NextResponse.json({
      error: "no cleanup password set — configure via PUT /api/settings/cleanup-password first",
    }, { status: 409 });
  }
  if (!verifyOraclePassword(pwd, storedHash)) {
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  }

  // days=N means "delete anything finished more than N days ago" —
  // i.e. "N days AND OLDER", not "exactly N days old". A row that
  // finished 24h+ ago is deleted when days=1.
  const days = Math.max(0, Math.min(365, Number(body.days) || 1));
  const now = Date.now() / 1000;
  const cutoff = now - days * 86400;

  // Snapshot the pre-cleanup totals so /reports can display historical
  // numbers even after the source rows are gone. Belt-and-braces: this
  // gets stashed into the cleanup_runs record at the end so it survives
  // every future cleanup (cleanup_runs itself is never auto-deleted —
  // see the top-of-file docstring + the deliberate absence from every
  // delete loop below).
  let preSnapshot = {
    jobs_total: 0,
    jobs_complete: 0,
    jobs_failed: 0,
    videos_total: 0,
    errors_total: 0,
  };
  try {
    const [jobsSnap, runsSnap, errorsSnap] = await Promise.all([
      adminDb().collection("jobs").get(),
      adminDb().collection("runs_index").get(),
      adminDb().collection("errors").get(),
    ]);
    preSnapshot.jobs_total = jobsSnap.size;
    jobsSnap.forEach((doc) => {
      const st = String((doc.data() as { status?: string }).status || "");
      if (st === "complete") preSnapshot.jobs_complete += 1;
      else if (st === "failed") preSnapshot.jobs_failed += 1;
    });
    runsSnap.forEach((doc) => {
      const d = doc.data() as { has_video?: boolean };
      if (d.has_video) preSnapshot.videos_total += 1;
    });
    preSnapshot.errors_total = errorsSnap.size;
  } catch { /* soft-fail; snapshot is best-effort */ }

  const summary: CleanupSummary = {
    req_id: reqId,
    triggered_by: "operator",
    days,
    runs_deleted: 0,
    summaries_deleted: 0,
    jobs_deleted: 0,
    orphan_queued_failed: 0,
    errors_deleted: 0,
    idempotency_deleted: 0,
    videos_requested: 0,
    detail: [],
    errors: [],
    freed_estimate_mb: 0,
    ts: now,
  };

  // ── runs_index + run_summaries + capture video ids for storage delete ─
  // Server-side filter (same pattern as errors cleanup below which
  // reliably works). Earlier version used .get() with client-side
  // filter but PB batch delete never actually fired the row deletions
  // in that path — the emulated batch commits individually via
  // fetch() and something in the pagination silently dropped rows.
  // Filtering server-side keeps the request small + explicit.
  //
  // The set of run_ids whose videos need deleting from S3 is captured
  // HERE, before the row is dropped from PB — otherwise the later
  // storage-delete pass finds nothing to work on.
  const videoRunIdsToDelete: string[] = [];
  try {
    const snap = await adminDb().collection("runs_index")
      .where("finished_at", "<", cutoff)
      .where("finished_at", ">", 0)   // exclude null/zero
      .limit(500)
      .get();
    let n = 0;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      if (d.has_video) videoRunIdsToDelete.push(doc.id);
      try {
        await doc.ref.delete();
        // run_summaries mirrors runs_index by id — delete both.
        await adminDb().collection("run_summaries").doc(doc.id).delete();
        n += 1;
      } catch (_de) {
        summary.errors.push(`run delete ${doc.id}: ${String(_de)}`);
      }
    }
    summary.runs_deleted = n;
    summary.summaries_deleted = n;
    if (n > 0) summary.detail.push(`Deleted ${n} runs_index + run_summaries entries older than ${days}d`);
  } catch (e) {
    summary.errors.push(`runs cleanup: ${String(e)}`);
  }

  // ── jobs (terminal) ────────────────────────────────────────
  // Safety: never delete a job whose id is CURRENTLY held by a live
  // backend's active_job_id — even if it's already in a terminal
  // status. Otherwise the side-worker's Python process keeps running
  // a ghost render whose PB row is gone, blocking its main loop from
  // claiming the next queued job. Confirmed live 2026-07-10.
  const activeJobIds = new Set<string>();
  try {
    const backSnap = await adminDb().collection("backends").limit(20).get();
    backSnap.forEach((doc) => {
      const d = doc.data() as { active_job_id?: string; last_seen_at?: number };
      const seen = Number(d.last_seen_at || 0);
      // Only trust "live" backends (heartbeat within 5 min) — a stale
      // active_job_id from a long-dead worker shouldn't block cleanup.
      if (d.active_job_id && seen > now - 300) {
        activeJobIds.add(String(d.active_job_id));
      }
    });
  } catch { /* soft-fail; worst case we're overly permissive */ }

  try {
    let total = 0;
    let skippedActive = 0;
    for (const st of ["complete", "failed", "cancelled"] as const) {
      const snap = await adminDb().collection("jobs")
        .where("status", "==", st)
        .where("finished_at", "<", cutoff)
        .where("finished_at", ">", 0)
        .limit(500)
        .get();
      for (const doc of snap.docs) {
        if (activeJobIds.has(doc.id)) { skippedActive += 1; continue; }
        try { await doc.ref.delete(); total += 1; }
        catch (_de) { summary.errors.push(`job delete ${doc.id}: ${String(_de)}`); }
      }
    }
    summary.jobs_deleted = total;
    if (total > 0) summary.detail.push(`Deleted ${total} terminal jobs older than ${days}d`);
    if (skippedActive > 0) summary.detail.push(`Skipped ${skippedActive} jobs still held by a live backend's active_job_id`);
  } catch (e) {
    summary.errors.push(`jobs cleanup: ${String(e)}`);
  }

  // ── orphan queued jobs ──────
  // Live-worker-aware threshold (2026-07-17, matches maintenance/cleanup):
  // a deep queue being actively drained by one worker is NOT orphaned.
  // 24h when any backend heartbeated <10 min ago; 2h only when nothing
  // is alive.
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
    const orphanCutoff = now - effectiveHours * 3600;
    const snap = await adminDb().collection("jobs")
      .where("status", "==", "queued")
      .where("queued_at", "<", orphanCutoff)
      .limit(500)
      .get();
    let n = 0;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      // Skip if a backend actually claimed it (defensive — the queued
      // filter should already have excluded these, but the field is
      // sometimes set on the same doc during a race).
      if (d.backend_instance_id) continue;
      try {
        await doc.ref.update({
          status: "failed",
          error: `orphaned in queue >${effectiveHours}h with no backend claim`,
          finished_at: now,
        });
        n += 1;
      } catch (_ue) {
        summary.errors.push(`orphan update ${doc.id}: ${String(_ue)}`);
      }
    }
    summary.orphan_queued_failed = n;
    if (n > 0) summary.detail.push(`Marked ${n} orphan-queued jobs (>${effectiveHours}h) as failed`);
  } catch (e) {
    summary.errors.push(`orphan queued: ${String(e)}`);
  }

  // ── errors log ─────────────────────────────────────────────
  try {
    const snap = await adminDb().collection("errors")
      .where("ts", "<", cutoff).limit(500).get();
    let n = 0;
    for (const doc of snap.docs) {
      try { await doc.ref.delete(); n += 1; }
      catch (_de) { summary.errors.push(`error delete ${doc.id}: ${String(_de)}`); }
    }
    summary.errors_deleted = n;
    if (n > 0) summary.detail.push(`Deleted ${n} error-log entries older than ${days}d`);
  } catch (e) {
    summary.errors.push(`errors cleanup: ${String(e)}`);
  }

  // ── idempotency (kept short — 7d ceiling; days<7 uses days) ─
  // PB's idempotency collection may not have an expires_at column
  // depending on migration state — try server-side filter first,
  // fall through to a client-side sweep on the small collection.
  try {
    const idempCutoff = Math.min(cutoff, now - 7 * 86400);
    let n = 0;
    let usedFallback = false;
    try {
      const snap = await adminDb().collection("idempotency")
        .where("expires_at", "<", idempCutoff)
        .limit(500).get();
      for (const doc of snap.docs) {
        try { await doc.ref.delete(); n += 1; }
        catch (_de) { summary.errors.push(`idem delete ${doc.id}: ${String(_de)}`); }
      }
    } catch (_fe) {
      // Server-side filter refused — probably missing schema field.
      // Do a bounded client-side sweep instead.
      usedFallback = true;
      const snap = await adminDb().collection("idempotency").limit(500).get();
      for (const doc of snap.docs) {
        const d = doc.data() as { expires_at?: number };
        const exp = typeof d.expires_at === "number" ? d.expires_at : 0;
        if (exp > 0 && exp < idempCutoff) {
          try { await doc.ref.delete(); n += 1; }
          catch (_de) { summary.errors.push(`idem delete ${doc.id}: ${String(_de)}`); }
        }
      }
    }
    summary.idempotency_deleted = n;
    if (n > 0) summary.detail.push(`Deleted ${n} idempotency records${usedFallback ? " (client-side fallback)" : ""}`);
  } catch (e) {
    summary.errors.push(`idempotency: ${String(e)}`);
  }

  // ── Videos (server-side S3 delete — no worker required) ────
  // Previously fanned out DELETE requests to a live GPU worker's
  // /api/runs/<id> which was the only place holding S3 creds. The
  // dashboard container also has them (S3_ENDPOINT_INTERNAL +
  // S3_ACCESS_KEY_ID etc.), so we call the bucket directly and skip
  // the worker entirely. Works even when Kaggle + Colab are both
  // offline. Uses the list captured during the runs_index deletion
  // pass above (rows are already gone by now).
  try {
    summary.videos_requested = videoRunIdsToDelete.length;
    if (videoRunIdsToDelete.length > 0) {
      const res = await deleteVideosByRunIds(videoRunIdsToDelete);
      summary.freed_estimate_mb = res.freed_mb_estimate;
      summary.detail.push(
        `Deleted ${res.deleted} videos from storage (~${res.freed_mb_estimate} MB freed)`
        + (res.failed > 0 ? `; ${res.failed} delete calls failed` : "")
      );
      if (res.errors.length) {
        summary.errors.push(`video deletes: ${res.errors.join(" | ")}`);
      }
    }
  } catch (e) {
    summary.errors.push(`videos: ${String(e)}`);
  }

  // ── Persist the cleanup summary + pre-cleanup snapshot ─────
  // cleanup_runs is retained FOREVER — deliberately excluded from
  // every delete loop above so the operator can audit what happened
  // months / years later. `pre_snapshot` lets /reports show the
  // historical picture even after the source rows are pruned.
  //
  // Note: PB adapter doesn't support Firestore's auto-id .add() —
  // synthesise a 15-char id (PB constraint) from reqId + timestamp
  // and use .doc(id).set() instead.
  try {
    const logId = (reqId + Date.now().toString(36)).toLowerCase()
      .replace(/[^a-z0-9]/g, "").slice(0, 15).padEnd(15, "0");
    await adminDb().collection("cleanup_runs").doc(logId).set({
      ts: now,
      req_id: reqId,
      triggered_by: "operator",
      days,
      runs_deleted: summary.runs_deleted,
      summaries_deleted: summary.summaries_deleted,
      jobs_deleted: summary.jobs_deleted,
      orphan_queued_failed: summary.orphan_queued_failed,
      errors_deleted: summary.errors_deleted,
      idempotency_deleted: summary.idempotency_deleted,
      videos_requested: summary.videos_requested,
      freed_estimate_mb: summary.freed_estimate_mb,
      detail: summary.detail,
      errors: summary.errors,
      pre_snapshot: preSnapshot,
      created_at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    summary.errors.push(`cleanup_runs log: ${String(e)}`);
  }

  logRoute(reqId, "cleanup-now done", summary as unknown as Record<string, unknown>);
  return NextResponse.json(summary);
}

// ── Password management sibling handlers ──────────────────────
// Auth chain for set / replace / clear:
//   1) If a cleanup password already exists, submit it via
//      `current_password` (unlocks routine rotation without needing
//      the Oracle secret).
//   2) OR submit ORACLE_UNLOCK_PASSWORD via `oracle_password`
//      (bootstraps the FIRST password, recovers from a lost one,
//      and hardens the flow — env-only secret, never returned).
//   3) OR present the platform X-API-Key header (server-to-server).
//
// Without one of those, the endpoint refuses — so a fresh dashboard
// with no cleanup password set does NOT let a random logged-in user
// hijack the cleanup gate by simply setting one. They must know
// either the operator's Oracle unlock password or the API key.
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    action?: "set" | "clear";
    password?: string;
    current_password?: string;
    oracle_password?: string;
  };
  const action = body.action;
  if (!action) return NextResponse.json({ error: "action required" }, { status: 400 });

  const oracleEnv = (process.env.ORACLE_UNLOCK_PASSWORD || "").trim();
  const oracleSubmitted = String(body.oracle_password || "").trim();
  const oracleOk = !!oracleEnv && !!oracleSubmitted && oracleEnv === oracleSubmitted;
  const apiKeyOk = req.headers.get("x-api-key") === (process.env.RENDER_TRIGGER_KEY || "__no_key__");

  const storedHash = await _getCleanupPasswordHash();
  const currentOk =
    !!storedHash &&
    !!body.current_password &&
    verifyOraclePassword(String(body.current_password), storedHash);

  if (!currentOk && !oracleOk && !apiKeyOk) {
    return NextResponse.json({
      error: storedHash
        ? "provide current_password OR oracle_password"
        : "no cleanup password set — provide oracle_password (ORACLE_UNLOCK_PASSWORD env) to bootstrap",
    }, { status: 401 });
  }

  if (action === "clear") {
    try {
      await adminDb().collection("settings").doc("cleanup_password").delete();
      return NextResponse.json({ ok: true, has_password: false });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  const newP = String(body.password || "").trim();
  if (newP.length < 4) {
    return NextResponse.json({ error: "password must be at least 4 characters" }, { status: 400 });
  }
  try {
    // Nest inside `data` so it lands in the existing PB JSON column
    // (see _getCleanupPasswordHash — top-level fields not in the
    // schema get silently dropped by PB).
    await adminDb().collection("settings").doc("cleanup_password").set({
      data: { hash: hashOraclePassword(newP) },
      updated_at: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, has_password: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// GET returns { has_password, oracle_unlock_configured } — the second
// bool lets the UI tell the operator whether bootstrap is even possible
// (ORACLE_UNLOCK_PASSWORD must be set on the dashboard container).
export async function GET() {
  const hash = await _getCleanupPasswordHash();
  const oracleConfigured = !!(process.env.ORACLE_UNLOCK_PASSWORD || "").trim();
  return NextResponse.json({
    has_password: !!hash,
    oracle_unlock_configured: oracleConfigured,
  });
}

function _toEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "_seconds" in v) return (v as { _seconds: number })._seconds;
  if (typeof v === "object" && v !== null && "seconds" in v) return (v as { seconds: number }).seconds;
  return null;
}

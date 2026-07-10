import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute, pickWorkers } from "@/app/api/_lib/orchestrator";
import { verifyOraclePassword, hashOraclePassword } from "@/lib/oracle_password";

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
    const d = doc.data() as { hash?: string } | undefined;
    return d?.hash || null;
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

  const days = Math.max(0, Math.min(365, Number(body.days) || 1));
  const now = Date.now() / 1000;
  const cutoff = now - days * 86400;

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

  // ── runs_index + run_summaries ─────────────────────────────
  try {
    const snap = await adminDb().collection("runs_index").get();
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
    if (n > 0) summary.detail.push(`Deleted ${n} runs_index + run_summaries entries older than ${days}d`);
  } catch (e) {
    summary.errors.push(`runs cleanup: ${String(e)}`);
  }

  // ── jobs (terminal) ────────────────────────────────────────
  try {
    const snap = await adminDb().collection("jobs")
      .where("status", "in", ["complete", "failed", "cancelled"]).get();
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
    if (n > 0) summary.detail.push(`Deleted ${n} terminal jobs older than ${days}d`);
  } catch (e) {
    summary.errors.push(`jobs cleanup: ${String(e)}`);
  }

  // ── orphan queued jobs (always 2h regardless of days) ──────
  try {
    const orphanCutoff = now - ORPHAN_QUEUED_HOURS * 3600;
    const snap = await adminDb().collection("jobs").where("status", "==", "queued").get();
    const batch = adminDb().batch();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (d.backend_instance_id) return;
      const q = _toEpoch(d.queued_at);
      if (q != null && q < orphanCutoff) {
        batch.update(doc.ref, {
          status: "failed",
          error: `orphaned in queue >${ORPHAN_QUEUED_HOURS}h with no backend claim`,
          finished_at: now,
        });
        n += 1;
      }
    });
    if (n > 0) await batch.commit();
    summary.orphan_queued_failed = n;
    if (n > 0) summary.detail.push(`Marked ${n} orphan-queued jobs (>${ORPHAN_QUEUED_HOURS}h) as failed`);
  } catch (e) {
    summary.errors.push(`orphan queued: ${String(e)}`);
  }

  // ── errors log ─────────────────────────────────────────────
  try {
    const snap = await adminDb().collection("errors")
      .where("ts", "<", cutoff).limit(500).get();
    if (!snap.empty) {
      const batch = adminDb().batch();
      snap.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      summary.errors_deleted = snap.size;
      summary.detail.push(`Deleted ${snap.size} error-log entries older than ${days}d`);
    }
  } catch (e) {
    summary.errors.push(`errors cleanup: ${String(e)}`);
  }

  // ── idempotency (kept short — 7d ceiling; days<7 uses days) ─
  try {
    const idempCutoff = Math.min(cutoff, now - 7 * 86400);
    const snap = await adminDb().collection("idempotency").get();
    const batch = adminDb().batch();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const exp = _toEpoch(d.expires_at);
      if (exp != null && exp < idempCutoff) {
        batch.delete(doc.ref);
        n += 1;
      }
    });
    if (n > 0) await batch.commit();
    summary.idempotency_deleted = n;
    if (n > 0) summary.detail.push(`Deleted ${n} idempotency records`);
  } catch (e) {
    summary.errors.push(`idempotency: ${String(e)}`);
  }

  // ── R2 videos via live worker (fire-and-forget) ────────────
  try {
    const workers = await pickWorkers();
    if (workers.length === 0) {
      summary.detail.push(`R2 video cleanup skipped — no worker alive`);
    } else {
      const snap = await adminDb().collection("runs_index").get();
      const toDelete: string[] = [];
      snap.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        const fin = _toEpoch(d.finished_at);
        if (fin != null && fin < cutoff && d.has_video) toDelete.push(doc.id);
      });
      summary.videos_requested = toDelete.length;
      if (toDelete.length > 0) {
        const w = workers[0];
        for (const id of toDelete) {
          fetch(`${w.url.replace(/\/$/, "")}/api/runs/${id}`, {
            method: "DELETE",
            headers: { "X-Request-Id": reqId, "X-Vercel-Gateway": "1" },
          }).catch(() => {});
        }
        // Estimate ~15MB per shorts video
        summary.freed_estimate_mb = toDelete.length * 15;
        summary.detail.push(`Requested ${toDelete.length} R2 video deletions via worker`);
      }
    }
  } catch (e) {
    summary.errors.push(`videos: ${String(e)}`);
  }

  // ── Persist the cleanup summary for /reports history ───────
  try {
    await adminDb().collection("cleanup_runs").add({
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
      created_at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    summary.errors.push(`cleanup_runs log: ${String(e)}`);
  }

  logRoute(reqId, "cleanup-now done", summary as unknown as Record<string, unknown>);
  return NextResponse.json(summary);
}

// ── Password management sibling handlers ──────────────────────
// Kept in the same file to avoid a separate route just for a hash write.
// POST { action:"set", password:"..." } / { action:"clear" }
// with X-API-Key auth OR the current password.
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    action?: "set" | "clear";
    password?: string;
    current_password?: string;
  };
  const action = body.action;
  if (!action) return NextResponse.json({ error: "action required" }, { status: 400 });

  const storedHash = await _getCleanupPasswordHash();
  // If a hash exists, require current_password OR platform key.
  if (storedHash) {
    const cur = String(body.current_password || "");
    const okAuth =
      (cur && verifyOraclePassword(cur, storedHash)) ||
      req.headers.get("x-api-key") === (process.env.RENDER_TRIGGER_KEY || "__no_key__");
    if (!okAuth) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  if (action === "clear") {
    try {
      await adminDb().collection("settings").doc("cleanup_password").delete();
      return NextResponse.json({ ok: true, has_password: false });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  // set
  const newP = String(body.password || "").trim();
  if (newP.length < 4) {
    return NextResponse.json({ error: "password must be at least 4 characters" }, { status: 400 });
  }
  try {
    await adminDb().collection("settings").doc("cleanup_password").set({
      hash: hashOraclePassword(newP),
      updated_at: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, has_password: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// GET returns only has_password (never the hash).
export async function GET() {
  const hash = await _getCleanupPasswordHash();
  return NextResponse.json({ has_password: !!hash });
}

function _toEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "_seconds" in v) return (v as { _seconds: number })._seconds;
  if (typeof v === "object" && v !== null && "seconds" in v) return (v as { seconds: number }).seconds;
  return null;
}

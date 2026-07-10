import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { verifyOraclePassword } from "@/lib/oracle_password";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/jobs/claim
 *
 * Request body:
 *   {
 *     instance_id,
 *     instance_label?: "kaggle" | "colab" | "oracle",  // canonical label
 *     channel?: string,
 *     tier?: "gpu"|"cpu"|"dashboard",
 *     oracle_password?: string,  // shared Oracle unlock, sent only by Oracle side-worker
 *   }
 */

const LIVE_HEARTBEAT_WINDOW_SEC = 90;

// Infer canonical "kaggle" | "colab" | "oracle" from either an
// explicit label in the body, INSTANCE_LABEL string, or tier.
function _canonicalLabel(body: Record<string, unknown>): "kaggle" | "colab" | "oracle" | "" {
  const raw = String(body.instance_label || "").toLowerCase().trim();
  if (raw === "kaggle" || raw === "colab" || raw === "oracle") return raw;
  if (raw.includes("kaggle")) return "kaggle";
  if (raw.includes("colab")) return "colab";
  if (raw.includes("oracle")) return "oracle";
  // Fall back: dashboard-tier workers are always the Oracle side-worker.
  if (String(body.tier || "").toLowerCase() === "dashboard") return "oracle";
  return "";
}

// Fetch the currently-live worker labels (backends collection, heartbeat
// within LIVE_HEARTBEAT_WINDOW_SEC). Used to enforce priority: a
// lower-priority worker only claims when every higher-priority worker
// on the job's allowed_workers list is offline.
async function _liveWorkerLabels(dbc: ReturnType<typeof adminDb>): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const snap = await dbc.collection("backends").limit(50).get();
    const cutoff = Date.now() / 1000 - LIVE_HEARTBEAT_WINDOW_SEC;
    snap.forEach((doc) => {
      const d = doc.data() as { last_seen_at?: number | { toMillis?: () => number }; instance_label?: string; tier?: string; shutdown_pending?: boolean; status?: string };
      if (d.shutdown_pending || d.status === "shutdown_requested") return;
      const rawTs = d.last_seen_at;
      const seenSec = typeof rawTs === "number"
        ? rawTs
        : (rawTs && typeof rawTs === "object" && typeof rawTs.toMillis === "function")
          ? rawTs.toMillis() / 1000
          : 0;
      if (seenSec < cutoff) return;
      const label = String(d.instance_label || "").toLowerCase();
      if (label.includes("kaggle")) out.add("kaggle");
      else if (label.includes("colab")) out.add("colab");
      else if (label.includes("oracle") || String(d.tier || "") === "dashboard") out.add("oracle");
    });
  } catch { /* soft-fail, no priority gating */ }
  return out;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("x-api-key") || "";
  const expected = process.env.RENDER_TRIGGER_KEY || "";
  if (!expected || auth !== expected) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const instance_id = String(body.instance_id || "").slice(0, 128);
    if (!instance_id) {
      return NextResponse.json({ error: "instance_id required" }, { status: 400 });
    }

    const db = adminDb();

    // Termination signal
    try {
      const backSnap = await db.collection("backends").doc(instance_id).get();
      if (backSnap.exists) {
        const bd = backSnap.data() as { shutdown_pending?: boolean; status?: string };
        if (bd.shutdown_pending || bd.status === "shutdown_requested") {
          return NextResponse.json({ ok: true, shutdown: true, job: null });
        }
      }
    } catch { /* soft-fail */ }

    const snap = await db.collection("jobs")
      .where("status", "==", "queued")
      .orderBy("queued_at", "asc")
      .limit(5)
      .get();

    if (snap.empty) {
      return new NextResponse(null, { status: 204 });
    }

    const now = Date.now() / 1000;
    const workerTier = String(body.tier || "gpu");
    const workerLabel = _canonicalLabel(body);
    const oraclePlain = String(body.oracle_password || "");

    // Priority set — only fetched if any candidate job actually has
    // allowed_workers set. Cached across the loop.
    let liveLabels: Set<string> | null = null;

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (body.channel && data.channel !== body.channel) continue;

      const runAt = Number(data.run_at ?? 0);
      if (runAt > 0 && runAt > now) continue;

      // Legacy target_worker gate
      const target = String(data.target_worker || "");
      if (target) {
        if (target === "dashboard" && workerTier !== "dashboard") continue;
        if (target === "gpu"       && workerTier !== "gpu")       continue;
        if (target === "cpu"       && workerTier === "gpu")       continue;
        if (
          target !== "dashboard" && target !== "gpu" && target !== "cpu" &&
          target !== instance_id
        ) continue;
      }

      const kind = String(data.kind || "render");
      const SIDE_JOB_KINDS = new Set(["publish_youtube", "copy_storage"]);
      // Old rule was: dashboard tier ONLY does side-jobs. New rule:
      // dashboard tier can do full renders too if the channel's
      // allowed_workers list includes "oracle" — SDXL is skipped
      // gracefully on that path.
      const allowedRaw = data.allowed_workers;
      const allowedList: string[] = Array.isArray(allowedRaw)
        ? (allowedRaw as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const oracleAllowedForRender = allowedList.includes("oracle");
      if (workerTier === "dashboard" && !SIDE_JOB_KINDS.has(kind) && !oracleAllowedForRender) {
        continue;
      }

      // Per-channel worker allowlist + priority
      if (allowedList.length > 0 && !SIDE_JOB_KINDS.has(kind)) {
        // If we couldn't infer this worker's canonical label, we can't
        // safely honor the allowlist — skip the job to avoid picking
        // it up on a worker the channel forbade.
        if (!workerLabel) continue;
        if (!allowedList.includes(workerLabel)) continue;

        // Priority: only the HIGHEST-priority currently-live worker in
        // the allowlist may claim. If a Kaggle worker is live and Kaggle
        // has priority 1, Colab (priority 2) skips this job even though
        // Colab is technically allowed.
        if (liveLabels === null) liveLabels = await _liveWorkerLabels(db);
        let takenBy: string | null = null;
        for (const cand of allowedList) {
          if (liveLabels.has(cand)) { takenBy = cand; break; }
        }
        if (takenBy && takenBy !== workerLabel) continue;
      }

      // Oracle password gate — only enforced when this worker is Oracle
      // AND the channel put a password hash on the job.
      const oracleHash = String(data.oracle_password_hash || "");
      if (workerLabel === "oracle" && oracleHash) {
        if (!oraclePlain || !verifyOraclePassword(oraclePlain, oracleHash)) {
          continue;
        }
      }
      // Reverse: if the channel set a password but this worker is NOT
      // Oracle and Oracle IS the only allowed worker, we already
      // filtered out above. If Oracle is one of several, the higher-
      // priority workers still get first shot without the password.

      try {
        await doc.ref.update({
          status:               "claimed",
          backend_instance_id:  instance_id,
          claimed_at:           now,
          updated_at:           FieldValue.serverTimestamp(),
        });
        return NextResponse.json({
          ok:   true,
          job:  { id: doc.id, ...data,
                  status: "claimed",
                  backend_instance_id: instance_id },
        });
      } catch {
        continue;
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

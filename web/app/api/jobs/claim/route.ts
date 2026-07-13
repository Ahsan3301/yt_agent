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

// Boot-grace windows — how long the queue waits for each worker to boot
// before escalating to the next-priority one. Tuned to each worker's
// typical cold-start:
//   kaggle → ~2-3 min for kernel wake + git clone + preboot. 8 min gives
//            headroom for GH Actions queue lag + dep install.
//   colab  → user has to click "Connect" in the browser. 15 min covers
//            the "operator was AFK when the job queued" case.
//   oracle → always-on side-worker. 0 grace.
// A job with allowed_workers=[kaggle,colab,oracle] flows:
//   t=0..8min      → only Kaggle can claim
//   t=8..23min     → Kaggle+Colab can claim; Kaggle wins if both alive
//   t=23min+       → Kaggle+Colab+Oracle can claim; highest live wins
const BOOT_GRACE_SEC: Record<string, number> = {
  kaggle: 8 * 60,
  colab:  15 * 60,
  oracle: 0,
};

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

      // Per-channel worker allowlist + STAGED priority handover
      if (allowedList.length > 0 && !SIDE_JOB_KINDS.has(kind)) {
        if (!workerLabel) continue;
        if (!allowedList.includes(workerLabel)) continue;

        const myIndex = allowedList.indexOf(workerLabel);
        const queuedAt = Number(data.queued_at ?? now);
        const jobAgeSec = now - queuedAt;

        // Cumulative grace before MY slot opens — sum of every
        // higher-priority worker's boot window. Until that time
        // elapses, only workers above me may claim; I must wait.
        let cumGraceBeforeMe = 0;
        for (let i = 0; i < myIndex; i++) {
          cumGraceBeforeMe += BOOT_GRACE_SEC[allowedList[i]] ?? 0;
        }
        if (jobAgeSec < cumGraceBeforeMe) continue;

        // My slot is open. But if a HIGHER-priority worker whose slot
        // has ALSO opened is currently alive, they get first crack.
        // For each entry above me: check if its slot has opened and
        // it's heartbeating — if so, skip so they can grab it.
        if (liveLabels === null) liveLabels = await _liveWorkerLabels(db);
        let higherPriorityEligible: string | null = null;
        let cumGraceForCheck = 0;
        for (let i = 0; i < myIndex; i++) {
          const other = allowedList[i];
          // `other`'s slot opens at cumGraceForCheck (sum of graces
          // for entries 0..i-1). Since we're iterating with i and
          // cumGraceForCheck starts at 0 for i=0, this is correct.
          if (jobAgeSec >= cumGraceForCheck && liveLabels.has(other)) {
            higherPriorityEligible = other;
            break;
          }
          cumGraceForCheck += BOOT_GRACE_SEC[other] ?? 0;
        }
        if (higherPriorityEligible) continue;
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

      // Atomic claim via Firestore transaction. Before the 2026-07-13
      // audit this was a plain `doc.ref.update()` with NO precondition
      // — two concurrent workers hitting /api/jobs/claim within ~100ms
      // both saw status="queued" in the outer query, both wrote
      // status="claimed", and both returned the same job body →
      // duplicate publish to YouTube. Re-read status inside the
      // transaction and fail-fast if it's not still queued.
      try {
        const claimed = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) return false;
          const curStatus = String((fresh.data() || {}).status || "");
          if (curStatus !== "queued") return false;
          tx.update(doc.ref, {
            status:              "claimed",
            backend_instance_id: instance_id,
            claimed_at:          now,
            updated_at:          FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (!claimed) {
          // Someone else got there first — try the next queued doc.
          continue;
        }
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

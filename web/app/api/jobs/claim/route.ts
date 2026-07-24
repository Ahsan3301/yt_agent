import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { verifyOraclePassword } from "@/lib/oracle_password";
import { getFlag } from "@/lib/flags";

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

// Load the channels collection once per claim request, keyed by channel
// NAME (jobs store source_channel_name). Used to resolve the CURRENT
// allowed_workers for each queued job instead of the snapshot the job
// captured at creation time.
//
// Why (2026-07-15): jobs copy allowed_workers when queued. If the
// operator toggles Kaggle OFF on a channel while jobs are still queued,
// those jobs kept the stale list — needs-worker saw them as
// kaggle-eligible and woke a Kaggle kernel that would boot into an
// empty queue (Oracle claimed the job meanwhile). The live lookup makes
// worker toggles take effect immediately for everything still in queue.
async function _channelsByName(dbc: ReturnType<typeof adminDb>): Promise<Map<string, { allowed_workers: string[] }>> {
  const out = new Map<string, { allowed_workers: string[] }>();
  try {
    const snap = await dbc.collection("channels").limit(100).get();
    snap.forEach((doc) => {
      const c = doc.data() as { name?: string; allowed_workers?: unknown };
      const name = String(c.name || "").trim();
      if (!name) return;
      const aw = Array.isArray(c.allowed_workers)
        ? (c.allowed_workers as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      out.set(name, { allowed_workers: aw });
    });
  } catch { /* soft-fail → callers fall back to the job snapshot */ }
  return out;
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

    // Phase 2 tenant gate (2026-07-24): when tenant_filter_enforced=true,
    // resolve this worker's owner_user_id + tier_scope (both set by
    // the register route from the worker's registration payload) and
    // reject jobs owned by a different user unless the worker is in
    // the shared pool. Falls through untouched when the flag is off.
    const tenantEnforced = await getFlag("tenant_filter_enforced");
    let workerOwner = "";
    let workerScope = "";
    if (tenantEnforced) {
      try {
        const back = await db.collection("backends").doc(instance_id).get();
        if (back.exists) {
          const bd = back.data() as { owner_user_id?: string; tier_scope?: string };
          workerOwner = String(bd.owner_user_id || "");
          workerScope = String(bd.tier_scope || "");
        }
      } catch { /* soft-fail — treat as shared */ }
    }

    // Priority set — only fetched if any candidate job actually has
    // allowed_workers set. Cached across the loop.
    let liveLabels: Set<string> | null = null;
    // Live channel config — lazily fetched once, cached across the loop.
    let channelsByName: Map<string, { allowed_workers: string[] }> | null = null;

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (body.channel && data.channel !== body.channel) continue;

      // Phase 2 tenant gate — reject cross-tenant jobs. Rules:
      //   (a) job has no owner_user_id (pre-Phase-2 or manually
      //       inserted row) => allow, backward compat.
      //   (b) worker owner_user_id matches job's => allow.
      //   (c) worker is in the shared pool (tier_scope="shared" AND
      //       owner_user_id=""/null) => allow (Phase 5 will further
      //       check the job owner's plan allows shared workers).
      //   (d) otherwise reject.
      if (tenantEnforced) {
        const jobOwner = String(data.owner_user_id || data.user_id || "");
        if (jobOwner) {
          const workerIsShared = !workerOwner && (workerScope === "shared" || workerScope === "");
          const workerMatches = workerOwner && workerOwner === jobOwner;
          if (!workerMatches && !workerIsShared) continue;
        }
      }

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
      const snapshotList: string[] = Array.isArray(allowedRaw)
        ? (allowedRaw as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      // Resolve the CURRENT channel config — worker toggles must apply
      // to already-queued jobs, not just new ones. Falls back to the
      // job's snapshot when the channel row is gone / unnamed.
      if (channelsByName === null) channelsByName = await _channelsByName(db);
      const chanCfg = channelsByName.get(String(data.source_channel_name || "").trim());
      const allowedList: string[] =
        chanCfg && chanCfg.allowed_workers.length > 0
          ? chanCfg.allowed_workers
          : snapshotList;
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

      // Write-then-verify claim (portable across Firestore + PocketBase).
      //
      // 2026-07-13 audit #3 v1 used db.runTransaction(). The PocketBase
      // adapter (web/lib/pocketbase-admin.ts) doesn't implement that
      // method, so on DB_BACKEND=pocketbase (production) the call threw
      // `runTransaction is not a function`, the enclosing catch swallowed
      // it, and EVERY claim silently continued — a full regression.
      //
      // v2 uses the pattern that works on both backends:
      //   1. Pre-check `status` from the query snapshot we already have.
      //   2. PATCH the doc with our instance_id.
      //   3. Re-read the doc; if `backend_instance_id` came back as
      //      ours, we won the race. If not, the other worker's last-
      //      write-wins PATCH stomped ours — continue.
      // Both DBs serialize per-record writes, so exactly one worker's
      // instance_id ends up persisted; the loser sees the winner's ID
      // on re-read and bails out cleanly.
      const preStatus = String(data.status || "");
      if (preStatus !== "queued") continue;
      try {
        await doc.ref.update({
          status:              "claimed",
          backend_instance_id: instance_id,
          claimed_at:          now,
          updated_at:          FieldValue.serverTimestamp(),
        });
        // Verify OUR instance_id stuck (races: two workers PATCH within
        // ms of each other; PB / Firestore serialize but last-write wins).
        // If the verify READ fails transiently, we still RETURN the job:
        // our PATCH succeeded, so we own it with high probability — the
        // alternative (skipping) left the job stuck status='claimed'
        // under a live worker forever, because cleanup-stale only
        // requeues claimed jobs whose instance is dead. Worst case of
        // returning is the rare double-render (same as pre-fix), vs a
        // guaranteed stuck job. (2026-07-17 audit finding.)
        try {
          const check = await doc.ref.get();
          if (check.exists) {
            const checkData = check.data() || {};
            if (String(checkData.backend_instance_id || "") !== instance_id) {
              // Another worker's PATCH landed after ours — they own it.
              continue;
            }
          }
        } catch { /* verify read failed — proceed as owner (see above) */ }
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

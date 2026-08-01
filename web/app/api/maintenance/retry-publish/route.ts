import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { listStorageVideos, storageConfigured } from "@/lib/storage-list";
import { customAlphabet } from "nanoid";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const _shortId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 15);

/**
 * POST /api/maintenance/retry-publish
 *
 * Re-publishes videos that rendered successfully but never reached
 * YouTube (status='needs_publish').
 *
 * Why this exists: a render costs ~20 minutes of GPU, and until now the
 * ONLY way one of these ever got published was an operator noticing the
 * orange badge in the queue and clicking "Retry publish". Found 9 of
 * them stranded from 2026-07-24..26 — the window when the OAuth client
 * was dead. Nobody looked for a week, and by then the disk cleanup had
 * deleted the video files, so all 9 became permanently unpublishable.
 * A finished video sitting unnoticed is the most expensive failure mode
 * the platform has: it has already paid every cost and produces nothing.
 *
 * Deliberately conservative about WHEN it retries:
 *
 *   - Skips accounts whose health_status is 'dead'. A revoked token
 *     fails every attempt, so retrying burns the attempt budget and
 *     buries the real problem (the customer must reconnect). The daily
 *     connection sweep already alerts on that. Once they reconnect,
 *     health flips to 'ok' and the next tick picks the video up with
 *     no further action.
 *   - Caps attempts at MAX_ATTEMPTS. Something failing for a reason we
 *     can't see should stop and stay visible, not retry forever.
 *   - Marks a job 'failed' when its video no longer exists, with the
 *     reason recorded. That state is honest and terminal: the bytes are
 *     gone, so no amount of retrying will help, and leaving it as
 *     'needs_publish' advertises a Retry button that can only 404.
 *
 * Auth: same X-API-Key gate as every other /api/maintenance/* route.
 *
 * Query params:
 *   ?dry_run=1     report what would happen, change nothing
 *   ?max_attempts= override the retry cap (default 3)
 */

const MAX_ATTEMPTS = 3;

type Outcome =
  | { job_id: string; run_id: string; action: "requeued"; publish_job: string }
  | { job_id: string; run_id: string; action: "failed_no_video" }
  | { job_id: string; run_id: string; action: "skipped"; reason: string };

export async function POST(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const maxAttempts = Number(url.searchParams.get("max_attempts") || MAX_ATTEMPTS);
  const reqId = newRequestId();

  try {
    const jobsSnap = await adminDb().collection("jobs").limit(500).get();
    // Kept as {pbId, data} rather than spreading the doc into a flat
    // object: spreading Record<string, unknown> collapses the index
    // signature, so every field read downstream fails to type-check.
    const stranded = jobsSnap.docs
      .map((d) => ({ pbId: d.id, data: d.data() as Record<string, unknown> }))
      .filter((j) => String(j.data.status || "") === "needs_publish");

    if (stranded.length === 0) {
      logRoute(reqId, "retry-publish: nothing stranded");
      return NextResponse.json({ ok: true, dry_run: dryRun, stranded: 0, outcomes: [] });
    }

    // One storage listing for the whole sweep rather than per job.
    let storageRunIds = new Set<string>();
    // Only an authoritative listing may justify marking a job failed.
    // listStorageVideos() returns [] for an unconfigured client exactly
    // as it does for an empty bucket, so without this check a
    // credentials problem would mark every stranded video permanently
    // unpublishable — turning a config error into data loss.
    let storageListed = storageConfigured();
    if (!storageListed) {
      logRoute(reqId, "retry-publish: storage not configured, skipping no-video checks");
    }
    try {
      if (storageListed) {
        storageRunIds = new Set((await listStorageVideos()).map((v) => v.run_id));
      }
    } catch (e) {
      // Can't prove absence if the listing failed. Treat every video as
      // possibly-present so a transient MinIO blip can never mark a job
      // permanently failed for "no video".
      storageListed = false;
      logRoute(reqId, "retry-publish: storage listing failed, skipping no-video checks", { err: String(e) });
    }

    // Health per account, read once.
    const health = new Map<string, string>();
    try {
      const accts = await adminDb().collection("youtube_accounts").limit(200).get();
      accts.forEach((d) => {
        const x = (d.data() || {}) as Record<string, unknown>;
        health.set(d.id, String(x.health_status || "unknown"));
      });
    } catch { /* health unknown → treated as retryable below */ }

    const outcomes: Outcome[] = [];

    for (const { pbId, data: j } of stranded) {
      const jobId = pbId;
      const runId = String(j.run_id || "");
      const acctId = String(j.youtube_account_id || "");

      if (!runId) {
        outcomes.push({ job_id: jobId, run_id: "", action: "skipped", reason: "no run_id on job" });
        continue;
      }

      const attempts = Number(j.publish_retry_count || 0);
      if (attempts >= maxAttempts) {
        outcomes.push({ job_id: jobId, run_id: runId, action: "skipped", reason: `attempt cap (${attempts}/${maxAttempts}) reached` });
        continue;
      }

      // Does the video still exist? Check runs_index first, then storage.
      let hasVideo = false;
      try {
        const byDoc = await adminDb().collection("runs_index").doc(runId).get();
        hasVideo = byDoc.exists;
        if (!hasVideo) {
          const byField = await adminDb().collection("runs_index")
            .where("run_id", "==", runId).limit(1).get();
          hasVideo = !byField.empty;
        }
      } catch { /* fall through to storage */ }
      if (!hasVideo && storageRunIds.has(runId)) hasVideo = true;

      if (!hasVideo) {
        if (!storageListed) {
          outcomes.push({ job_id: jobId, run_id: runId, action: "skipped", reason: "storage unreadable — not judging video presence" });
          continue;
        }
        if (!dryRun) {
          await adminDb().collection("jobs").doc(jobId).update({
            status: "failed",
            error: "Video file no longer exists (removed by storage cleanup) — cannot publish. Re-render to produce a new one.",
            current_step: "done",
            current_step_label: "Failed — video gone",
            updated_at: FieldValue.serverTimestamp(),
          });
        }
        outcomes.push({ job_id: jobId, run_id: runId, action: "failed_no_video" });
        continue;
      }

      // Don't spend attempts against a token we already know is dead.
      const hs = acctId ? (health.get(acctId) || "unknown") : "unknown";
      if (hs === "dead") {
        outcomes.push({ job_id: jobId, run_id: runId, action: "skipped", reason: "YouTube account disconnected — waiting for reconnect" });
        continue;
      }
      if (!acctId) {
        outcomes.push({ job_id: jobId, run_id: runId, action: "skipped", reason: "no youtube_account_id bound to job" });
        continue;
      }

      if (!dryRun) {
        const publishJobId = _shortId();
        const now = Date.now() / 1000;
        await adminDb().collection("jobs").doc(publishJobId).set({
          id:            publishJobId,
          kind:          "publish_youtube",
          status:        "queued",
          // Stamp ownership from the stranded job so the retry stays in
          // the same tenant — never widen scope on an automated path.
          user_id:       String(j.user_id || j.owner_user_id || ""),
          owner_user_id: String(j.owner_user_id || j.user_id || ""),
          run_id:        runId,
          youtube_account_id: acctId,
          title:         String(j.title || ""),
          description:   String(j.description || ""),
          tags:          Array.isArray(j.tags) ? (j.tags as unknown[]).map(String).slice(0, 30) : [],
          channel:       "publish",
          dry_run:       false,
          queued_at:     now,
          created_by:    "maintenance:retry-publish",
          req_id:        reqId,
          current_step:  "publish_youtube",
          current_step_label: "Queued for publish (automatic retry)",
          percent:       0,
          target_worker: "",
          run_at:        0,
          video_source:  "runs_index:field",
          updated_at:    FieldValue.serverTimestamp(),
        });
        await adminDb().collection("jobs").doc(jobId).update({
          publish_retry_count: attempts + 1,
          last_publish_retry_at: now,
          updated_at: FieldValue.serverTimestamp(),
        });
        outcomes.push({ job_id: jobId, run_id: runId, action: "requeued", publish_job: publishJobId });
      } else {
        outcomes.push({ job_id: jobId, run_id: runId, action: "requeued", publish_job: "(dry-run)" });
      }
    }

    const tally = outcomes.reduce<Record<string, number>>((m, o) => {
      m[o.action] = (m[o.action] || 0) + 1;
      return m;
    }, {});
    logRoute(reqId, "retry-publish sweep", { stranded: stranded.length, ...tally });

    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      stranded: stranded.length,
      tally,
      outcomes,
    });
  } catch (e) {
    logRoute(reqId, "retry-publish failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

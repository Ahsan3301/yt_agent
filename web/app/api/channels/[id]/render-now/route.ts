import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/channels/[id]/render-now
 *
 * Queue N fresh render jobs for this channel immediately, ignoring the
 * hour filter used by the daily cron. Uses the channel row's own
 * settings (niche, language, voice, web_research, real_events,
 * youtube_account_id). If no gpu-tier worker is alive, best-effort
 * wakes Kaggle so the jobs actually run instead of sitting in queue.
 *
 * Body (optional): {
 *   dry_run?: boolean,   // default false (publish)
 *   count?:   number,    // default = channel.daily_count (or 1); clamped 1..10
 * }
 *
 * This is the "Run now" button on the /channels page. Default count
 * matches the channel's daily_count so one click reproduces one day's
 * worth of scheduled output.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const reqId = newRequestId();
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "missing channel id" }, { status: 400 });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const dry_run = body.dry_run === true;

  try {
    const ref = adminDb().collection("channels").doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
      return NextResponse.json({ error: "channel not found" }, { status: 404 });
    }
    const c = (doc.data() || {}) as Record<string, unknown>;
    const niche = String(c.niche || "").trim();
    if (!niche) return NextResponse.json({ error: "channel has no niche" }, { status: 400 });

    const yt = (typeof c.youtube_account_id === "string" && c.youtube_account_id)
      ? String(c.youtube_account_id) : null;

    // Count semantics: explicit body.count wins, else channel.daily_count,
    // else 1. Clamped 1..10 to match the scheduled-render ceiling.
    const bodyCount = typeof body.count === "number" ? Number(body.count) : NaN;
    const dailyCount = Math.max(1, Math.min(10, Number(c.daily_count) || 1));
    const count = Number.isFinite(bodyCount) && bodyCount > 0
      ? Math.max(1, Math.min(10, Math.floor(bodyCount)))
      : dailyCount;

    const jobIds: string[] = [];
    const now = Date.now() / 1000;
    for (let i = 0; i < count; i++) {
      // Short 15-char id (PB min length). Prefix so the manual origin
      // is obvious in the queue; each job gets a distinct random suffix.
      const jobId = "run-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-3);
      const job = {
        id: jobId,
        status: "queued" as const,
        channel: niche,
        dry_run,
        // Space queued_at by ms so ordering in the /queue UI is stable.
        queued_at: now + i * 0.001,
        started_at: null,
        finished_at: null,
        percent: 0,
        current_step: null,
        current_step_label: null,
        video_url: null,
        public_url: null,
        error: null,
        run_id: null,
        backend_instance_id: null,
        backend_url: null,
        created_by: "channel-run-now",
        req_id: reqId,
        web_research:
          c.web_research === true ? true :
          c.web_research === false ? false : null,
        real_events:
          c.real_events === true ? true :
          c.real_events === false ? false : null,
        language: (typeof c.language === "string" && c.language) ? String(c.language) : null,
        voice_override: (typeof c.voice === "string" && c.voice) ? String(c.voice) : null,
        // Per-channel tone + privacy overrides — carried on the job so
        // the worker's run_pipeline gets them without a PB round-trip.
        tone_override: (typeof c.tone === "string" && c.tone) ? String(c.tone) : null,
        privacy_override: (c.privacy === "public" || c.privacy === "unlisted" || c.privacy === "private") ? String(c.privacy) : null,
        youtube_account_id: yt,
        unbound: !yt,
        source_channel_name: String(c.name || id),
        updated_at: FieldValue.serverTimestamp(),
      };
      await adminDb().collection("jobs").doc(jobId).set(job);
      jobIds.push(jobId);
    }
    const jobId = jobIds[0];   // legacy field for the toast
    logRoute(reqId, "run-now queued", { channel_id: id, niche, count, job_ids: jobIds, dry_run });

    // Auto-wake Kaggle if there's no live gpu-tier worker. Same logic
    // scheduled-render uses; keeps the "run now" path from silently
    // parking the job in the queue when no worker is alive.
    let woke = false;
    try {
      const backendsSnap = await adminDb().collection("backends").get();
      const nowEpoch = Date.now() / 1000;
      let liveGpu = 0;
      backendsSnap.forEach((d) => {
        const b = d.data() as Record<string, unknown>;
        if (String(b.tier || "") !== "gpu") return;
        const lastSeen = Number(b.last_seen_at || 0);
        if (nowEpoch - lastSeen < 90) liveGpu += 1;
      });
      if (liveGpu === 0) {
        const base = (process.env.COOLIFY_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
        const wakeUrl = base
          ? `${base}/api/backends/wake-kaggle`
          : new URL("/api/backends/wake-kaggle", req.url).toString();
        fetch(wakeUrl, { method: "POST", headers: { "X-Request-Id": reqId } }).catch(() => {});
        woke = true;
        logRoute(reqId, "run-now waking kaggle (no live gpu worker)", { wakeUrl });
      }
    } catch { /* wake is best-effort */ }

    return NextResponse.json({
      ok: true,
      job_id: jobId,        // first queued job (legacy)
      job_ids: jobIds,      // all queued jobs
      count,
      channel: niche,
      dry_run,
      publish_to: yt,
      woke_kaggle: woke,
      req_id: reqId,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e), req_id: reqId }, { status: 500 });
  }
}

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
        allowed_workers: Array.isArray(c.allowed_workers)
          ? (c.allowed_workers as unknown[]).filter((x): x is string => typeof x === "string")
          : [],
        oracle_password_hash: (typeof c.oracle_password_hash === "string" && c.oracle_password_hash)
          ? String(c.oracle_password_hash)
          : null,
        cf_source: String(c.cloudflare_source || "off"),
        cf_own_account_id: c.cloudflare_source === "own"
          ? String(c.cloudflare_account_id || "").trim()
          : "",
        cf_own_api_token: c.cloudflare_source === "own"
          ? String(c.cloudflare_api_token || "").trim()
          : "",
        updated_at: FieldValue.serverTimestamp(),
      };
      await adminDb().collection("jobs").doc(jobId).set(job);
      jobIds.push(jobId);
    }
    const jobId = jobIds[0];   // legacy field for the toast
    logRoute(reqId, "run-now queued", { channel_id: id, niche, count, job_ids: jobIds, dry_run });

    // Smart wake — only fires if the CHANNEL'S primary worker is one
    // we can auto-wake (Kaggle) AND that worker isn't already live.
    // Priority order = channel.allowed_workers[]. If Colab is primary,
    // we don't wake Kaggle (Colab can't be auto-woken; the queue
    // waits + eventually escalates via boot-grace windows in
    // /api/jobs/claim).
    let woke = false;
    try {
      const allowedWorkers = Array.isArray(c.allowed_workers)
        ? (c.allowed_workers as unknown[]).filter((x): x is string => typeof x === "string")
        : ["kaggle", "colab"];
      const primary = allowedWorkers[0] || "kaggle";

      // Which canonical labels are alive right now (90s heartbeat).
      const backendsSnap = await adminDb().collection("backends").get();
      const nowEpoch = Date.now() / 1000;
      const live = new Set<string>();
      backendsSnap.forEach((d) => {
        const b = d.data() as Record<string, unknown>;
        const lastSeen = Number(b.last_seen_at || 0);
        if (nowEpoch - lastSeen >= 90) return;
        const label = String(b.instance_label || "").toLowerCase();
        if (label.includes("kaggle")) live.add("kaggle");
        else if (label.includes("colab")) live.add("colab");
        else if (label.includes("oracle") || String(b.tier || "") === "dashboard") live.add("oracle");
      });

      // NEVER wake a worker the channel excluded. If Kaggle is not
      // in allowed_workers[], the operator explicitly opted out — even
      // as a fallback. The queue just waits + escalates via
      // boot-grace windows.
      const kaggleAllowed = allowedWorkers.includes("kaggle");

      if (primary === "kaggle" && !live.has("kaggle")) {
        // Primary IS Kaggle → obviously kaggleAllowed=true. Fire wake.
        const base = (process.env.COOLIFY_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
        const wakeUrl = base
          ? `${base}/api/backends/wake-kaggle`
          : new URL("/api/backends/wake-kaggle", req.url).toString();
        fetch(wakeUrl, { method: "POST", headers: { "X-Request-Id": reqId } }).catch(() => {});
        woke = true;
        logRoute(reqId, "run-now waking kaggle (primary, not live)", { wakeUrl, primary });
      } else if (primary === "colab" && !live.has("colab") && !live.has("kaggle") && kaggleAllowed) {
        // Colab primary + Colab down + Kaggle also down + Kaggle IS
        // allowed → wake Kaggle so the 15-min Colab grace window has
        // a fallback ready when it expires. If Kaggle is NOT in the
        // channel's allowlist, skip this wake — the operator opted
        // out and we respect that.
        const base = (process.env.COOLIFY_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
        const wakeUrl = base
          ? `${base}/api/backends/wake-kaggle`
          : new URL("/api/backends/wake-kaggle", req.url).toString();
        fetch(wakeUrl, { method: "POST", headers: { "X-Request-Id": reqId } }).catch(() => {});
        woke = true;
        logRoute(reqId, "run-now waking kaggle as colab-primary fallback", { wakeUrl, primary });
      } else {
        logRoute(reqId, "run-now: no wake needed", {
          primary,
          live: Array.from(live),
          kaggle_allowed: kaggleAllowed,
        });
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

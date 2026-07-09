import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { pickWorkers, newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/scheduled-render
 *
 * Daily cron from GitHub Actions. Reads schedules/default and queues
 * the configured number of jobs per channel.
 *
 * - Returns `{ skipped: true }` if `enabled=false` in the schedule doc.
 * - Otherwise queues `daily_targets[channel]` jobs per channel.
 * - Each job is created with `dry_run=!publish_default`.
 *
 * Auth: X-API-Key matching api_keys/RENDER_TRIGGER_KEY.
 */
const SCHEDULE_DOC = ["schedules", "default"] as const;
const DEFAULT_SCHEDULE = {
  enabled: false,
  daily_targets: { horror: 1, wisdom: 0 } as Record<string, number>,
  publish_default: true,
  buffer_seconds: 0,
};

export async function POST(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  try {
    const snap = await adminDb()
      .collection(SCHEDULE_DOC[0])
      .doc(SCHEDULE_DOC[1])
      .get();
    // Loose typing — the Firestore doc shape evolves over time
    // (web_research was added later) so cast to a permissive record
    // and read fields defensively.
    // Pocketbase-shape docs nest the Firestore payload under a `data`
    // JSON column, so snap.data() returns {data: {enabled, ...}, updated_at, ...}.
    // Firestore-native returns the fields flat. Unwrap once with a
    // fallback so this route works on both backends. Was reading
    // `data.enabled` at the outer level → always undefined on PB
    // → scheduler was silently disabled since the Firestore→PB migration.
    const rawSnap = snap.exists
      ? (snap.data() || {}) as Record<string, unknown>
      : {};
    const data: Record<string, unknown> = rawSnap.data && typeof rawSnap.data === "object"
      ? (rawSnap.data as Record<string, unknown>)
      : { ...(DEFAULT_SCHEDULE as Record<string, unknown>), ...rawSnap };
    const enabled = !!data.enabled;
    if (!enabled) {
      logRoute(reqId, "schedule disabled");
      return NextResponse.json({
        skipped: true,
        reason: "scheduler disabled",
        req_id: reqId,
      });
    }

    const publish = data.publish_default !== false;
    const dry_run = !publish;

    // Hour filter — the cron now runs hourly and passes the current UTC
    // hour via ?hour=<0-23>. Channels with a set run_at_hour only fire
    // when their hour matches; channels with run_at_hour==null preserve
    // the old behaviour (fire only at the "default hour", currently 9
    // UTC to match the legacy daily-at-09:00 schedule). "force=1"
    // bypasses the filter (used by the Run Now button per-channel path).
    const url = new URL(req.url);
    const hourParam = url.searchParams.get("hour");
    const forceAll  = url.searchParams.get("force") === "1";
    const nowHour = (hourParam !== null && hourParam !== "")
      ? Math.max(0, Math.min(23, Number(hourParam) || 0))
      : new Date().getUTCHours();
    const DEFAULT_HOUR = 9;

    // PRIMARY source of targets: the channels collection (per-channel
    // niche + daily_count + enabled). Each enabled channel with
    // daily_count > 0 contributes count jobs for its niche today.
    //
    // FALLBACK: the legacy schedules/default.daily_targets map (keyed
    // by niche) — preserved for users who haven't migrated to the new
    // channels page yet.
    const targets: Record<string, number> = {};
    const channelMeta: Array<{
      niche: string;
      channel_name: string;
      web_research: boolean | null;
      real_events: boolean | null;
      language: string | null;
      voice: string | null;
      tone: string | null;
      privacy: "public" | "unlisted" | "private" | null;
      youtube_account_id: string | null;
      unbound: boolean;
    }> = [];
    // Build a niche→binding lookup so the legacy fallback path (below)
    // can inherit a YouTube account from the channels row of the same
    // niche instead of silently publishing to the "legacy default"
    // account. This closes a gap where scheduled runs from the legacy
    // daily_targets map always shipped null bindings.
    const bindingByNiche: Record<string, string> = {};
    try {
      const channelsSnap = await adminDb().collection("channels").get();
      channelsSnap.forEach((doc) => {
        const c = doc.data() as Record<string, unknown>;
        if (!c.enabled) return;
        const niche = String(c.niche || "").trim();
        const yt = (typeof c.youtube_account_id === "string" && c.youtube_account_id) ? String(c.youtube_account_id) : null;
        // Populate lookup table even for count==0 rows — an operator
        // may have a channel row bound to an account but be temporarily
        // running via daily_targets during migration.
        if (niche && yt && !bindingByNiche[niche]) bindingByNiche[niche] = yt;
        const count = Math.max(0, Math.min(10, Number(c.daily_count) || 0));
        if (!niche || count === 0) return;
        // Hour filter: skip channels whose configured hour doesn't
        // match the current UTC hour. null → fires at DEFAULT_HOUR.
        // "force=1" bypasses (used by the per-channel Run Now button).
        const channelHour = (typeof c.run_at_hour === "number" &&
                             c.run_at_hour >= 0 && c.run_at_hour <= 23)
          ? Math.floor(c.run_at_hour as number)
          : DEFAULT_HOUR;
        if (!forceAll && channelHour !== nowHour) return;
        for (let i = 0; i < count; i++) {
          channelMeta.push({
            niche,
            channel_name: String(c.name || doc.id),
            web_research:
              c.web_research === true ? true :
              c.web_research === false ? false : null,
            real_events:
              c.real_events === true ? true :
              c.real_events === false ? false : null,
            language: (typeof c.language === "string" && c.language) ? String(c.language) : null,
            voice:    (typeof c.voice === "string" && c.voice) ? String(c.voice) : null,
            tone:     (typeof c.tone === "string" && c.tone) ? String(c.tone) : null,
            privacy:  (c.privacy === "public" || c.privacy === "unlisted" || c.privacy === "private") ? c.privacy : null,
            youtube_account_id: yt,
            unbound: !yt,
          });
        }
        targets[niche] = (targets[niche] || 0) + count;
      });
    } catch (e) {
      logRoute(reqId, "channels collection read failed (legacy path)", { err: String(e) });
    }
    // Legacy fallback when no channels are configured yet. Only fires
    // on the DEFAULT_HOUR tick so hourly cron doesn't queue 24×/day.
    if (channelMeta.length === 0 && (forceAll || nowHour === DEFAULT_HOUR)) {
      const legacy = (data.daily_targets || {}) as Record<string, number>;
      for (const [niche, count] of Object.entries(legacy)) {
        const n = Math.max(0, Math.min(10, Number(count) || 0));
        // Inherit binding from the channels collection if a matching
        // niche row exists — closes the gap where legacy daily_targets
        // always published null bindings. If no binding found, mark
        // the slot `unbound` so publish shows a warning chip and
        // side_jobs' safety net can still resolve at publish time.
        const inherited = bindingByNiche[niche] || null;
        for (let i = 0; i < n; i++) {
          channelMeta.push({
            niche, channel_name: niche,
            web_research: null, real_events: null, language: null, voice: null,
            tone: null, privacy: null,
            youtube_account_id: inherited,
            unbound: !inherited,
          });
        }
        if (n > 0) targets[niche] = (targets[niche] || 0) + n;
      }
    }

    const workers = await pickWorkers();
    const targetWorker = workers[0];

    // Auto-wake Kaggle if we have work to queue but NO gpu-tier worker
    // is currently alive. Prevents scheduled jobs from sitting in the
    // queue overnight when the last worker's watchdog expired. Only
    // fires when channelMeta has slots — so an empty schedule tick
    // (e.g. no channel matches this hour) never spins up a worker.
    if (channelMeta.length > 0) {
      try {
        const backendsSnap = await adminDb().collection("backends").get();
        const nowEpoch = Date.now() / 1000;
        let liveGpu = 0;
        backendsSnap.forEach((doc) => {
          const b = doc.data() as Record<string, unknown>;
          if (String(b.tier || "") !== "gpu") return;
          const lastSeen = Number(b.last_seen_at || 0);
          // 90s heartbeat window matches the /queue liveness threshold.
          if (nowEpoch - lastSeen < 90) liveGpu += 1;
        });
        if (liveGpu === 0) {
          const base = (process.env.COOLIFY_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
          const wakeUrl = base
            ? `${base}/api/backends/wake-kaggle`
            : new URL("/api/backends/wake-kaggle", req.url).toString();
          logRoute(reqId, "no gpu worker alive; waking kaggle", { wakeUrl });
          // Fire-and-forget — wake takes ~30-90s and shouldn't block the
          // schedule dispatch. Workers claim the queued jobs when they
          // come up.
          fetch(wakeUrl, {
            method: "POST",
            headers: { "X-Request-Id": reqId },
          }).catch(() => {});
        }
      } catch (e) {
        logRoute(reqId, "auto-wake-kaggle probe failed", { err: String(e) });
      }
    }

    const queued: { job_id: string; channel: string; backend_url: string | null }[] = [];
    const skipped: { channel: string; reason: string }[] = [];
    // Iterate channelMeta — each entry is ONE job slot (channel with
    // daily_count=2 → 2 slots in this array). Each gets its own job
    // id + Firestore doc + dispatch attempt.
    for (const slot of channelMeta) {
      const cleanChannel = String(slot.niche || "").trim();
      if (!cleanChannel || cleanChannel.length > 60) {
        skipped.push({ channel: slot.niche, reason: "invalid niche name (empty / too long)" });
        continue;
      }
      const jobId = _shortId();
      // Status: "queued" with no backend until a worker actually
      // accepts the dispatch. The optimistic "running" in the old
      // code was misleading — workers may not actually be reachable.
      const job = {
        id: jobId,
        status: "queued" as const,
        channel: cleanChannel,
        dry_run,
        queued_at: Date.now() / 1000,
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
        created_by: "scheduled-render",
        req_id: reqId,
        // Per-channel web_research override (from channels collection).
        // null = use the niche's default from modules/channels.py.
        web_research: slot.web_research,
        real_events:  slot.real_events,
        language:     slot.language,
        voice_override: slot.voice,
        tone_override: slot.tone,
        privacy_override: slot.privacy,
        youtube_account_id: slot.youtube_account_id,
        // When true, this scheduled slot didn't find a bound YouTube
        // account — publish will either fall back to legacy default OR
        // side_jobs' safety net will resolve from a matching channels
        // row at publish time. The Queue UI shows a warning chip so the
        // user knows to bind an account.
        unbound: slot.unbound,
        // Track which dashboard-channel this job belongs to so the
        // /queue page can group jobs by channel later.
        source_channel_name: slot.channel_name,
        updated_at: FieldValue.serverTimestamp(),
      };
      await adminDb().collection("jobs").doc(jobId).set(job);

      // Best-effort dispatch — workers will also pull from the queue
      // via their claim loop.
      if (targetWorker) {
        fetch(`${targetWorker.url.replace(/\/$/, "")}/api/jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": reqId,
            "X-Vercel-Gateway": "scheduled",
          },
          body: JSON.stringify({
            channel: cleanChannel,
            dry_run,
            web_research: slot.web_research,
            real_events: slot.real_events,
            language: slot.language,
            voice_override: slot.voice,
            youtube_account_id: slot.youtube_account_id,
          }),
        }).catch(() => {});
      }
      queued.push({ job_id: jobId, channel: cleanChannel, backend_url: targetWorker?.url || null });
    }

    logRoute(reqId, "scheduled-render queued", { count: queued.length, skipped: skipped.length });
    return NextResponse.json({
      ok: true,
      queued,
      skipped,
      worker_available: !!targetWorker,
      req_id: reqId,
    });
  } catch (e) {
    logRoute(reqId, "scheduled-render failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function _shortId(): string {
  const a = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 12; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}

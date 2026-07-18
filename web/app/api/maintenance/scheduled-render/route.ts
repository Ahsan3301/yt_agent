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
      description: string;
      web_research: boolean | null;
      real_events: boolean | null;
      language: string | null;
      voice: string | null;
      tone: string | null;
      privacy: "public" | "unlisted" | "private" | null;
      youtube_account_id: string | null;
      unbound: boolean;
      allowed_workers: string[];
      oracle_password_hash: string | null;
      cf_source: string;
      cf_own_account_id: string;
      cf_own_api_token: string;
      cf_pool: string;
      agnes_source: string;
      agnes_own_api_key: string;
      llm_priority: string;
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
        // match the current hour in the channel's timezone.
        //
        // 2026-07-13 audit #6: `run_at_hour` was silently UTC-only,
        // so a user in America/Toronto picking "9" got renders at
        // 04:00 or 05:00 local time (and DST didn't work). Now the
        // channel can carry an IANA timezone in `c.timezone` (e.g.
        // "America/Toronto"); we compute the current hour in that
        // TZ and compare. If unset, we fall back to UTC (existing
        // behaviour — no silent breakage for channels without TZ).
        const channelHour = (typeof c.run_at_hour === "number" &&
                             c.run_at_hour >= 0 && c.run_at_hour <= 23)
          ? Math.floor(c.run_at_hour as number)
          : DEFAULT_HOUR;
        const channelTz = (typeof c.timezone === "string" && c.timezone.trim())
          ? String(c.timezone).trim()
          : "";
        let currentHourInTz: number = nowHour;
        if (channelTz) {
          try {
            // Intl.DateTimeFormat handles IANA TZ + DST natively.
            const nowInTz = new Intl.DateTimeFormat("en-US", {
              timeZone: channelTz, hour: "numeric", hour12: false,
            }).formatToParts(new Date())
              .find((p) => p.type === "hour")?.value ?? String(nowHour);
            const parsed = Number(nowInTz);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 23) {
              currentHourInTz = parsed % 24;
            }
          } catch {
            // Invalid TZ (typo) — fall back to UTC and log so the operator
            // sees it in the route log.
            logRoute(reqId, "invalid channel timezone; falling back to UTC", {
              channel: c.name, timezone: channelTz,
            });
          }
        }
        if (!forceAll && channelHour !== currentHourInTz) return;
        const allowedWorkers = Array.isArray(c.allowed_workers)
          ? (c.allowed_workers as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const oraclePwHash = (typeof c.oracle_password_hash === "string" && c.oracle_password_hash)
          ? String(c.oracle_password_hash)
          : null;
        // Cloudflare (per-channel image gen). Carry the source AND, for
        // own-mode, the account_id+token so the worker can override the
        // global env before running the pipeline.
        const cfSource = String(c.cloudflare_source || "off");
        const cfOwnAcc = cfSource === "own"
          ? String(c.cloudflare_account_id || "").trim() : "";
        const cfOwnTok = cfSource === "own"
          ? String(c.cloudflare_api_token || "").trim() : "";
        // Per-channel Cloudflare account POOL for multi-account rotation.
        const cfPool = cfSource === "own"
          ? String(c.cloudflare_pool || "").trim() : "";
        // Per-channel Agnes AI image key.
        const agnesSource = String(c.agnes_source || "off");
        const agnesKey = agnesSource === "own"
          ? String(c.agnes_api_key || "").trim() : "";
        for (let i = 0; i < count; i++) {
          channelMeta.push({
            niche,
            channel_name: String(c.name || doc.id),
            description: (typeof c.description === "string" ? c.description : "").slice(0, 500),
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
            allowed_workers: allowedWorkers,
            oracle_password_hash: oraclePwHash,
            cf_source: cfSource,
            cf_own_account_id: cfOwnAcc,
            cf_own_api_token: cfOwnTok,
            cf_pool: cfPool,
            agnes_source: agnesSource,
            agnes_own_api_key: agnesKey,
            llm_priority: (typeof c.llm_priority === "string" && c.llm_priority.trim())
              ? String(c.llm_priority).trim().slice(0, 60) : "",
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
            niche, channel_name: niche, description: "",
            web_research: null, real_events: null, language: null, voice: null,
            tone: null, privacy: null,
            youtube_account_id: inherited,
            unbound: !inherited,
            allowed_workers: [],
            oracle_password_hash: null,
            cf_source: "off",
            cf_own_account_id: "",
            cf_own_api_token: "",
            cf_pool: "",
            agnes_source: "off",
            agnes_own_api_key: "",
            llm_priority: "",
          });
        }
        if (n > 0) targets[niche] = (targets[niche] || 0) + n;
      }
    }

    const workers = await pickWorkers();
    const targetWorker = workers[0];

    // Smart wake — only fires Kaggle wake if:
    //   (a) at least one queued channel has Kaggle as its PRIMARY, OR
    //   (b) at least one queued channel has Colab as primary but Colab
    //       AND Kaggle are both down (kaggle-as-fallback for colab).
    // Legacy channels with allowed_workers=[] fall into (a) by
    // default (kaggle is the historical primary).
    if (channelMeta.length > 0) {
      try {
        const backendsSnap = await adminDb().collection("backends").get();
        const nowEpoch = Date.now() / 1000;
        const liveLabels = new Set<string>();
        backendsSnap.forEach((doc) => {
          const b = doc.data() as Record<string, unknown>;
          const lastSeen = Number(b.last_seen_at || 0);
          if (nowEpoch - lastSeen >= 90) return;
          const label = String(b.instance_label || "").toLowerCase();
          if (label.includes("kaggle")) liveLabels.add("kaggle");
          else if (label.includes("colab")) liveLabels.add("colab");
          else if (label.includes("oracle") || String(b.tier || "") === "dashboard") liveLabels.add("oracle");
        });

        let wakeNeeded = false;
        for (const slot of channelMeta) {
          const allowed = slot.allowed_workers || [];
          const primary = allowed[0] || "kaggle";
          // Legacy channels (allowed=[]) inherit Kaggle-as-default,
          // matching pre-priority behaviour.
          const kaggleAllowed = allowed.length === 0 || allowed.includes("kaggle");
          if (primary === "kaggle" && !liveLabels.has("kaggle")) {
            wakeNeeded = true; break;
          }
          if (primary === "colab" && kaggleAllowed &&
              !liveLabels.has("colab") && !liveLabels.has("kaggle")) {
            wakeNeeded = true; break;
          }
          // Oracle primary → always up, no wake.
          // Colab primary WITHOUT kaggle in allowed → operator opted
          // out of Kaggle; wait for grace instead of waking.
        }

        if (wakeNeeded) {
          const base = (process.env.COOLIFY_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
          const wakeUrl = base
            ? `${base}/api/backends/wake-kaggle`
            : new URL("/api/backends/wake-kaggle", req.url).toString();
          logRoute(reqId, "waking kaggle (per-channel primary)", {
            wakeUrl, live: Array.from(liveLabels),
          });
          fetch(wakeUrl, {
            method: "POST",
            headers: {
              "X-Request-Id": reqId,
              "X-API-Key": process.env.RENDER_TRIGGER_KEY || "",
            },
          }).catch(() => {});
        } else {
          logRoute(reqId, "scheduled-render: no wake needed", {
            live: Array.from(liveLabels),
          });
        }
      } catch (e) {
        logRoute(reqId, "smart-wake probe failed", { err: String(e) });
      }
    }

    const queued: { job_id: string; channel: string; backend_url: string | null }[] = [];
    const skipped: { channel: string; reason: string }[] = [];
    // Iterate channelMeta — each entry is ONE job slot (channel with
    // daily_count=2 → 2 slots in this array). Each gets its own job
    // id + Firestore doc + dispatch attempt.
    let slotIdx = -1;
    for (const slot of channelMeta) {
      slotIdx += 1;
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
        // Space by ms per slot so orderBy(queued_at) tie-breaks are
        // deterministic in the claim loop (matches render-now).
        queued_at: Date.now() / 1000 + slotIdx * 0.001,
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
        // Per-channel description → channels.resolve() uses it to
        // synthesize a custom-niche preset that reflects the operator's
        // intent instead of a generic NIM-guessed one.
        manual_channel_desc: slot.description || "",
        // Per-channel worker priority list + Oracle unlock hash.
        // Consumed by the /api/jobs/claim gate — see route.ts.
        allowed_workers: slot.allowed_workers,
        oracle_password_hash: slot.oracle_password_hash,
        // Per-channel Cloudflare source + own creds if any. Worker
        // overrides os.environ CLOUDFLARE_* before entering the pipeline
        // so shotfinder's _cloudflare_generate sees the right creds.
        cf_source: slot.cf_source,
        cf_own_account_id: slot.cf_own_account_id,
        cf_own_api_token: slot.cf_own_api_token,
        cf_pool: slot.cf_pool,
        agnes_source: slot.agnes_source,
        agnes_own_api_key: slot.agnes_own_api_key,
        llm_priority: slot.llm_priority,
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

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant, tenantWhereClauses } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/reports?days=30&channel=<niche>&status=<status>
 *
 * One-shot aggregate for the /reports dashboard:
 *   - jobs_daily: [{ day: "YYYY-MM-DD", complete, failed, cancelled }]
 *   - top_channels: [{ channel, count, published, failed }]
 *   - videos: [{ id, run_id, channel, video_url, youtube_url, ok, finished_at }]
 *   - errors_recent: [{ ts, kind, message, run_id }]
 *   - cleanup_runs: [{ ts, days, jobs_deleted, ... }]
 *   - totals: { jobs, complete, failed, videos, errors_last_24h }
 */

function _epoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null) {
    const o = v as { _seconds?: number; seconds?: number; toMillis?: () => number };
    if (typeof o.toMillis === "function") return o.toMillis() / 1000;
    if (typeof o._seconds === "number") return o._seconds;
    if (typeof o.seconds === "number") return o.seconds;
  }
  return null;
}

function _dayKey(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const url = req.nextUrl;
  const days = Math.max(1, Math.min(180, Number(url.searchParams.get("days") ?? 30)));
  const channelFilter = url.searchParams.get("channel") || "";
  const statusFilter = url.searchParams.get("status") || "";

  const now = Date.now() / 1000;
  const cutoff = now - days * 86400;

  const jobsByDay: Record<string, { complete: number; failed: number; cancelled: number; total: number }> = {};
  const byChannel: Record<string, { count: number; published: number; failed: number }> = {};
  let totalJobs = 0, totalComplete = 0, totalFailed = 0;

  // Seed empty days so the chart shows a continuous baseline.
  for (let i = 0; i < days; i++) {
    const d = new Date((now - i * 86400) * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    jobsByDay[key] = { complete: 0, failed: 0, cancelled: 0, total: 0 };
  }

  // ── Jobs ────────────────────────────────────────────────
  try {
    let q = adminDb().collection("jobs").limit(2000);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
    const snap = await q.get();
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const ts = _epoch(d.finished_at) ?? _epoch(d.queued_at);
      if (ts == null || ts < cutoff) return;
      const ch = String(d.channel || "");
      if (channelFilter && ch !== channelFilter) return;
      const st = String(d.status || "");
      if (statusFilter && st !== statusFilter) return;
      totalJobs += 1;
      if (st === "complete") totalComplete += 1;
      if (st === "failed") totalFailed += 1;

      const day = _dayKey(ts);
      if (!jobsByDay[day]) jobsByDay[day] = { complete: 0, failed: 0, cancelled: 0, total: 0 };
      jobsByDay[day].total += 1;
      if (st === "complete") jobsByDay[day].complete += 1;
      else if (st === "failed") jobsByDay[day].failed += 1;
      else if (st === "cancelled") jobsByDay[day].cancelled += 1;

      if (!byChannel[ch]) byChannel[ch] = { count: 0, published: 0, failed: 0 };
      byChannel[ch].count += 1;
      if (st === "complete") byChannel[ch].published += 1;
      if (st === "failed") byChannel[ch].failed += 1;
    });
  } catch { /* soft-fail per section */ }

  // ── Published videos (runs_index has richer metadata) ───
  const videos: Array<Record<string, unknown>> = [];
  try {
    let q = adminDb().collection("runs_index")
      .orderBy("finished_at", "desc").limit(200);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
    const snap = await q.get();
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const fin = _epoch(d.finished_at);
      if (fin == null || fin < cutoff) return;
      const ch = String(d.channel || "");
      if (channelFilter && ch !== channelFilter) return;
      if (!d.has_video) return;
      videos.push({
        id: doc.id,
        run_id: doc.id,
        channel: ch,
        video_url: d.video_url || null,
        youtube_url: d.youtube_url || null,
        title: d.title || d.youtube_title || "",
        ok: d.ok !== false,
        finished_at: fin,
        video_storage: d.video_storage || "unknown",
      });
    });
  } catch { /* soft-fail */ }

  // ── Errors ──────────────────────────────────────────────
  const errorsRecent: Array<Record<string, unknown>> = [];
  let errorsLast24h = 0;
  try {
    let q = adminDb().collection("errors")
      .orderBy("ts", "desc").limit(50);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
    const snap = await q.get();
    const yesterday = now - 86400;
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const ts = _epoch(d.ts) ?? 0;
      if (ts < cutoff) return;
      if (ts >= yesterday) errorsLast24h += 1;
      errorsRecent.push({
        id: doc.id,
        ts,
        kind: d.kind || d.class || "",
        message: (d.message || d.title || "").toString().slice(0, 240),
        run_id: d.run_id || "",
        worker: d.worker_label || "",
      });
    });
  } catch { /* soft-fail */ }

  // ── Cleanup history ─────────────────────────────────────
  const cleanups: Array<Record<string, unknown>> = [];
  try {
    const snap = await adminDb().collection("cleanup_runs")
      .orderBy("ts", "desc").limit(50).get();
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      cleanups.push({
        id: doc.id,
        ts: _epoch(d.ts) ?? 0,
        triggered_by: d.triggered_by || "operator",
        days: Number(d.days ?? 0),
        jobs_deleted: Number(d.jobs_deleted ?? 0),
        runs_deleted: Number(d.runs_deleted ?? 0),
        videos_requested: Number(d.videos_requested ?? 0),
        errors_deleted: Number(d.errors_deleted ?? 0),
        orphan_queued_failed: Number(d.orphan_queued_failed ?? 0),
        idempotency_deleted: Number(d.idempotency_deleted ?? 0),
        freed_estimate_mb: Number(d.freed_estimate_mb ?? 0),
        detail: Array.isArray(d.detail) ? d.detail : [],
        errors: Array.isArray(d.errors) ? d.errors : [],
        pre_snapshot: typeof d.pre_snapshot === "object" ? d.pre_snapshot : null,
      });
    });
  } catch { /* soft-fail */ }

  // Sorted arrays for the client.
  const dailySorted = Object.entries(jobsByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }));

  const channelSorted = Object.entries(byChannel)
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([channel, v]) => ({ channel, ...v }));

  return NextResponse.json({
    days,
    filters: { channel: channelFilter, status: statusFilter },
    totals: {
      jobs: totalJobs,
      complete: totalComplete,
      failed: totalFailed,
      videos: videos.length,
      errors_last_24h: errorsLast24h,
    },
    jobs_daily: dailySorted,
    top_channels: channelSorted.slice(0, 20),
    videos: videos.slice(0, 100),
    errors_recent: errorsRecent.slice(0, 40),
    cleanup_runs: cleanups,
  });
}

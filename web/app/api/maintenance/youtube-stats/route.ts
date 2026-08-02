import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { fetchVideoStats, isProblem } from "@/lib/youtube-stats";
import { withHeartbeat } from "@/lib/maintenance-heartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/youtube-stats
 *
 * Refreshes views/likes/comments and publish status for every run that
 * has a YouTube id.
 *
 * The platform published videos and then forgot about them. Nothing in
 * the product could answer "is any of this working?" — one upload on
 * 2026-08-02 had 600 views and 17 likes while its siblings had none,
 * and that was only discoverable by hand-querying the API.
 *
 * It also closes a silent-failure class. YouTube can flip a video to
 * private, block it, or remove it, and emits no event for any of that;
 * such a run would read "published" forever. A video the API declines
 * to return is recorded as deleted rather than left looking fine.
 *
 * Quota: videos.list is 1 unit per 50 ids, so a full sweep of the
 * catalogue is a couple of units against 10,000/day. Cheap enough to
 * run every few hours.
 *
 * Query params:
 *   ?limit=500   max rows to refresh (default 500, newest first)
 */
async function _handler(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") || 500)));

  try {
    const snap = await adminDb().collection("runs_index").limit(2000).get();
    const rows: Array<{ docId: string; videoId: string; title: string; wasProblem: boolean }> = [];
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      const vid = String(r.youtube_video_id || "").trim();
      if (!vid) return;
      rows.push({
        docId: d.id,
        videoId: vid,
        title: String(r.title || ""),
        wasProblem: String(r.yt_upload_status || "") === "deleted",
      });
    });

    if (rows.length === 0) {
      logRoute(reqId, "youtube-stats: no published runs");
      return NextResponse.json({ ok: true, checked: 0, updated: 0, problems: [] });
    }

    const target = rows.slice(0, limit);
    const stats = await fetchVideoStats(target.map((r) => r.videoId));
    if (stats.length === 0) {
      // No key, or the API refused. Say so instead of reporting a
      // successful sweep that touched nothing.
      logRoute(reqId, "youtube-stats: no data returned (missing key or quota)");
      return NextResponse.json({
        ok: false,
        checked: 0,
        error: "No stats returned — YOUTUBE_API_KEY missing, or daily quota exhausted.",
      });
    }

    const byId = new Map(stats.map((s) => [s.videoId, s]));
    const now = Math.floor(Date.now() / 1000);
    let updated = 0;
    let totalViews = 0;
    const problems: Array<{ video_id: string; title: string; reason: string }> = [];

    for (const row of target) {
      const s = byId.get(row.videoId);
      if (!s) continue;
      totalViews += s.views;
      try {
        await adminDb().collection("runs_index").doc(row.docId).update({
          view_count: s.views,
          like_count: s.likes,
          comment_count: s.comments,
          yt_privacy_status: s.privacyStatus,
          yt_upload_status: s.uploadStatus,
          stats_checked_at: now,
        });
        updated += 1;
      } catch { /* best-effort per row */ }

      // Alert only on a NEW problem. A video that has been down for a
      // week should not re-announce itself every sweep.
      if (isProblem(s) && !row.wasProblem) {
        problems.push({
          video_id: row.videoId,
          title: row.title.slice(0, 80),
          reason: s.gone
            ? "no longer returned by YouTube (deleted or made private)"
            : `status ${s.uploadStatus || "?"}/${s.privacyStatus || "?"}`,
        });
      }
    }

    if (problems.length > 0) {
      try {
        const hook = process.env.DISCORD_WEBHOOK_URL || "";
        if (hook) {
          const lines = problems.slice(0, 10)
            .map((p) => `• ${p.title || p.video_id} — ${p.reason}`).join("\n");
          await fetch(hook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ ${problems.length} published video(s) are no longer live on YouTube:\n${lines}`,
            }),
          });
        }
      } catch { /* alerting is best-effort */ }
    }

    logRoute(reqId, "youtube-stats sweep", {
      checked: target.length, updated, problems: problems.length, total_views: totalViews,
    });
    return NextResponse.json({
      ok: true,
      checked: target.length,
      updated,
      total_views: totalViews,
      problems,
      // ~1 unit per 50 ids.
      quota_units_used: Math.ceil(target.length / 50),
    });
  } catch (e) {
    logRoute(reqId, "youtube-stats failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export const POST = withHeartbeat("youtube-stats", _handler);

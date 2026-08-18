import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireOperator, tenantWhereClauses } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/analytics/performance
 *
 * What is actually working, per niche, from real YouTube view counts.
 *
 * The platform could publish indefinitely without anyone being able to
 * answer "which of this is worth making more of". On 2026-08-02 the
 * history niche averaged 427 views while horror averaged 1 — a ~400x
 * difference that decides where the render budget should go, and it was
 * invisible until the stats sweep started recording it.
 *
 * Videos younger than SETTLE_HOURS are counted separately rather than
 * averaged in. A batch published an hour ago has no views yet, and
 * letting those into the mean makes every active niche look like it is
 * collapsing.
 */

const SETTLE_HOURS = 48;

export async function GET(req: NextRequest) {
  // Operator-only, for the same reason as /api/reports: this is the
  // other half of the /app/reports page, and a hidden page whose API
  // still answers is not hidden.
  const auth = await requireOperator(req);
  if ("response" in auth) return auth.response;

  try {
    let q = adminDb().collection("runs_index").limit(2000);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) {
      q = q.where(f, op as "==", v);
    }
    const snap = await q.get();

    const nowSec = Math.floor(Date.now() / 1000);
    const settleCutoff = nowSec - SETTLE_HOURS * 3600;

    type Row = { niche: string; title: string; views: number; likes: number;
                 videoId: string; at: number; settled: boolean; status: string };
    const rows: Row[] = [];
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      const vid = String(r.youtube_video_id || "");
      if (!vid) return;
      const at = Number(r.published_at || r.finished_at || 0);
      rows.push({
        niche:  String(r.channel || "unknown"),
        title:  String(r.title || ""),
        views:  Number(r.view_count ?? -1),
        likes:  Number(r.like_count ?? 0),
        videoId: vid,
        at,
        settled: at > 0 && at < settleCutoff,
        status: String(r.yt_upload_status || ""),
      });
    });

    const measured = rows.filter((r) => r.views >= 0);
    const settled  = measured.filter((r) => r.settled);

    // Per-niche aggregates, settled videos only.
    const byNiche = new Map<string, { videos: number; views: number; likes: number; best: Row | null }>();
    for (const r of settled) {
      const cur = byNiche.get(r.niche) || { videos: 0, views: 0, likes: 0, best: null as Row | null };
      cur.videos += 1;
      cur.views  += r.views;
      cur.likes  += r.likes;
      if (!cur.best || r.views > cur.best.views) cur.best = r;
      byNiche.set(r.niche, cur);
    }

    const niches = [...byNiche.entries()]
      .map(([niche, v]) => ({
        niche,
        videos: v.videos,
        total_views: v.views,
        total_likes: v.likes,
        avg_views: Math.round(v.views / Math.max(1, v.videos)),
        best_title: v.best?.title || "",
        best_views: v.best?.views || 0,
      }))
      .sort((a, b) => b.avg_views - a.avg_views);

    const ranked = [...settled].sort((a, b) => b.views - a.views);

    return NextResponse.json({
      settle_hours: SETTLE_HOURS,
      totals: {
        published: rows.length,
        measured: measured.length,
        settled: settled.length,
        // Not yet judgeable — shown so "only 3 videos counted" doesn't
        // look like data loss.
        too_fresh: measured.length - settled.length,
        awaiting_first_check: rows.length - measured.length,
        total_views: measured.reduce((n, r) => n + Math.max(0, r.views), 0),
      },
      niches,
      top: ranked.slice(0, 10).map((r) => ({
        title: r.title, views: r.views, likes: r.likes,
        niche: r.niche, video_id: r.videoId,
      })),
      // The bottom matters as much as the top — it is where the
      // pattern to stop repeating lives.
      bottom: ranked.slice(-5).reverse().map((r) => ({
        title: r.title, views: r.views, likes: r.likes,
        niche: r.niche, video_id: r.videoId,
      })),
      problems: rows.filter((r) => r.status === "deleted").map((r) => ({
        title: r.title, video_id: r.videoId, niche: r.niche,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { getConfig } from "@/lib/platform-config";
import { youtubeApiKey } from "@/lib/youtube-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/public-stats
 *
 * Computes the numbers the marketing site shows, from the YouTube API,
 * and caches them in platform_config/public_stats.
 *
 * WHY A CACHE AND NOT A LIVE FETCH
 * The landing page is public and uncached fetches would spend YouTube
 * quota on every visitor — the same quota research needs. This runs on
 * the maintenance cron; the page reads one document.
 *
 * WHY THIS EXISTS AT ALL
 * The site summed runs_index.view_count, which counts only videos this
 * agent published — 18,237 across 138 videos when measured. The
 * connected channels together hold far more, because several existed
 * before the agent and have their own back catalogue. Those are two
 * genuinely different claims and the site was making the smaller one
 * while the operator believed it was making the larger.
 *
 * Both are computed and stored, separately, so a page can say exactly
 * which one it means:
 *
 *   managed_views    every video on every connected channel. TRUE as
 *                    "views across channels managed on Yven". NOT true
 *                    as "views our AI earned" — one pre-existing
 *                    entertainment channel carries 1.08M of it.
 *   published_views  views on videos this agent actually made. The
 *                    honest product claim, and the smaller number.
 *
 * PUBLIC_STATS_CHANNELS (platform config) narrows the channel set to a
 * comma-separated list of channel ids. Set it to exclude channels the
 * agent did not build, and managed_views becomes a claim worth making.
 * Empty means every connected channel.
 *
 * The monthly series is built from each video's real publishedAt and
 * its CURRENT view count, so point N is "views now held by videos
 * published on or before month N". That is a real cumulative curve of a
 * real catalogue. It is NOT a historical record of what the counter
 * read at the time — nothing recorded that, and this does not pretend
 * to. `series_basis` says so in the stored document.
 */

type Chan = { id: string; title: string; views: number; videos: number; subs: number };

async function _yt(path: string, params: Record<string, string>, key: string) {
  const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("key", key);
  const r = await fetch(u.toString(), { cache: "no-store" });
  if (!r.ok) throw new Error(`youtube ${path} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

async function _handler(req: NextRequest) {
  // Canonical resolver, not a private lookup. The key lives in
  // settings/platform_pool__api_keys, NOT platform_config — reading it
  // the "obvious" way returned empty and this route reported the key as
  // unconfigured while every other YouTube caller had it.
  const key = (await youtubeApiKey()).trim();
  if (!key) {
    return NextResponse.json({ error: "YOUTUBE_API_KEY not configured" }, { status: 400 });
  }

  // Connected channels.
  const snap = await adminDb().collection("youtube_accounts").limit(100).get();
  let ids: string[] = [];
  snap.forEach((d) => {
    const c = String((d.data() as Record<string, unknown>)?.youtube_channel_id || "").trim();
    if (c) ids.push(c);
  });

  const only = String(await getConfig("PUBLIC_STATS_CHANNELS", "")).trim();
  if (only) {
    const allow = new Set(only.split(",").map((s) => s.trim()).filter(Boolean));
    ids = ids.filter((c) => allow.has(c));
  }
  ids = Array.from(new Set(ids));
  if (!ids.length) return NextResponse.json({ error: "no channels" }, { status: 400 });

  // Channel totals + the uploads playlist for each.
  const chans: Chan[] = [];
  const uploads: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await _yt("channels", {
      part: "snippet,statistics,contentDetails",
      id: ids.slice(i, i + 50).join(","),
    }, key);
    for (const it of d.items || []) {
      const s = it.statistics || {};
      chans.push({
        id: it.id,
        title: String(it.snippet?.title || ""),
        views: Number(s.viewCount || 0),
        videos: Number(s.videoCount || 0),
        subs: Number(s.subscriberCount || 0),
      });
      const up = it.contentDetails?.relatedPlaylists?.uploads;
      if (up) uploads.push(up);
    }
  }

  // Every upload's publishedAt, then its view count in batches of 50.
  const byMonth = new Map<string, number>();
  let counted = 0;
  for (const pl of uploads) {
    let page = "";
    for (let guard = 0; guard < 20; guard++) {
      const p: Record<string, string> = { part: "contentDetails", playlistId: pl, maxResults: "50" };
      if (page) p.pageToken = page;
      const d = await _yt("playlistItems", p, key);
      const vids = (d.items || [])
        .map((i: { contentDetails?: { videoId?: string } }) => i.contentDetails?.videoId)
        .filter(Boolean) as string[];
      if (vids.length) {
        const v = await _yt("videos", { part: "snippet,statistics", id: vids.join(",") }, key);
        for (const it of v.items || []) {
          const at = String(it.snippet?.publishedAt || "");
          const views = Number(it.statistics?.viewCount || 0);
          if (!at) continue;
          const m = at.slice(0, 7); // YYYY-MM
          byMonth.set(m, (byMonth.get(m) || 0) + views);
          counted += 1;
        }
      }
      page = d.nextPageToken || "";
      if (!page) break;
    }
  }

  // Cumulative, oldest first.
  const months = Array.from(byMonth.keys()).sort();
  let run = 0;
  const series = months.map((m) => {
    run += byMonth.get(m) || 0;
    return { month: m, views: run };
  });

  // What this agent itself published — the narrower, product-specific claim.
  let publishedViews = 0, publishedCount = 0;
  const langs = new Set<string>();
  try {
    const runs = await adminDb().collection("runs_index").limit(2000).get();
    runs.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      if (!r.youtube_video_id) return;
      publishedCount += 1;
      publishedViews += Math.max(0, Number(r.view_count || 0));
      const l = String(r.language || "").trim();
      if (l) langs.add(l);
    });
  } catch { /* leave at zero — the managed figures still stand */ }

  const doc = {
    managed_views: chans.reduce((n, c) => n + c.views, 0),
    managed_videos: chans.reduce((n, c) => n + c.videos, 0),
    subscribers: chans.reduce((n, c) => n + c.subs, 0),
    channels: chans.length,
    published_views: publishedViews,
    published_videos: publishedCount,
    languages: langs.size,
    series,
    series_points: series.length,
    series_basis:
      "cumulative CURRENT views of videos by their real publishedAt month; " +
      "not a historical record of the counter at the time",
    channel_breakdown: chans
      .sort((a, b) => b.views - a.views)
      .map((c) => ({ title: c.title, views: c.views, videos: c.videos })),
    videos_counted: counted,
    updated_at: new Date().toISOString(),
  };

  await adminDb().collection("platform_config").doc("public_stats").set(doc);
  return NextResponse.json({ ok: true, ...doc, series: undefined, series_points: series.length });
}

export async function POST(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;
  const rid = newRequestId();
  try {
    const res = await _handler(req);
    logRoute("maintenance/public-stats", rid, { status: "ok" });
    return res;
  } catch (e) {
    logRoute("maintenance/public-stats", rid, { error: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

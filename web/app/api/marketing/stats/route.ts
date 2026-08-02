import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/marketing/stats — public, aggregate, REAL.
 *
 * The landing page previously showed "In private beta — 1,247 videos
 * published today" as a hardcoded string. It was never true and never
 * moved. This returns numbers that are actually measured, so the
 * public claim cannot drift from what the product has done.
 *
 * Aggregate only: totals across the platform, never per-tenant, so
 * there is nothing here that leaks one customer's activity to another.
 *
 * MIN_TO_SHOW is the important part. Below it, `show` is false and the
 * page renders no counter at all. Small real numbers are worse than
 * silence for a young product — and inflating them is what created
 * this problem in the first place. Honest and quiet beats impressive
 * and false.
 */

const MIN_VIDEOS_TO_SHOW = 100;
const MIN_VIEWS_TO_SHOW = 1000;

let _cache: { at: number; body: unknown } | null = null;
const TTL_MS = 300_000;   // 5 min — this is a marketing page, not a dashboard

export async function GET() {
  if (_cache && Date.now() - _cache.at < TTL_MS) {
    return NextResponse.json(_cache.body, { headers: { "X-Cache": "HIT" } });
  }
  try {
    let published = 0;
    let views = 0;
    let languages = 0;

    const snap = await adminDb().collection("runs_index").limit(2000).get();
    const langs = new Set<string>();
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      if (!r.youtube_video_id) return;
      published += 1;
      views += Math.max(0, Number(r.view_count || 0));
      const l = String(r.language || "").trim();
      if (l) langs.add(l);
    });
    languages = langs.size;

    const body = {
      published,
      views,
      languages,
      // The page shows the counter only when the numbers stand on their
      // own. Anything else is either noise or spin.
      show: published >= MIN_VIDEOS_TO_SHOW && views >= MIN_VIEWS_TO_SHOW,
    };
    _cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { "X-Cache": "MISS" } });
  } catch {
    // Never block the landing page on this, and never invent a number
    // to fill the gap.
    return NextResponse.json({ published: 0, views: 0, languages: 0, show: false });
  }
}

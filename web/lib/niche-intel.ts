import { adminDb } from "@/lib/firebase-admin";
import { youtubeApiKey } from "@/lib/youtube-stats";

/**
 * Niche intelligence: what is actually working on YouTube right now,
 * per niche, accumulated over time.
 *
 * Quota shape matters here. search.list costs 100 units and returns up
 * to 50 ids; videos.list then returns full stats + TAGS for all 50 for
 * 1 unit. So a complete read of a niche's current winners is ~101
 * units, and six niches is ~600/day against a 10,000 budget. The
 * expensive call is the search, so we do exactly one per niche per day
 * and squeeze everything out of the cheap follow-up.
 *
 * Everything here MERGES into stored counts rather than replacing them.
 * One day's 50 videos cannot tell you which hour a niche performs best
 * — a real sweep produced a top hour backed by a single video sitting
 * above an hour with five. Pooled counts across weeks can. Sample sizes
 * travel with every figure so callers can refuse thin evidence.
 */

export type NicheIntel = {
  niche: string;
  hourViews: Record<string, { n: number; views: number }>;
  tagCounts: Record<string, number>;
  titlePatterns: { n: number; withNumber: number; withQuestion: number; lenSum: number };
  sampleSize: number;
  sweeps: number;
  lastSweptAt: number;
};

const SEARCH_LOOKBACK_DAYS = 30;

/** Minimum videos observed in an hour bucket before it may be treated
 *  as signal. Below this it is one person's upload time, not a pattern. */
export const MIN_HOUR_SAMPLE = 8;
/** Minimum total videos before any recommendation is offered at all. */
export const MIN_TOTAL_SAMPLE = 60;

function _empty(niche: string): NicheIntel {
  return {
    niche, hourViews: {}, tagCounts: {},
    titlePatterns: { n: 0, withNumber: 0, withQuestion: 0, lenSum: 0 },
    sampleSize: 0, sweeps: 0, lastSweptAt: 0,
  };
}

export async function readIntel(niche: string): Promise<NicheIntel> {
  try {
    const snap = await adminDb().collection("niche_intel").doc(niche).get();
    if (!snap.exists) return _empty(niche);
    const d = (snap.data() || {}) as Record<string, unknown>;
    const j = (v: unknown, fb: unknown) => {
      if (typeof v === "string") { try { return JSON.parse(v); } catch { return fb; } }
      return v && typeof v === "object" ? v : fb;
    };
    return {
      niche,
      hourViews:     j(d.hour_views, {}) as NicheIntel["hourViews"],
      tagCounts:     j(d.tag_counts, {}) as Record<string, number>,
      titlePatterns: j(d.title_patterns, _empty(niche).titlePatterns) as NicheIntel["titlePatterns"],
      sampleSize:    Number(d.sample_size || 0),
      sweeps:        Number(d.sweeps || 0),
      lastSweptAt:   Number(d.last_swept_at || 0),
    };
  } catch {
    return _empty(niche);
  }
}

/**
 * One sweep of a niche, merged into whatever is already stored.
 * Returns the number of videos observed, or 0 if the API gave nothing
 * (missing key, exhausted quota) — the caller reports that rather than
 * recording a successful sweep that learned nothing.
 */
export async function sweepNiche(niche: string, query?: string): Promise<number> {
  const key = await youtubeApiKey();
  if (!key) return 0;

  const publishedAfter = new Date(Date.now() - SEARCH_LOOKBACK_DAYS * 86400_000).toISOString();
  const q = (query || `${niche} #shorts`).slice(0, 100);

  let ids: string[] = [];
  try {
    const sp = new URLSearchParams({
      part: "snippet", q, type: "video", order: "viewCount",
      maxResults: "50", videoDuration: "short",
      publishedAfter, relevanceLanguage: "en", key,
    });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${sp}`, { cache: "no-store" });
    if (!r.ok) return 0;
    const j = await r.json() as { items?: Array<{ id?: { videoId?: string } }> };
    ids = (j.items || []).map((i) => i.id?.videoId || "").filter(Boolean);
  } catch {
    return 0;
  }
  if (ids.length === 0) return 0;

  let items: Array<Record<string, unknown>> = [];
  try {
    const vp = new URLSearchParams({ part: "snippet,statistics", id: ids.join(","), key });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${vp}`, { cache: "no-store" });
    if (!r.ok) return 0;
    const j = await r.json() as { items?: Array<Record<string, unknown>> };
    items = j.items || [];
  } catch {
    return 0;
  }

  const cur = await readIntel(niche);
  let observed = 0;

  for (const it of items) {
    const sn = (it.snippet || {}) as Record<string, unknown>;
    const st = (it.statistics || {}) as Record<string, string>;
    const views = Number(st.viewCount || 0);
    const publishedAt = String(sn.publishedAt || "");
    if (!publishedAt) continue;
    observed += 1;

    const hour = String(new Date(publishedAt).getUTCHours());
    const slot = cur.hourViews[hour] || { n: 0, views: 0 };
    slot.n += 1;
    slot.views += views;
    cur.hourViews[hour] = slot;

    for (const t of ((sn.tags as string[]) || [])) {
      const k = String(t).toLowerCase().trim().slice(0, 60);
      if (k) cur.tagCounts[k] = (cur.tagCounts[k] || 0) + 1;
    }

    const title = String(sn.title || "");
    if (title) {
      cur.titlePatterns.n += 1;
      cur.titlePatterns.lenSum += title.length;
      if (/\d/.test(title)) cur.titlePatterns.withNumber += 1;
      if (/\?|^(what|why|how|who|when|where)\b/i.test(title)) cur.titlePatterns.withQuestion += 1;
    }
  }

  if (observed === 0) return 0;

  cur.sampleSize += observed;
  cur.sweeps += 1;
  cur.lastSweptAt = Math.floor(Date.now() / 1000);

  // Keep the tag bank bounded — a niche accumulates a long tail of
  // one-off tags that will never be useful and would grow the row
  // without limit.
  const trimmed = Object.entries(cur.tagCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 200);
  cur.tagCounts = Object.fromEntries(trimmed);

  try {
    await adminDb().collection("niche_intel").doc(niche).set({
      niche,
      hour_views:     JSON.stringify(cur.hourViews),
      tag_counts:     JSON.stringify(cur.tagCounts),
      title_patterns: JSON.stringify(cur.titlePatterns),
      sample_size:    cur.sampleSize,
      sweeps:         cur.sweeps,
      last_swept_at:  cur.lastSweptAt,
    }, { merge: true });
  } catch { /* the sweep still happened; reporting it is best-effort */ }

  return observed;
}

/**
 * Best publish hours for a niche, or null when the evidence is too
 * thin to say anything.
 *
 * Ranks by MEAN VIEWS PER VIDEO within the hour, but only for hours
 * that clear MIN_HOUR_SAMPLE. Without that floor the winner is
 * whichever hour happened to catch one viral video — observed live: a
 * single video put 09:00 above an hour with five videos and a far more
 * credible median.
 */
export function bestHours(intel: NicheIntel, top = 3): Array<{ hour: number; avgViews: number; n: number }> | null {
  if (intel.sampleSize < MIN_TOTAL_SAMPLE) return null;
  const rows = Object.entries(intel.hourViews)
    .map(([h, v]) => ({ hour: Number(h), avgViews: Math.round(v.views / Math.max(1, v.n)), n: v.n }))
    .filter((r) => r.n >= MIN_HOUR_SAMPLE);
  if (rows.length < 3) return null;      // need something to compare against
  rows.sort((a, b) => b.avgViews - a.avgViews);
  return rows.slice(0, top);
}

/** The niche's proven keyword bank, most-shared first. */
export function topTags(intel: NicheIntel, limit = 25): string[] {
  return Object.entries(intel.tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

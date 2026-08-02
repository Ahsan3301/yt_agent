import { adminDb } from "@/lib/firebase-admin";

/**
 * Pull real performance data for published videos from the YouTube
 * Data API and write it back onto their runs_index rows.
 *
 * Quota: videos.list is 1 unit for up to 50 ids, so the whole back
 * catalogue costs a couple of units per sweep against a 10,000/day
 * budget. That is why this can run every few hours rather than daily —
 * the expensive call in this system is search.list (100 units), which
 * only the SEO borrower uses.
 */

export type VideoStat = {
  videoId: string;
  views: number;
  likes: number;
  comments: number;
  privacyStatus: string;
  uploadStatus: string;
  /** True when the API did not return the id at all. */
  gone: boolean;
};

const API = "https://www.googleapis.com/youtube/v3/videos";

/** Read the pooled key. Mirrors seo_borrower's resolution order so both
 *  sides of the product use the same credential.
 *
 *  Exported because every consumer must resolve it the SAME way. The
 *  Roast tool read `process.env.YOUTUBE_API_KEY` directly, which is
 *  never set on the dashboard container — the key lives in the pool —
 *  so it silently served canned "preview tips" instead of analysing the
 *  channel, with no indication anything was missing. */
export async function youtubeApiKey(): Promise<string> {
  return _apiKey();
}

async function _apiKey(): Promise<string> {
  const fromEnv = (process.env.YOUTUBE_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const snap = await adminDb().collection("settings").doc("platform_pool__api_keys").get();
    const raw = (snap.data() as { data?: unknown } | undefined)?.data;
    const blob = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    return String((blob as Record<string, string>).YOUTUBE_API_KEY || "").trim();
  } catch {
    return "";
  }
}

/** Fetch stats for up to any number of ids, batching at the API's limit. */
export async function fetchVideoStats(videoIds: string[]): Promise<VideoStat[]> {
  const key = await _apiKey();
  if (!key || videoIds.length === 0) return [];

  const out: VideoStat[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const url = `${API}?part=statistics,status&id=${chunk.join(",")}&key=${encodeURIComponent(key)}`;
    let items: Array<Record<string, unknown>> = [];
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) {
        // 403 is quota exhausted OR a revoked key — either way, stop
        // rather than hammering, and leave existing stats untouched.
        break;
      }
      const j = await r.json() as { items?: Array<Record<string, unknown>> };
      items = j.items || [];
    } catch {
      break;
    }

    const seen = new Set<string>();
    for (const it of items) {
      const id = String(it.id || "");
      if (!id) continue;
      seen.add(id);
      const st = (it.statistics || {}) as Record<string, string>;
      const stat = (it.status || {}) as Record<string, string>;
      out.push({
        videoId: id,
        views:    Number(st.viewCount || 0),
        likes:    Number(st.likeCount || 0),
        comments: Number(st.commentCount || 0),
        privacyStatus: String(stat.privacyStatus || ""),
        uploadStatus:  String(stat.uploadStatus || ""),
        gone: false,
      });
    }
    // An id the API declines to return is deleted, or private in a way
    // that hides it from an API-key (non-OAuth) request. Either way the
    // video is no longer publicly watchable, which is the thing worth
    // knowing — a run that still claims "published" would be lying.
    for (const id of chunk) {
      if (!seen.has(id)) {
        out.push({
          videoId: id, views: 0, likes: 0, comments: 0,
          privacyStatus: "", uploadStatus: "deleted", gone: true,
        });
      }
    }
  }
  return out;
}

/** A video that is no longer publicly watchable, for alerting. */
export function isProblem(s: VideoStat): boolean {
  if (s.gone) return true;
  if (s.uploadStatus && !["processed", "uploaded"].includes(s.uploadStatus)) return true;
  // We only ever publish public or unlisted. Anything else means it was
  // changed after the fact.
  if (s.privacyStatus && s.privacyStatus === "private") return true;
  return false;
}

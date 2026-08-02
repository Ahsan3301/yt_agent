import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { youtubeApiKey } from "@/lib/youtube-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/tools/roast
 *
 * Public — pastes a YouTube channel URL and returns three actionable
 * tips. When YOUTUBE_API_KEY is set AND an LLM key is available in the
 * settings singleton, fetches real channel + recent-video data and
 * asks the LLM for tips. Otherwise returns preview tips + a note.
 *
 * Response shape:
 *   {
 *     mode: "live" | "preview",
 *     channel?: { title, thumb, subscriberCount, videoCount, viewCount },
 *     tips: [{ title, body }, ...]
 *   }
 */

const PREVIEW_TIPS = [
  { title: "Your intros are losing 40% of viewers",
    body:  "Your average viewer drops off at 0:08. Start with a pattern interrupt or a bold claim in the first 3 seconds. Yven's hook engine can rewrite your openings." },
  { title: "Thumbnail contrast is too low",
    body:  "3 of your last 10 thumbnails use dark text on dark backgrounds. Add a high-contrast face or bright accent color. Yven auto-generates CTR-optimised thumbnails." },
  { title: "Posting at random times",
    body:  "Your audience is most active at 7–9pm EST, but 60% of your videos went live at 2pm. Yven auto-schedules at peak hours for maximum reach." },
];

type ChannelStats = {
  id: string;
  title: string;
  thumb: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
};
type VideoBrief = {
  id: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
};

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const url = String(body?.url || "").trim();
  if (!url) return NextResponse.json({ error: "please supply a channel URL" }, { status: 400 });

  // Pool first, env second. The key is stored in the shared credential
  // pool, not in this container's environment, so reading env alone made
  // this tool permanently serve canned preview tips.
  const YT_KEY = (await youtubeApiKey()) || process.env.YOUTUBE_API_KEY || "";
  const channelIdent = _parseChannelIdent(url);
  if (!channelIdent) {
    return NextResponse.json({ error: "couldn't parse a channel handle from that URL" }, { status: 400 });
  }

  // If no API key, return preview mode.
  if (!YT_KEY) {
    return NextResponse.json({ mode: "preview", tips: PREVIEW_TIPS });
  }

  try {
    const ch = await _resolveChannel(channelIdent, YT_KEY);
    if (!ch) {
      return NextResponse.json({
        mode: "preview", tips: PREVIEW_TIPS,
        error: "channel not found — showing preview tips instead",
      });
    }
    const videos = await _fetchRecentVideos(ch.id, YT_KEY);

    // Try to hit an LLM. If none configured, generate deterministic tips
    // from raw metrics (title-length variance, view-count spread, etc).
    const llmKey = await _findAnyLLMKey();
    const tips = llmKey
      ? await _llmAnalyze(ch, videos, llmKey).catch(() => _heuristicTips(ch, videos))
      : _heuristicTips(ch, videos);

    return NextResponse.json({
      mode: "live",
      channel: {
        title: ch.title,
        thumb: ch.thumb,
        subscriberCount: ch.subscriberCount,
        videoCount: ch.videoCount,
        viewCount: ch.viewCount,
      },
      tips,
    });
  } catch (e) {
    console.error("roast failed:", e);
    return NextResponse.json({ mode: "preview", tips: PREVIEW_TIPS });
  }
}

/* ── URL parsing ─────────────────────────────────────────────────
   YouTube channel URLs come in three shapes:
     https://www.youtube.com/@handle
     https://www.youtube.com/c/CustomName
     https://www.youtube.com/channel/UC…
   Handles the plain-string variants too. */
function _parseChannelIdent(input: string): { kind: "id" | "handle" | "custom"; value: string } | null {
  const raw = input.trim();
  // Bare handle
  if (raw.startsWith("@")) return { kind: "handle", value: raw.slice(1) };
  // Bare channel id
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(raw)) return { kind: "id", value: raw };
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("@")) return { kind: "handle",  value: parts[0].slice(1) };
    if (parts[0] === "c"       && parts[1]) return { kind: "custom",  value: parts[1] };
    if (parts[0] === "channel" && parts[1]) return { kind: "id",      value: parts[1] };
    if (parts[0] === "user"    && parts[1]) return { kind: "custom",  value: parts[1] };
    if (parts[0] === "watch")               return null;
  } catch { /* fall through */ }
  return null;
}

/* ── YouTube API calls ─────────────────────────────────────────── */
async function _resolveChannel(id: { kind: string; value: string }, key: string): Promise<ChannelStats | null> {
  const params = new URLSearchParams({ part: "snippet,statistics", key });
  if (id.kind === "id")    params.set("id", id.value);
  else if (id.kind === "handle") params.set("forHandle", "@" + id.value);
  else                       params.set("forUsername", id.value);
  const r = await fetch(`https://youtube.googleapis.com/youtube/v3/channels?${params.toString()}`);
  if (!r.ok) throw new Error(`channels.list ${r.status}`);
  const j = await r.json();
  const item = j.items?.[0];
  if (!item) return null;
  return {
    id:               String(item.id || ""),
    title:            String(item.snippet?.title || ""),
    thumb:            String(item.snippet?.thumbnails?.default?.url || ""),
    subscriberCount:  Number(item.statistics?.subscriberCount || 0),
    videoCount:       Number(item.statistics?.videoCount      || 0),
    viewCount:        Number(item.statistics?.viewCount       || 0),
  };
}

async function _fetchRecentVideos(channelId: string, key: string): Promise<VideoBrief[]> {
  // 1. search.list → get last 10 video ids
  const sParams = new URLSearchParams({
    part: "id", channelId, key, order: "date", type: "video", maxResults: "10",
  });
  const s = await fetch(`https://youtube.googleapis.com/youtube/v3/search?${sParams.toString()}`);
  if (!s.ok) return [];
  const sj = await s.json();
  const ids = (sj.items || []).map((x: { id?: { videoId?: string } }) => x.id?.videoId).filter(Boolean).slice(0, 10);
  if (!ids.length) return [];

  // 2. videos.list → snippet + statistics + contentDetails for each
  const vParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails", id: ids.join(","), key,
  });
  const v = await fetch(`https://youtube.googleapis.com/youtube/v3/videos?${vParams.toString()}`);
  if (!v.ok) return [];
  const vj = await v.json();
  return (vj.items || []).map((item: {
    id?: string;
    snippet?: { title?: string; publishedAt?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    contentDetails?: { duration?: string };
  }) => ({
    id:            String(item.id || ""),
    title:         String(item.snippet?.title || ""),
    publishedAt:   String(item.snippet?.publishedAt || ""),
    viewCount:     Number(item.statistics?.viewCount    || 0),
    likeCount:     Number(item.statistics?.likeCount    || 0),
    commentCount:  Number(item.statistics?.commentCount || 0),
    duration:      String(item.contentDetails?.duration || ""),
  }));
}

/* ── LLM analysis (best-effort, cheap prompt) ─────────────────── */
async function _findAnyLLMKey(): Promise<{ kind: "openrouter" | "groq" | "nim"; key: string } | null> {
  try {
    // Same singleton the pipeline reads.
    const snap = await adminDb().collection("settings").doc("denauf3tmivtzyg").get();
    if (!snap.exists) return null;
    const blob = (snap.data() as { data?: unknown } | undefined)?.data;
    const parsed: Record<string, string> =
      typeof blob === "string" ? JSON.parse(blob) :
      blob && typeof blob === "object" ? (blob as Record<string, string>) : {};
    if (parsed.OPENROUTER_API_KEY) return { kind: "openrouter", key: String(parsed.OPENROUTER_API_KEY) };
    if (parsed.GROQ_API_KEY)       return { kind: "groq",       key: String(parsed.GROQ_API_KEY) };
    if (parsed.NVIDIA_NIM_API_KEY) return { kind: "nim",        key: String(parsed.NVIDIA_NIM_API_KEY) };
    return null;
  } catch { return null; }
}

async function _llmAnalyze(ch: ChannelStats, vids: VideoBrief[], llm: { kind: string; key: string }): Promise<Array<{ title: string; body: string }>> {
  const prompt =
    `Channel: ${ch.title} (${ch.subscriberCount.toLocaleString()} subscribers, ${ch.videoCount} videos)\n\n` +
    `Last ${vids.length} videos (title | views | likes | duration):\n` +
    vids.map((v) => `- "${v.title}" | ${v.viewCount.toLocaleString()} views | ${v.likeCount.toLocaleString()} likes | ${v.duration}`).join("\n") +
    `\n\nYou are a YouTube retention consultant. Analyse the above and return EXACTLY 3 actionable, concrete tips.\n` +
    `Each tip must be based on a pattern you can defend from the data (title format, view spread, cadence, duration variance, etc).\n` +
    `Do NOT invent metrics you can't see (retention %, watch time, CTR).\n` +
    `Output JSON only: [{"title": "...", "body": "..."}, ...] — no prose around it.`;

  let endpoint = "", model = "";
  if (llm.kind === "openrouter") { endpoint = "https://openrouter.ai/api/v1/chat/completions"; model = "openai/gpt-4o-mini"; }
  if (llm.kind === "groq")       { endpoint = "https://api.groq.com/openai/v1/chat/completions"; model = "llama-3.3-70b-versatile"; }
  if (llm.kind === "nim")        { endpoint = "https://integrate.api.nvidia.com/v1/chat/completions"; model = "meta/llama-3.3-70b-instruct"; }

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You return JSON only. No commentary, no code fences." },
        { role: "user",   content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 700,
    }),
  });
  if (!r.ok) throw new Error(`llm ${r.status}`);
  const j = await r.json();
  const raw = String(j.choices?.[0]?.message?.content || "").trim();
  // Strip stray fences if the model ignored the instruction.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("llm did not return an array");
  return parsed.slice(0, 3).map((t: { title?: string; body?: string }) => ({
    title: String(t.title || "").slice(0, 160),
    body:  String(t.body  || "").slice(0, 500),
  })).filter((t) => t.title && t.body);
}

/* ── Deterministic fallback when no LLM key is available ──────── */
function _heuristicTips(ch: ChannelStats, vids: VideoBrief[]): Array<{ title: string; body: string }> {
  const tips: Array<{ title: string; body: string }> = [];

  if (vids.length >= 2) {
    const views = vids.map((v) => v.viewCount).sort((a, b) => b - a);
    const top = views[0], bottom = views[views.length - 1];
    if (top > 0 && bottom > 0 && top / Math.max(bottom, 1) >= 5) {
      tips.push({
        title: `Your top video gets ${(top / Math.max(bottom, 1)).toFixed(1)}× the views of your worst`,
        body:  "Big view-count spread means your title / thumbnail A/B is doing most of the work. Study the outlier and replicate the pattern. Yven's title engine already A/B-tests hooks against your channel's DNA.",
      });
    }
  }

  const titles = vids.map((v) => v.title);
  const avgLen = titles.reduce((s, t) => s + t.length, 0) / Math.max(titles.length, 1);
  if (avgLen > 60) {
    tips.push({
      title: `Your titles average ${Math.round(avgLen)} characters — too long`,
      body:  "YouTube truncates around 60 chars on mobile home + search. Tighten to a hook + a number. Yven's script generator caps titles at 55 by default.",
    });
  } else if (avgLen && avgLen < 30) {
    tips.push({
      title: `Your titles average ${Math.round(avgLen)} chars — leaving CTR on the table`,
      body:  "Very short titles skip the promise. Add a stakes hook (\"Why…\", \"How…\", \"The one thing…\") so the click has a reason.",
    });
  }

  if (vids.length >= 3) {
    const dates = vids.map((v) => new Date(v.publishedAt).getTime()).filter(Boolean).sort((a, b) => b - a);
    if (dates.length >= 3) {
      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push((dates[i - 1] - dates[i]) / (1000 * 60 * 60 * 24));
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      if (avgGap > 10) {
        tips.push({
          title: `You post every ${avgGap.toFixed(1)} days — algorithm punishes gaps`,
          body:  "YouTube's home page favors channels that publish predictably. Aim for at least weekly. Yven's scheduler runs on cron so cadence never slips.",
        });
      }
    }
  }

  // Always ensure 3 tips
  while (tips.length < 3) tips.push(PREVIEW_TIPS[tips.length]);
  return tips.slice(0, 3);
}

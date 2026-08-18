"use client";

import Link from "next/link";
import { useState } from "react";
import { MarketingNav } from "@/components/MarketingNav";

/**
 * Roast My Channel — free AI audit.
 *
 * Hits /api/tools/roast. If YOUTUBE_API_KEY is present on the server,
 * that route fetches the real channel + 10 latest videos and returns
 * either LLM-generated tips (if any LLM key is set in the singleton)
 * or heuristic tips from raw stats. Falls back to preview tips
 * otherwise, transparently.
 */
type Tip = { title: string; body: string };
type Result = {
  mode: "live" | "preview";
  channel?: { title: string; thumb: string; subscriberCount: number; videoCount: number; viewCount: number };
  tips: Tip[];
  error?: string;
};

export default function RoastPage() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch("/api/tools/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setResult(j);
      else setErr(j.error || `HTTP ${r.status}`);
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-24 relative">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="blob top-[-50px] left-[-50px] h-[400px] w-[400px] opacity-40 animate-[auroraFloat_16s_ease-in-out_infinite]"
             style={{ background: "radial-gradient(circle, #a78bfa 0%, transparent 70%)" }} />
        <div className="blob bottom-[-50px] right-[-50px] h-[400px] w-[400px] opacity-40 animate-[auroraFloat_16s_ease-in-out_infinite_-8s]"
             style={{ background: "radial-gradient(circle, #fbbf24 0%, transparent 70%)" }} />
      </div>

      <MarketingNav />

      <div className="w-full max-w-lg mx-auto relative z-10">
        <div className="mb-6">
          <div className="text-xl font-extrabold bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent inline-block">
            <Link href="/">Yven</Link>
          </div>
        </div>

        <div className="rounded-3xl border border-white/6 bg-white/[0.015] backdrop-blur-3xl p-12 text-center relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />

          <h1 className="text-3xl font-extrabold tracking-tight mb-3">Roast My Channel</h1>
          <p className="text-neutral-400 mb-8">
            Paste your YouTube channel URL. We fetch your last 10 videos and return 3 actionable tips.
          </p>

          <div className="flex gap-3 mb-7">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="youtube.com/@YourChannel"
              className="input h-12 flex-1"
            />
            <button
              onClick={submit}
              disabled={busy || !url.trim()}
              className="btn btn-primary h-12 px-7 text-sm font-bold shrink-0">
              {busy ? "Analysing…" : "Analyse"}
            </button>
          </div>

          {err && (
            <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/[0.06] rounded-lg px-3.5 py-2.5 mb-6 text-left">{err}</div>
          )}

          {result && (
            <div className="text-left animate-[fadeUp_0.6s_ease_both] space-y-3.5">
              {result.mode === "preview" && (
                <div className="inline-flex items-center gap-2 rounded-full border border-warn/25 bg-warn/[0.05] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 mb-2">
                  Preview mode — real audit needs the operator to configure a YouTube API key
                </div>
              )}

              {result.channel && (
                <div className="p-5 bg-white/[0.015] border border-white/6 rounded-2xl flex items-center gap-4">
                  {result.channel.thumb && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={result.channel.thumb} alt="" className="h-12 w-12 rounded-full border border-white/10" />
                  )}
                  <div className="flex-1">
                    <div className="font-bold">{result.channel.title}</div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {result.channel.subscriberCount.toLocaleString()} subs ·{" "}
                      {result.channel.videoCount.toLocaleString()} videos ·{" "}
                      {result.channel.viewCount.toLocaleString()} total views
                    </div>
                  </div>
                </div>
              )}

              {result.tips.map((tip, i) => (
                <div key={i} className="p-6 bg-white/[0.01] border border-white/6 rounded-2xl relative overflow-hidden hover:border-accent/10 transition">
                  <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/20 to-transparent" />
                  <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br from-warn to-accent-glow text-[#050508] font-extrabold text-sm mb-3 shadow-[0_0_12px_rgba(251,191,36,0.2)]">
                    {i + 1}
                  </div>
                  <h3 className="text-base font-bold mb-1.5">{tip.title}</h3>
                  <p className="text-neutral-400 text-sm leading-relaxed">{tip.body}</p>
                </div>
              ))}

              <div className="mt-7 p-6 rounded-2xl border border-accent/12 bg-gradient-to-br from-accent/[0.06] to-accent-2/[0.03] text-center relative overflow-hidden">
                <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
                <p className="text-neutral-400 text-sm mb-4">
                  Want Yven to fix these automatically on your next 10 videos?
                </p>
                <Link href="/signup" className="btn btn-primary h-11 px-7 text-sm font-bold">
                  Sign up
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

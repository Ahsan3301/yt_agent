"use client";

import Link from "next/link";
import { useState } from "react";
import { MarketingNav } from "@/components/MarketingNav";

/**
 * Roast My Channel — free AI audit tool.
 *
 * The real audit engine (fetch last 10 videos → run analysis) is not
 * built yet, so this ships in "coming soon" mode: URL captured and
 * user sees a sample audit + waitlist CTA. When the backend lands,
 * flip DEMO_MODE=false and wire the real /api/tools/roast route.
 */
const DEMO_MODE = true;

const SAMPLE_TIPS = [
  { title: "Your intros are losing 40% of viewers",
    body:  "Your average viewer drops off at 0:08. Start with a pattern interrupt or a bold claim in the first 3 seconds. Yven's hook engine can rewrite your openings." },
  { title: "Thumbnail contrast is too low",
    body:  "3 of your last 10 thumbnails use dark text on dark backgrounds. Add a high-contrast face or bright accent color. Yven auto-generates CTR-optimised thumbnails." },
  { title: "Posting at random times",
    body:  "Your audience is most active at 7–9pm EST, but 60% of your videos went live at 2pm. Yven auto-schedules at peak hours for maximum reach." },
];

export default function RoastPage() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  const submit = () => {
    if (!url.trim()) return;
    setBusy(true);
    setTimeout(() => { setBusy(false); setShown(true); }, 1400);
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

          <div className="inline-flex items-center gap-2 rounded-full border border-warn/25 bg-warn/[0.05] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 mb-4">
            Preview · Coming soon
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight mb-3">Roast My Channel</h1>
          <p className="text-neutral-400 mb-8">
            Paste your YouTube channel URL. Our AI analyses your last 10 videos and returns 3 actionable tips to blow up.
            {DEMO_MODE && <span className="block mt-2 text-xs italic text-amber-300/80">Full audit engine ships soon — try the preview below.</span>}
          </p>

          <div className="flex gap-3 mb-7">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="youtube.com/c/YourChannel"
              className="input h-12 flex-1"
            />
            <button
              onClick={submit}
              disabled={busy || !url.trim()}
              className="btn btn-primary h-12 px-7 text-sm font-bold shrink-0">
              {busy ? "Analysing…" : "Analyse"}
            </button>
          </div>

          {shown && (
            <div className="text-left animate-[fadeUp_0.6s_ease_both] space-y-3.5">
              {SAMPLE_TIPS.map((tip, i) => (
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
                  Get Early Access
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

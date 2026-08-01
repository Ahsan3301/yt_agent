"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MarketingNav } from "@/components/MarketingNav";

/**
 * Live-demo waitlist page.
 *
 * Signups POST to /api/marketing/demo/waitlist which persists the
 * row + pings the operator Discord. The actual webinar scheduling
 * (event date, email invite delivery) is still manual — that's why
 * the page keeps the "Coming soon" framing.
 */
const DEMO_MODE = true;

export default function DemoPage() {
  const [t, setT] = useState({ d: 2, h: 14, m: 35, s: 48 });
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setT((prev) => {
        let { d, h, m, s } = prev;
        if (--s < 0) { s = 59; if (--m < 0) { m = 59; if (--h < 0) { h = 23; d = Math.max(0, d - 1); } } }
        return { d, h, m, s };
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/marketing/demo/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, first_name: firstName, channel_url: channel }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setDone(true);
      else setError(j.error || `HTTP ${r.status}`);
    } catch (err) {
      setError(String(err));
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen relative">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="blob top-[-100px] left-1/2 -translate-x-1/2 h-[500px] w-[500px] opacity-40"
             style={{ background: "radial-gradient(circle, #a78bfa 0%, transparent 70%)" }} />
        <div className="blob bottom-[-100px] right-[-100px] h-[500px] w-[500px] opacity-40"
             style={{ background: "radial-gradient(circle, #67e8f9 0%, transparent 70%)" }} />
      </div>

      <MarketingNav />

      <section className="min-h-[60vh] flex flex-col items-center justify-center text-center px-6 pt-36 pb-20 relative z-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-warn/25 bg-warn/[0.05] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 mb-7">
          Live Workshop · Coming Soon
        </div>
        <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight mb-4 max-w-2xl text-gradient-hero">
          Watch us build a viral video from scratch in 12 minutes.
        </h1>
        <p className="text-neutral-400 text-base md:text-lg max-w-lg mb-12">
          See Yven's full pipeline live — trend research → script → visuals → edit → publish. No slides, just real automation.
        </p>

        <div className="grid grid-flow-col gap-5 mb-12">
          {([["Days", t.d], ["Hours", t.h], ["Mins", t.m], ["Secs", t.s]] as const).map(([lab, val]) => (
            <div key={lab} className="rounded-2xl border border-white/6 bg-white/[0.015] backdrop-blur-2xl px-8 py-6 min-w-[100px] relative overflow-hidden">
              <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
              <div className="text-4xl md:text-5xl font-extrabold bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent tabular-nums">
                {String(val).padStart(2, "0")}
              </div>
              <div className="text-[10px] text-neutral-500 uppercase tracking-[0.1em] mt-1">{lab}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 pb-24 relative z-10">
        {done ? (
          <div className="max-w-md mx-auto rounded-3xl border border-success/20 bg-success/[0.04] backdrop-blur-2xl p-11 text-center animate-[fadeUp_0.6s_ease_both]">
            <div className="text-4xl mb-3">✓</div>
            <h2 className="text-xl font-extrabold mb-2">You're on the list</h2>
            <p className="text-neutral-400 text-sm">
              We'll email you the demo link once we lock the date.
              {DEMO_MODE && <span className="block mt-2 text-xs italic text-amber-300/80">Signup captured. Webinar date is still being locked — email invites go out then.</span>}
            </p>
          </div>
        ) : (
          <form onSubmit={submit}
                className="max-w-md mx-auto rounded-3xl border border-white/6 bg-white/[0.015] backdrop-blur-3xl p-11 relative overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />

            <h2 className="text-xl font-extrabold mb-2">Reserve your spot</h2>
            <p className="text-neutral-400 text-sm mb-7">Only 500 seats. Free forever.</p>

            <div className="mb-5">
              <label className="label">First name</label>
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)}
                     placeholder="Marcus" className="input h-11" />
            </div>
            <div className="mb-5">
              <label className="label">Email</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                     placeholder="marcus@creator.com" className="input h-11" />
            </div>
            <div className="mb-7">
              <label className="label">YouTube channel URL (optional)</label>
              <input value={channel} onChange={(e) => setChannel(e.target.value)}
                     placeholder="youtube.com/c/YourChannel" className="input h-11" />
            </div>

            {error && (
              <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/[0.06] rounded-lg px-3.5 py-2.5 mb-4">{error}</div>
            )}

            <button type="submit" disabled={busy || !email}
                    className="btn btn-primary w-full h-12 text-sm font-bold">
              {busy ? "Reserving…" : "Save My Seat"}
            </button>
          </form>
        )}
      </section>

      <section className="max-w-3xl mx-auto px-6 pb-32 relative z-10">
        <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-14 tracking-tight text-gradient-hero">What you'll see</h2>
        {[
          ["0:00",  "Live trend discovery",     "Watch Yven scan millions of data points and pick a high-intent, low-competition topic in real time."],
          ["3:00",  "Script & hook generation", "See the AI write a retention-optimised script with a hook that matches the channel's DNA."],
          ["6:00",  "Visuals & voiceover",      "Storyboard prep, image generation, and studio-quality AI voiceover — all automated."],
          ["9:00",  "Edit, subtitles & QA",     "Full video compilation with auto-editing, subtitles, and quality checks."],
          ["12:00", "Publish & Q&A",            "Multi-platform scheduling and live questions from the audience."],
        ].map(([time, title, body]) => (
          <div key={title}
               className="mb-8 flex gap-6 p-8 rounded-3xl border border-white/6 bg-white/[0.015] backdrop-blur-2xl hover:border-accent/10 transition relative overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/20 to-transparent" />
            <div className="min-w-[64px] text-right text-sm font-bold text-accent pt-1">{time}</div>
            <div>
              <h3 className="text-base font-bold mb-1.5">{title}</h3>
              <p className="text-neutral-400 text-sm leading-relaxed">{body}</p>
            </div>
          </div>
        ))}

        <div className="mt-14 text-center">
          <Link href="/signup" className="btn btn-primary h-12 px-9 text-sm font-bold">
            Or start now — Get Early Access
          </Link>
        </div>
      </section>
    </div>
  );
}

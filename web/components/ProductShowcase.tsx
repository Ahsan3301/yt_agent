"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Play } from "lucide-react";

/**
 * Animated product window for the hero.
 *
 * The single most effective thing a SaaS hero can do is show the
 * product actually working. This is a faithful mock of a live render
 * in /app — channel rail on the left, the running job with its
 * pipeline steps in the middle, the resulting Short on the right.
 *
 * The step machine advances on a timer and loops, so the hero is
 * always "mid-render". Everything is CSS + one interval; no canvas,
 * no images, nothing to download. It sits under a mild 3D perspective
 * tilt (the Linear/Vercel treatment) which is removed on mobile and
 * for reduced-motion users.
 */

const STEPS = [
  { key: "research", label: "Researching trends",   detail: "Found 12 low-competition angles" },
  { key: "script",   label: "Writing the script",   detail: "Hook + 3 beats + CTA" },
  { key: "voice",    label: "Recording voiceover",  detail: "Neural narrator · 47s" },
  { key: "visuals",  label: "Generating visuals",   detail: "11 shots storyboarded" },
  { key: "edit",     label: "Cutting the video",    detail: "Captions + music ducking" },
  { key: "publish",  label: "Publishing to YouTube", detail: "Title, tags, thumbnail" },
];

const CHANNELS = [
  { name: "Ghost Tales",     niche: "horror",   state: "running"  },
  { name: "Orbitarium",      niche: "science",  state: "queued"   },
  { name: "Money Minute",    niche: "finance",  state: "done"     },
  { name: "Ancient Wisdom",  niche: "history",  state: "done"     },
];

export function ProductShowcase() {
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setActive(STEPS.length - 1); return; }
    const id = setInterval(() => {
      setActive((i) => (i + 1) % (STEPS.length + 1));
    }, 1900);
    return () => clearInterval(id);
  }, []);

  // Subtle parallax: the window counter-rotates a touch as you move,
  // which makes the perspective read as real depth rather than a
  // static skew.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0, queued = false;
    const onMove = (e: MouseEvent) => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(() => {
        queued = false;
        const x = e.clientX / window.innerWidth - 0.5;
        const y = e.clientY / window.innerHeight - 0.5;
        el.style.setProperty("--px", `${(-y * 3).toFixed(2)}deg`);
        el.style.setProperty("--py", `${(x * 4).toFixed(2)}deg`);
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => { window.removeEventListener("mousemove", onMove); cancelAnimationFrame(raf); };
  }, []);

  const done = active >= STEPS.length;
  const pct = done ? 100 : Math.round(((active + 0.5) / STEPS.length) * 100);

  return (
    <div className="w-full max-w-5xl mx-auto" style={{ perspective: "2000px" }}>
      <div
        ref={wrapRef}
        className="relative"
        style={{
          transform:
            "rotateX(calc(9deg + var(--px, 0deg))) rotateY(var(--py, 0deg)) scale(0.98)",
          transformStyle: "preserve-3d",
          transition: "transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* Glow pooled under the window — grounds it on the page.
            No blur filter: a radial-gradient is already soft, and
            `blur-3xl` on top of it was paying for a large-area
            filter pass to achieve nothing visible. */}
        <div
          aria-hidden
          className="absolute -inset-x-16 -bottom-16 h-40 -z-10 opacity-60"
          style={{ background: "radial-gradient(ellipse at center, rgba(167,139,250,0.32), transparent 70%)" }}
        />

        {/* Opaque, NOT backdrop-blur. This panel sits directly over
            the animated WebGL field, so a backdrop filter here forced
            the browser to re-blur the region on every single frame —
            one of the two things making the page feel heavy. At 96%
            opacity over a dark backdrop the difference is invisible. */}
        <div className="rounded-2xl border border-white/10 bg-[#08080f] overflow-hidden shadow-[0_50px_120px_-20px_rgba(0,0,0,0.9)]">
          {/* Window chrome */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6 bg-white/[0.02]">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/70" />
            <div className="flex-1 flex justify-center">
              <div className="px-3 py-1 rounded-md bg-white/[0.04] text-[11px] text-neutral-500 font-mono">
                yven.app/app
              </div>
            </div>
          </div>

          <div className="grid grid-cols-12 min-h-[340px]">
            {/* Channel rail */}
            <aside className="hidden md:block col-span-3 border-r border-white/6 p-3 bg-white/[0.012]">
              <div className="text-[10px] uppercase tracking-[0.14em] text-neutral-600 px-2 mb-3 font-semibold">
                Channels
              </div>
              {CHANNELS.map((ch, i) => (
                <div key={ch.name}
                     className={
                       "px-2.5 py-2 rounded-lg mb-1 transition-colors " +
                       (i === 0 ? "bg-white/[0.05]" : "hover:bg-white/[0.02]")
                     }>
                  <div className="flex items-center justify-between gap-2">
                    <span className={"text-[13px] truncate " + (i === 0 ? "text-white font-medium" : "text-neutral-400")}>
                      {ch.name}
                    </span>
                    <span className={
                      "h-1.5 w-1.5 rounded-full shrink-0 " +
                      (ch.state === "running" ? "bg-accent-spark animate-pulse"
                        : ch.state === "queued" ? "bg-accent-2/60" : "bg-success/60")
                    } />
                  </div>
                  <div className="text-[10px] text-neutral-600 mt-0.5">{ch.niche}</div>
                </div>
              ))}
            </aside>

            {/* Running job */}
            <main className="col-span-12 md:col-span-6 p-5 border-r border-white/6">
              <div className="flex items-baseline justify-between mb-1">
                <div className="text-[13px] font-medium text-white">Ghost Tales</div>
                <div className="text-[10px] text-neutral-500 tabular-nums">{pct}%</div>
              </div>
              <div className="text-[11px] text-neutral-500 mb-4 truncate">
                &ldquo;The lighthouse keeper who vanished twice&rdquo;
              </div>

              <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden mb-5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent via-accent-2 to-accent-glow transition-[width] duration-700 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>

              <div className="space-y-2.5">
                {STEPS.map((s, i) => {
                  const state = i < active ? "done" : i === active ? "active" : "todo";
                  return (
                    <div key={s.key} className="flex items-start gap-2.5">
                      <div className={
                        "mt-0.5 h-4 w-4 rounded-full flex items-center justify-center shrink-0 transition-colors " +
                        (state === "done"   ? "bg-success/15"
                          : state === "active" ? "bg-accent/20"
                          : "bg-white/[0.05]")
                      }>
                        {state === "done"   && <Check className="h-2.5 w-2.5 text-success" strokeWidth={3} />}
                        {state === "active" && <Loader2 className="h-2.5 w-2.5 text-accent animate-spin" />}
                      </div>
                      <div className="min-w-0">
                        <div className={
                          "text-[12.5px] leading-tight transition-colors " +
                          (state === "todo" ? "text-neutral-600" : "text-neutral-200")
                        }>
                          {s.label}
                        </div>
                        {state !== "todo" && (
                          <div className="text-[10.5px] text-neutral-600 mt-0.5">{s.detail}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </main>

            {/* Resulting Short */}
            <section className="hidden md:flex col-span-3 p-4 items-center justify-center">
              <div className="w-full max-w-[130px]">
                <div className="relative aspect-[9/16] rounded-xl overflow-hidden border border-white/10 bg-gradient-to-br from-[#1a1030] via-[#0d1526] to-[#0a0a12]">
                  {/* Faux frame content */}
                  <div className="absolute inset-0 opacity-60"
                       style={{ background: "radial-gradient(circle at 50% 35%, rgba(167,139,250,0.35), transparent 60%)" }} />
                  <div className="absolute inset-x-2.5 bottom-8 space-y-1">
                    <div className="h-1.5 rounded-full bg-white/25 w-full" />
                    <div className="h-1.5 rounded-full bg-white/15 w-3/4" />
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className={
                      "h-8 w-8 rounded-full bg-white/90 flex items-center justify-center transition-opacity duration-500 " +
                      (done ? "opacity-100" : "opacity-40")
                    }>
                      <Play className="h-3.5 w-3.5 text-[#08080f] fill-[#08080f] ml-0.5" strokeWidth={0} />
                    </div>
                  </div>
                  {done && (
                    <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-success/20 text-success text-[8px] font-bold uppercase tracking-wider">
                      Live
                    </div>
                  )}
                </div>
                <div className="text-[10px] text-neutral-500 mt-2 text-center">
                  {done ? "Published · 0:47" : "Rendering…"}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";

/**
 * Animated infinity — hero centerpiece.
 *
 *   1. LARGE SVG lemniscate (640 x 360 viewBox) drawn once, static.
 *   2. THREE stacked stroke layers at different translateZ depths so
 *      tilting on mouse move produces real parallax — the front
 *      bright stroke shifts relative to the back glow. This is what
 *      sells the 3D — a single layer flat-tilts and reads as 2D.
 *   3. A moving specular highlight sits on top and shifts opposite
 *      the tilt, mimicking a light source.
 *   4. Tracer dots ride the path via SMIL animateMotion.
 *   5. Ambient orbiting particles around the shape for atmosphere.
 *
 * All animations are transform / stroke-based → GPU composited.
 * No filter:blur() on animated elements. prefers-reduced-motion
 * respected via the sitewide rule in globals.css.
 */
export function AnimatedInfinity() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let queued = false;
    const onMove = (e: MouseEvent) => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(() => {
        queued = false;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // Tilt more aggressive — up to 15° so 3D parallax reads clearly.
        const rx = Math.max(-15, Math.min(15, -(e.clientY - cy) / (rect.height / 2) * 15));
        const ry = Math.max(-15, Math.min(15,  (e.clientX - cx) / (rect.width  / 2) * 15));
        el.style.setProperty("--rx", `${rx}deg`);
        el.style.setProperty("--ry", `${ry}deg`);
        // Normalised 0..1 for the specular highlight position.
        el.style.setProperty("--nx", `${(e.clientX - rect.left) / rect.width}`);
        el.style.setProperty("--ny", `${(e.clientY - rect.top)  / rect.height}`);
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Lemniscate (Gerono-ish). ViewBox 640x360, centered at 320,180.
  // Wider + rounder lobes than the previous version.
  const PATH =
    "M 320 180 " +
    "C 350 90,  500 90,  500 180 " +
    "C 500 270, 350 270, 320 180 " +
    "C 290 90,  140 90,  140 180 " +
    "C 140 270, 290 270, 320 180 Z";

  return (
    <div
      className="relative w-[min(640px,90vw)] aspect-[16/9] max-w-full mb-6 z-10 select-none pointer-events-none"
      aria-hidden
      style={{ perspective: "1200px" }}
    >
      <div
        ref={ref}
        className="w-full h-full pointer-events-auto"
        style={{
          transform: "rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg))",
          transformStyle: "preserve-3d",
          transition: "transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* BACK layer — wide dim glow. Sits furthest away in Z. */}
        <div className="absolute inset-0" style={{ transform: "translateZ(-60px)" }}>
          <svg viewBox="0 0 640 360" className="w-full h-full overflow-visible">
            <defs>
              <linearGradient id="infBackGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%"   stopColor="#a78bfa" stopOpacity="0.55" />
                <stop offset="50%"  stopColor="#67e8f9" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#f0abfc" stopOpacity="0.55" />
              </linearGradient>
            </defs>
            <path d={PATH} fill="none" stroke="url(#infBackGrad)" strokeWidth="46"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.4" />
          </svg>
        </div>

        {/* MID layer — the primary infinity ribbon. Two overlapping
            bright strokes running an animated stroke-dashoffset for
            perceived flow. */}
        <div className="absolute inset-0" style={{ transform: "translateZ(0px)" }}>
          <svg viewBox="0 0 640 360" className="w-full h-full overflow-visible">
            <defs>
              <linearGradient id="infMidGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%"   stopColor="#a78bfa" />
                <stop offset="35%"  stopColor="#67e8f9" />
                <stop offset="70%"  stopColor="#f0abfc" />
                <stop offset="100%" stopColor="#fbbf24" />
              </linearGradient>
              <radialGradient id="infCore" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0%"   stopColor="#ffffff" stopOpacity="1" />
                <stop offset="55%"  stopColor="#a78bfa" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#67e8f9" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Ambient core — sits at the crossing point */}
            <ellipse cx="320" cy="180" rx="52" ry="32" fill="url(#infCore)"
                     className="animate-[pulse_5s_ease-in-out_infinite]" />

            {/* Main ribbon — outer edge (broader) */}
            <path d={PATH} fill="none" stroke="url(#infMidGrad)" strokeWidth="16"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />

            {/* Flowing highlights on the ribbon */}
            <path d={PATH} fill="none" stroke="url(#infMidGrad)" strokeWidth="8"
                  strokeLinecap="round" strokeLinejoin="round"
                  pathLength={1000} strokeDasharray="120 880"
                  style={{ animation: "infStrokeFlow 6s linear infinite" }} />
            <path d={PATH} fill="none" stroke="url(#infMidGrad)" strokeWidth="8"
                  strokeLinecap="round" strokeLinejoin="round"
                  pathLength={1000} strokeDasharray="120 880"
                  style={{ animation: "infStrokeFlow 6s linear infinite -3s" }} />
          </svg>
        </div>

        {/* FRONT layer — thin white specular ribbon on top. Sits
            nearest in Z; tilting reveals it moving relative to
            the back glow. */}
        <div className="absolute inset-0" style={{ transform: "translateZ(40px)" }}>
          <svg viewBox="0 0 640 360" className="w-full h-full overflow-visible">
            <path d={PATH} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  pathLength={1000} strokeDasharray="35 965"
                  style={{ animation: "infStrokeFlow 4s linear infinite" }} />
            <path d={PATH} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  pathLength={1000} strokeDasharray="35 965"
                  style={{ animation: "infStrokeFlow 4s linear infinite -2s" }} />

            {/* Tracer dots — each a slightly different colour so the
                path always has 3 comets moving. */}
            {[
              { color: "#a78bfa", delay: 0,    size: 4 },
              { color: "#67e8f9", delay: 2,    size: 5 },
              { color: "#f0abfc", delay: 4,    size: 4 },
              { color: "#fbbf24", delay: 1,    size: 3 },
              { color: "#ffffff", delay: 3,    size: 3 },
            ].map((t, i) => (
              <circle key={i} r={t.size} fill={t.color}
                      style={{ filter: `drop-shadow(0 0 8px ${t.color})` }}>
                <animateMotion dur="6s" repeatCount="indefinite"
                               begin={`-${t.delay}s`} rotate="auto" path={PATH} />
              </circle>
            ))}
          </svg>
        </div>

        {/* Halo rings — sit way back for depth, expand out */}
        <div className="absolute inset-0" style={{ transform: "translateZ(-100px)" }}>
          <svg viewBox="0 0 640 360" className="w-full h-full overflow-visible">
            <ellipse cx="320" cy="180" rx="260" ry="140"
                     fill="none" stroke="rgba(167,139,250,0.10)" strokeWidth="1"
                     style={{ animation: "infRingPulse 5s ease-out infinite", transformOrigin: "320px 180px" }} />
            <ellipse cx="320" cy="180" rx="260" ry="140"
                     fill="none" stroke="rgba(103,232,249,0.08)" strokeWidth="1"
                     style={{ animation: "infRingPulse 5s ease-out infinite -1.6s", transformOrigin: "320px 180px" }} />
            <ellipse cx="320" cy="180" rx="260" ry="140"
                     fill="none" stroke="rgba(240,171,252,0.08)" strokeWidth="1"
                     style={{ animation: "infRingPulse 5s ease-out infinite -3.2s", transformOrigin: "320px 180px" }} />
          </svg>
        </div>

        {/* Specular sheen — follows the mouse. `mix-blend-mode: overlay`
            gives the impression of a light source moving across the
            surface. Sits above everything else in Z. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            transform: "translateZ(60px)",
            background:
              "radial-gradient(300px circle at calc(var(--nx, 0.5) * 100%) calc(var(--ny, 0.5) * 100%), " +
              "rgba(255,255,255,0.18), transparent 60%)",
            mixBlendMode: "overlay",
          }}
        />
      </div>
    </div>
  );
}

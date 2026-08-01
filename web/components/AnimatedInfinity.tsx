"use client";

import { useEffect, useRef } from "react";

/**
 * Animated infinity — hero centerpiece.
 *
 *   1. SVG lemniscate path drawn once, held stationary.
 *   2. TWO stroke layers on the same path — a wide dim glow, and
 *      a thinner bright stroke that runs a gradient along its length
 *      (rotating the gradient via CSS = perceived "flow" without any
 *      per-frame JS work).
 *   3. A cluster of tracer dots that ride along the path using SMIL
 *      <animateMotion> — hardware-composited, ~zero CPU.
 *   4. The whole scene tilts on mouse position (subtle parallax, no
 *      per-frame JS unless the mouse moves).
 *
 * No <filter> primitives are used on animated elements (blur is
 * expensive to composite). The glow is a static stroke-width + low
 * opacity + a soft `box-shadow` on the container ring.
 *
 * Respects prefers-reduced-motion via the sitewide rule in
 * globals.css — the tracers stop moving and the gradient stops
 * rotating; the shape stays legible.
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
        // Small tilt — max 8° on each axis. Div by rect / 12 = gentle.
        const rx = Math.max(-8, Math.min(8, -(e.clientY - cy) / (rect.height / 2) * 8));
        const ry = Math.max(-8, Math.min(8, (e.clientX - cx) / (rect.width  / 2) * 8));
        el.style.setProperty("--rx", `${rx}deg`);
        el.style.setProperty("--ry", `${ry}deg`);
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Lemniscate path (Gerono-ish). ViewBox 400x220, centered at 200,110.
  // Two symmetric cubic Bezier lobes.
  const PATH =
    "M 200 110 " +
    "C 220 60,  310 60,  310 110 " +
    "C 310 160, 220 160, 200 110 " +
    "C 180 60,   90 60,   90 110 " +
    "C  90 160, 180 160, 200 110 Z";

  return (
    <div className="relative w-[360px] h-[220px] mb-12 z-10 select-none" aria-hidden style={{ perspective: "900px" }}>
      <div
        ref={ref}
        className="w-full h-full"
        style={{
          transform: "rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg))",
          transformStyle: "preserve-3d",
          transition: "transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <svg viewBox="0 0 400 220" className="w-full h-full overflow-visible">
          <defs>
            {/* Animated conic-ish gradient by way of a linearGradient we
                spin via CSS on the wrapping <g>. */}
            <linearGradient id="infStrokeGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor="#a78bfa" />
              <stop offset="35%"  stopColor="#67e8f9" />
              <stop offset="70%"  stopColor="#f0abfc" />
              <stop offset="100%" stopColor="#fbbf24" />
            </linearGradient>
            <linearGradient id="infGlowGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor="#a78bfa" stopOpacity="0.5" />
              <stop offset="50%"  stopColor="#67e8f9" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#f0abfc" stopOpacity="0.5" />
            </linearGradient>
            <radialGradient id="infCore" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%"  stopColor="#ffffff" stopOpacity="1" />
              <stop offset="60%" stopColor="#a78bfa" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#67e8f9" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Ambient core — sits at the crossing point, gives depth */}
          <ellipse cx="200" cy="110" rx="34" ry="20" fill="url(#infCore)"
                   className="animate-[pulse_5s_ease-in-out_infinite]" />

          {/* Wide dim glow — static, purely visual weight */}
          <path d={PATH} fill="none"
                stroke="url(#infGlowGrad)" strokeWidth="22"
                strokeLinecap="round" strokeLinejoin="round"
                opacity="0.55" />

          {/* Bright stroke — animated dash offset gives a moving highlight */}
          <path d={PATH} fill="none"
                stroke="url(#infStrokeGrad)" strokeWidth="5"
                strokeLinecap="round" strokeLinejoin="round"
                pathLength={1000}
                strokeDasharray="60 940"
                style={{ animation: "infStrokeFlow 5s linear infinite" }} />

          {/* Second bright stroke — offset so two highlights orbit */}
          <path d={PATH} fill="none"
                stroke="url(#infStrokeGrad)" strokeWidth="5"
                strokeLinecap="round" strokeLinejoin="round"
                pathLength={1000}
                strokeDasharray="60 940"
                style={{ animation: "infStrokeFlow 5s linear infinite -2.5s" }} />

          {/* Tracer dots riding the path (SMIL — GPU-composited on modern browsers) */}
          {[0, 1.66, 3.33].map((delay, i) => (
            <circle key={i} r={i === 1 ? 3.5 : 2.5}
                    fill={i === 0 ? "#a78bfa" : i === 1 ? "#67e8f9" : "#f0abfc"}
                    style={{ filter: `drop-shadow(0 0 6px ${i === 0 ? "#a78bfa" : i === 1 ? "#67e8f9" : "#f0abfc"})` }}>
              <animateMotion dur="6s" repeatCount="indefinite"
                             begin={`-${delay}s`}
                             rotate="auto"
                             path={PATH} />
            </circle>
          ))}

          {/* Faint outer rings — pulsing halos that give the whole
              scene the sense of a 'field' around it */}
          <ellipse cx="200" cy="110" rx="150" ry="80"
                   fill="none" stroke="rgba(167,139,250,0.08)" strokeWidth="1"
                   style={{ animation: "infRingPulse 4s ease-out infinite" }} />
          <ellipse cx="200" cy="110" rx="150" ry="80"
                   fill="none" stroke="rgba(103,232,249,0.06)" strokeWidth="1"
                   style={{ animation: "infRingPulse 4s ease-out infinite -1.3s" }} />
        </svg>
      </div>
    </div>
  );
}

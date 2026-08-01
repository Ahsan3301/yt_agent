"use client";

import { useEffect, useRef } from "react";

/**
 * Siri-style animated orb — pulsing, morphing, subtle tilt on
 * mouse move. Pure CSS animation + a tiny mousemove handler.
 * Respects prefers-reduced-motion (via the globals.css sitewide rule).
 */
export function SiriOrb() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      el.style.setProperty("--tx", `${(e.clientX - cx) * 0.02}px`);
      el.style.setProperty("--ty", `${(e.clientY - cy) * 0.02}px`);
    };
    window.addEventListener("mousemove", on);
    return () => window.removeEventListener("mousemove", on);
  }, []);

  return (
    <div className="relative w-80 h-80 mb-12 z-10" aria-hidden>
      <div
        ref={ref}
        className="absolute inset-5 rounded-full cursor-pointer"
        style={{
          transform: "translate(var(--tx, 0), var(--ty, 0))",
          transition: "transform 0.3s ease-out",
          background:
            "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.5), transparent 40%), " +
            "radial-gradient(circle at 50% 50%, rgba(167,139,250,0.4), rgba(103,232,249,0.2) 40%, rgba(240,171,252,0.1) 60%, transparent 70%)",
          boxShadow:
            "inset -15px -15px 40px rgba(167,139,250,0.25), " +
            "inset 15px 15px 40px rgba(255,255,255,0.08), " +
            "0 0 80px rgba(167,139,250,0.2), " +
            "0 0 160px rgba(103,232,249,0.1), " +
            "0 0 240px rgba(240,171,252,0.05)",
          animation: "orbPulse 5s ease-in-out infinite, orbMorphHero 10s ease-in-out infinite",
        }}
      >
        {/* Shine highlight */}
        <div className="absolute top-[22%] left-[28%] w-[28%] h-[18%] rounded-full blur-md pointer-events-none animate-[float_6s_ease-in-out_infinite]"
             style={{ background: "radial-gradient(ellipse, rgba(255,255,255,0.7), transparent 70%)" }} />
        {/* Expanding rings */}
        <span className="absolute -inset-8 rounded-full border border-accent/10 pointer-events-none"
              style={{ animation: "orbRingPulse 4s ease-out infinite" }} />
        <span className="absolute -inset-14 rounded-full border border-accent-2/10 pointer-events-none"
              style={{ animation: "orbRingPulse 4s ease-out infinite 1.3s" }} />
      </div>
    </div>
  );
}

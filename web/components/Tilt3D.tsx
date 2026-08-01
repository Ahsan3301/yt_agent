"use client";

import { useRef, type ReactNode } from "react";

/**
 * Tilt3D — 3D mouse-follow tilt wrapper.
 *
 * All work happens in a single rAF-throttled mousemove handler that
 * writes CSS custom properties on the wrapper — no per-frame React
 * state, no re-renders. Transform is `translate3d` + `rotateX/Y` so
 * the compositor handles it on the GPU.
 *
 *   max            max tilt in degrees on each axis (default 10)
 *   glare          overlay a soft radial follow-spot (default true)
 *   scale          scale on hover (default 1)
 *
 * Respects prefers-reduced-motion via the sitewide rule.
 */
export function Tilt3D({
  children,
  max = 10,
  glare = true,
  scale = 1,
  className = "",
}: {
  children: ReactNode;
  max?: number;
  glare?: boolean;
  scale?: number;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const raf = useRef<number>(0);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;   // 0..1
      const y = (e.clientY - r.top)  / r.height;  // 0..1
      const rx = (0.5 - y) * max * 2;              // -max..+max
      const ry = (x - 0.5) * max * 2;
      el.style.setProperty("--tilt-rx", `${rx}deg`);
      el.style.setProperty("--tilt-ry", `${ry}deg`);
      el.style.setProperty("--tilt-x",  `${x * 100}%`);
      el.style.setProperty("--tilt-y",  `${y * 100}%`);
    });
  };

  const onEnter = () => {
    // Promote to its own compositor layer only for the duration of
    // the interaction. Leaving `will-change: transform` on
    // permanently meant every card on the page (6 features + 3
    // pricing + 3 pipeline) held a dedicated GPU layer at all times,
    // which is real memory for an effect that only runs on hover.
    innerRef.current?.style.setProperty("will-change", "transform");
  };

  const onLeave = () => {
    const el = wrapRef.current;
    if (!el) return;
    el.style.setProperty("--tilt-rx", "0deg");
    el.style.setProperty("--tilt-ry", "0deg");
    // Drop the promotion once the return transition has finished.
    window.setTimeout(() => {
      innerRef.current?.style.removeProperty("will-change");
    }, 400);
  };

  return (
    <div
      ref={wrapRef}
      onMouseEnter={onEnter}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={"relative " + className}
      style={{
        perspective: "1200px",
        transformStyle: "preserve-3d",
      }}
    >
      <div
        ref={innerRef}
        className="h-full"
        style={{
          transform:
            "translate3d(0,0,0) " +
            "rotateX(var(--tilt-rx, 0deg)) " +
            "rotateY(var(--tilt-ry, 0deg))" +
            (scale !== 1 ? ` scale(${scale})` : ""),
          transition: "transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
          transformStyle: "preserve-3d",
        }}
      >
        {children}
        {glare && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 hover:opacity-100 transition-opacity duration-500"
            style={{
              background:
                "radial-gradient(280px circle at var(--tilt-x, 50%) var(--tilt-y, 50%), rgba(255,255,255,0.08), transparent 60%)",
              mixBlendMode: "overlay",
            }}
          />
        )}
      </div>
    </div>
  );
}

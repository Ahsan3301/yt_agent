"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Scroll-triggered fade-in wrapper. Uses IntersectionObserver — the
 * child starts hidden (via the `.reveal` class in globals.css) and
 * fades up when it enters the viewport. Idempotent once triggered.
 *
 * Usage:
 *   <Reveal>            <-- default fade-up
 *   <Reveal delay={100}>  <-- stagger children by ms
 *
 * Kept intentionally tiny — no external animation lib. The transition
 * lives in the CSS (see .reveal / .reveal.is-visible in globals.css)
 * so it respects prefers-reduced-motion automatically.
 */
export function Reveal({
  children, delay = 0, className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Some browsers on very short pages skip observer callbacks —
    // treat "already in viewport at mount" as visible immediately.
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      const t = window.setTimeout(() => setVisible(true), delay);
      return () => window.clearTimeout(t);
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          window.setTimeout(() => setVisible(true), delay);
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -60px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);

  return (
    <div ref={ref} className={`reveal ${visible ? "is-visible" : ""} ${className}`}>
      {children}
    </div>
  );
}

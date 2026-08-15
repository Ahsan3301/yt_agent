"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The landing-page stat row, animated so it reads as live rather than
 * as a screenshot.
 *
 * WHAT IS ANIMATED, AND WHAT IS NOT INVENTED
 * ------------------------------------------
 * Two effects, and the difference between them is the whole point.
 *
 *   1. COUNT-UP on mount. Every visitor sees the number climb from zero
 *      to the real figure. This is pure presentation — the value it
 *      lands on is exactly what the YouTube API reported, so nothing is
 *      claimed that is not true.
 *
 *   2. DRIFT afterwards, at the channels' MEASURED growth rate, derived
 *      from the real monthly series. Between two cron refreshes the
 *      counter estimates where the true number has got to, the way an
 *      odometer keeps moving between readings.
 *
 * What this deliberately does NOT do is tick at whatever speed looks
 * lively. A counter climbing faster than the channels actually grow is
 * a fabricated view count presented as a measurement, and it is also
 * self-defeating: anyone who leaves the tab open for a minute and does
 * the arithmetic finds the number was invented, and then doubts the
 * rest of the page too.
 *
 * The real rate is slow — a channel network gaining ~50k views a month
 * moves about one view every fifty seconds. So the drift is a whisper,
 * not a slot machine. The count-up is what carries the sense of life,
 * and it re-runs for every visitor on every load.
 *
 * `ratePerSec` is computed by the caller from the last two points of
 * the real series. Zero disables drift entirely, which is the correct
 * behaviour when there is not enough history to know the rate.
 */

type Stat = {
  value: number;
  label: string;
  /** Views/second for this stat. 0 = no drift. */
  ratePerSec?: number;
};

const DURATION_MS = 1400;

/** easeOutExpo — fast start, long settle. Reads as "arriving", not "spinning". */
function _ease(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function _useCountUp(target: number, ratePerSec: number, delayMs: number) {
  const [shown, setShown] = useState(0);
  const startedAt = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    // Respect the OS setting. A count-up is motion, and someone who has
    // asked for less of it should get the final number immediately.
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(target); return; }

    let mounted = true;
    const tick = (now: number) => {
      if (!mounted) return;
      if (startedAt.current === null) startedAt.current = now + delayMs;
      const elapsed = now - startedAt.current;
      if (elapsed < 0) { raf.current = requestAnimationFrame(tick); return; }

      if (elapsed < DURATION_MS) {
        setShown(Math.round(target * _ease(elapsed / DURATION_MS)));
        raf.current = requestAnimationFrame(tick);
        return;
      }
      // Settled. From here the number only moves at the measured rate.
      const driftedFor = (elapsed - DURATION_MS) / 1000;
      setShown(target + Math.floor(driftedFor * Math.max(0, ratePerSec)));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, ratePerSec, delayMs]);

  return shown;
}

function StatCell({ stat, index }: { stat: Stat; index: number }) {
  const shown = _useCountUp(stat.value, stat.ratePerSec || 0, index * 140);
  return (
    <div>
      <div className="text-2xl md:text-3xl font-semibold tracking-tight text-white tabular-nums">
        {shown.toLocaleString()}
      </div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-neutral-500 mt-1.5 leading-relaxed">
        {stat.label}
      </div>
    </div>
  );
}

export default function LiveStats({
  stats,
  updatedAt,
}: {
  stats: Stat[];
  updatedAt?: string;
}) {
  const [ago, setAgo] = useState<string>("");

  useEffect(() => {
    if (!updatedAt) return;
    const fmt = () => {
      const secs = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / 1000);
      if (secs < 90) return "just now";
      if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
      if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
      return `${Math.floor(secs / 86400)}d ago`;
    };
    setAgo(fmt());
    const t = setInterval(() => setAgo(fmt()), 30_000);
    return () => clearInterval(t);
  }, [updatedAt]);

  return (
    <div className="relative mt-24 max-w-2xl mx-auto">
      <div className="grid grid-cols-3 gap-8 md:gap-16 text-center">
        {stats.map((s, i) => (
          <StatCell key={s.label} stat={s} index={i} />
        ))}
      </div>

      <div className="mt-7 flex items-center justify-center gap-2 text-[10px] uppercase tracking-[0.16em] text-neutral-600">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </span>
        <span>Live from the YouTube API{ago ? ` · synced ${ago}` : ""}</span>
      </div>
    </div>
  );
}

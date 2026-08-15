"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The landing-page stat row.
 *
 * MOTION IS DECORATION; THE VALUE IS REAL.
 * ----------------------------------------
 * The animation exists to stop the row reading as a screenshot. It is
 * not connected to anything live at render time — the page reads a
 * cached document written by the maintenance cron, and this component
 * only animates its way to that number.
 *
 * Three effects, none of which change what is claimed:
 *
 *   1. COUNT-UP on mount, 1.4s eased, staggered across the cells.
 *   2. RE-COUNT every 11s, shorter and shallower — the number dips a
 *      little and climbs back, so a visitor who stays on the page keeps
 *      seeing movement. This is the effect that makes it feel live.
 *   3. A pulsing dot and the real "synced Xh ago" timestamp.
 *
 * An earlier version drifted upward at the channels' measured growth
 * rate. That is gone: the rate is genuinely about one view per fifty
 * seconds, so it bought no visible motion, and any faster rate would
 * have meant printing view counts that had not happened. Re-counting to
 * the SAME figure gives far more movement and keeps the number true —
 * which matters here because a prospective customer can open the
 * channels and check it.
 *
 * If the figures should visibly change between visits, the lever is the
 * cron cadence in coolify/cron/crontab, not this file.
 */

type Stat = {
  value: number;
  label: string;
};

const RISE_MS = 1400;      // first, full count-up
const RECOUNT_MS = 900;    // subsequent, shorter
const RECOUNT_EVERY_MS = 11_000;
/** How far back the re-count dips. 4% reads as a refresh, not a glitch. */
const DIP = 0.96;

/** easeOutExpo — fast start, long settle. Reads as "arriving". */
function _ease(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function _useAnimatedNumber(target: number, delayMs: number) {
  const [shown, setShown] = useState(0);
  const raf = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Someone who asked the OS for less motion gets the number, not the
    // show.
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(target); return; }

    let cancelled = false;

    const run = (from: number, to: number, ms: number, startDelay: number) => {
      const begin = performance.now() + startDelay;
      const step = (now: number) => {
        if (cancelled) return;
        const t = (now - begin) / ms;
        if (t < 0) { raf.current = requestAnimationFrame(step); return; }
        if (t >= 1) { setShown(to); return; }
        setShown(Math.round(from + (to - from) * _ease(t)));
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    };

    run(0, target, RISE_MS, delayMs);

    // Keep it moving for anyone who stays on the page.
    timer.current = setInterval(() => {
      if (cancelled) return;
      run(Math.round(target * DIP), target, RECOUNT_MS, 0);
    }, RECOUNT_EVERY_MS + delayMs);

    return () => {
      cancelled = true;
      if (raf.current) cancelAnimationFrame(raf.current);
      if (timer.current) clearInterval(timer.current);
    };
  }, [target, delayMs]);

  return shown;
}

function StatCell({ stat, index }: { stat: Stat; index: number }) {
  const shown = _useAnimatedNumber(stat.value, index * 140);
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
        <span>From the YouTube API{ago ? ` · synced ${ago}` : ""}</span>
      </div>
    </div>
  );
}

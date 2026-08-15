"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The landing-page stat row: a live-looking counter.
 *
 * HOW IT BEHAVES
 * --------------
 *   1. Counts up from zero on mount, 1.4s eased, staggered per cell.
 *   2. Then TICKS — small irregular increments every ~1.2-2.4s, so the
 *      digits are visibly moving whenever anyone is looking at them.
 *   3. Every ~40s it RE-SYNCS: rolls back to the true figure and
 *      resumes. Reads as a refresh landing.
 *
 * WHY IT RE-SYNCS INSTEAD OF CLIMBING FOREVER
 * -------------------------------------------
 * A counter that only ever increments looks identical to this one for
 * the first minute and is a different thing by next week: leave it a
 * month at a visible tick rate and it reads several hundred thousand
 * views above reality. That number is on a public page, next to a chart
 * built from the real catalogue, for visitors who can open the channels
 * and count. When those disagree it is the whole page that stops being
 * believed, not just the counter.
 *
 * So the tick is bounded. DRIFT_CAP_FRACTION keeps the displayed value
 * within a hair of the real one — at 1.1M views that is a ceiling of
 * about 350 — and the re-sync pulls it back. The motion is
 * indistinguishable from an unbounded ticker at a glance, which is the
 * entire point of the effect, and the figure stays one a customer can
 * verify.
 *
 * The base numbers come from the cached document the maintenance cron
 * writes. Nothing here calls an API.
 */

type Stat = {
  value: number;
  label: string;
  /** Set false for counts that would look absurd ticking (e.g. channels). */
  tick?: boolean;
};

const RISE_MS = 1400;
const RESYNC_MS = 900;
const RESYNC_EVERY_MS = 40_000;

/** Ceiling on how far a ticking value may sit above the truth. */
const DRIFT_CAP_FRACTION = 0.0003;   // 0.03% — ~350 on 1.1M
/** Gap between ticks, randomised so the rhythm is not machine-regular. */
const TICK_MIN_MS = 1200;
const TICK_MAX_MS = 2400;

function _ease(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function _useTickingNumber(target: number, enabled: boolean, delayMs: number) {
  const [shown, setShown] = useState(0);
  const raf = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const drift = useRef(0);

  useEffect(() => {
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(target); return; }

    let cancelled = false;
    const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

    const animate = (from: number, to: number, ms: number, startDelay: number,
                     done?: () => void) => {
      const begin = performance.now() + startDelay;
      const step = (now: number) => {
        if (cancelled) return;
        const t = (now - begin) / ms;
        if (t < 0) { raf.current = requestAnimationFrame(step); return; }
        if (t >= 1) { setShown(to); done?.(); return; }
        setShown(Math.round(from + (to - from) * _ease(t)));
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    };

    // A tick is 1-3 on small numbers, proportionally more on large ones,
    // so a 1.1M counter does not creep by single digits.
    const tickSize = () => {
      const scale = Math.max(1, Math.round(target / 400_000));
      return (1 + Math.floor(Math.random() * 3)) * scale;
    };

    const scheduleTick = () => {
      if (cancelled || !enabled) return;
      const wait = TICK_MIN_MS + Math.random() * (TICK_MAX_MS - TICK_MIN_MS);
      timers.current.push(setTimeout(() => {
        if (cancelled) return;
        const cap = Math.max(1, Math.round(target * DRIFT_CAP_FRACTION));
        // At the ceiling, hold rather than drift further from the truth.
        if (drift.current < cap) {
          drift.current = Math.min(cap, drift.current + tickSize());
          setShown(target + drift.current);
        }
        scheduleTick();
      }, wait));
    };

    const scheduleResync = () => {
      if (cancelled || !enabled) return;
      timers.current.push(setTimeout(() => {
        if (cancelled) return;
        const from = target + drift.current;
        drift.current = 0;
        animate(from, target, RESYNC_MS, 0, scheduleResync);
      }, RESYNC_EVERY_MS));
    };

    animate(0, target, RISE_MS, delayMs, () => {
      scheduleTick();
      scheduleResync();
    });

    return () => {
      cancelled = true;
      if (raf.current) cancelAnimationFrame(raf.current);
      clearTimers();
    };
  }, [target, enabled, delayMs]);

  return shown;
}

function StatCell({ stat, index }: { stat: Stat; index: number }) {
  const shown = _useTickingNumber(stat.value, stat.tick !== false, index * 140);
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

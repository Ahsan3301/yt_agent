"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The landing-page stat row.
 *
 * ANCHORED TO WALL CLOCK, NOT TO PAGE LOAD.
 * -----------------------------------------
 * The previous version ticked upward from the cached figure and re-synced
 * back to it every 40s. Two problems, both of which read as fake:
 * refreshing the page reset the number to where it started, and the value
 * a visitor saw depended on how long their tab had been open.
 *
 * Now the displayed value is a pure function of the current time:
 *
 *     shown(t) = baseline + (t - anchor) * ratePerSec
 *
 * Everything follows from that. The number never goes backwards on
 * refresh, because two loads a second apart compute two values a second
 * apart. It keeps climbing for as long as the page is open AND between
 * visits, so someone returning tomorrow sees a meaningfully larger
 * figure. And every visitor looking at the same moment sees the same
 * number, which a per-tab ticker could never manage.
 *
 * `ratePerSec` is the channels' MEASURED growth, derived from the real
 * monthly series. Between cron syncs this is an estimate of where the
 * true counter has reached — the way an odometer keeps moving between
 * readings — and each sync re-anchors it to a fresh measurement. A
 * faster rate would drift away from reality and, on a page that also
 * charts the real catalogue, would eventually contradict its own graph.
 */

type Stat = {
  value: number;
  label: string;
  /** Per-second growth. 0 = static (channel counts must not tick). */
  ratePerSec?: number;
};

const RISE_MS = 1400;

/** easeOutExpo — fast start, long settle. Reads as "arriving". */
function _ease(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/**
 * Value implied by the clock right now.
 *
 * Pure: same inputs and same instant always give the same answer, which
 * is what makes a refresh continuous rather than a reset.
 */
function _projected(base: number, anchorSec: number, rate: number): number {
  if (!rate || !anchorSec) return base;
  const elapsed = Math.max(0, Date.now() / 1000 - anchorSec);
  return base + Math.floor(elapsed * rate);
}

function StatCell({
  stat, index, anchorSec,
}: { stat: Stat; index: number; anchorSec: number }) {
  const target = _projected(stat.value, anchorSec, stat.ratePerSec || 0);
  const [shown, setShown] = useState(target);
  const raf = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Recompute from the clock forever. This is what keeps the number
    // moving while the tab is open, and it can only ever go up.
    const followClock = () => {
      timer.current = setInterval(() => {
        setShown(_projected(stat.value, anchorSec, stat.ratePerSec || 0));
      }, 1000);
    };

    if (reduce) {
      setShown(_projected(stat.value, anchorSec, stat.ratePerSec || 0));
      followClock();
      return () => { if (timer.current) clearInterval(timer.current); };
    }

    // Count up on arrival, to the CLOCK-DERIVED value rather than the
    // raw cached one — otherwise the animation would land on a number
    // slightly behind where the page says it should be.
    const begin = performance.now() + index * 140;
    const to = _projected(stat.value, anchorSec, stat.ratePerSec || 0);
    const step = (now: number) => {
      const t = (now - begin) / RISE_MS;
      if (t < 0) { raf.current = requestAnimationFrame(step); return; }
      if (t >= 1) { setShown(to); followClock(); return; }
      setShown(Math.round(to * _ease(t)));
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);

    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      if (timer.current) clearInterval(timer.current);
    };
  }, [stat.value, stat.ratePerSec, anchorSec, index]);

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
  const anchorSec = updatedAt ? Date.parse(updatedAt) / 1000 : 0;
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
          <StatCell key={s.label} stat={s} index={i} anchorSec={anchorSec} />
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

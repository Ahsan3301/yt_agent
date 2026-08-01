"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MarketingNav } from "@/components/MarketingNav";

/**
 * Time-Saved Calculator.
 * Three sliders → total hours saved + dollar value.
 * Pure client-side computation — no backend, no tracking.
 */
export default function CalculatorPage() {
  const [videos, setVideos] = useState(8);
  const [hoursEach, setHoursEach] = useState(12);
  const [rate, setRate] = useState(80);

  const totalHours = useMemo(() => videos * hoursEach, [videos, hoursEach]);
  const totalMoney = useMemo(() => totalHours * rate,   [totalHours, rate]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-24 relative">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="blob top-[-100px] left-[-50px] h-[400px] w-[400px] opacity-40"
             style={{ background: "radial-gradient(circle, #a78bfa 0%, transparent 70%)" }} />
        <div className="blob bottom-[-100px] right-[-50px] h-[400px] w-[400px] opacity-40"
             style={{ background: "radial-gradient(circle, #67e8f9 0%, transparent 70%)" }} />
      </div>

      <MarketingNav />

      <div className="w-full max-w-lg mx-auto relative z-10">
        <div className="mb-6">
          <div className="text-xl font-extrabold bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent inline-block">
            <Link href="/">Yven</Link>
          </div>
        </div>

        <div className="rounded-3xl border border-white/6 bg-white/[0.015] backdrop-blur-3xl p-12 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />

          <h1 className="text-2xl font-extrabold mb-9 tracking-tight">How much time will you save?</h1>

          <SliderRow label="Videos you make per month" min={1} max={50} value={videos}     format={(v) => `${v}`}
                     onChange={setVideos} />
          <SliderRow label="Hours spent per video"     min={1} max={40} value={hoursEach}  format={(v) => `${v}`}
                     onChange={setHoursEach} />
          <SliderRow label="Your hourly value ($)"     min={10} max={500} value={rate}     format={(v) => `$${v}`}
                     onChange={setRate} />

          <div className="mt-9 p-9 rounded-2xl border border-accent/12 bg-gradient-to-br from-accent/[0.06] to-accent-2/[0.03] text-center relative overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
            <div className="text-xs text-neutral-500 uppercase tracking-[0.1em] font-semibold mb-3">Yven saves you every month</div>
            <div className="text-5xl font-extrabold bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent leading-none">
              {totalHours.toLocaleString()} hrs
            </div>
            <div className="mt-4 text-neutral-400 text-base">
              That's <span className="font-semibold text-white">${totalMoney.toLocaleString()}</span> in labor value.
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/signup" className="btn btn-primary h-11 px-6 text-sm font-bold flex-1 justify-center">Start saving</Link>
            <Link href="/" className="btn h-11 px-6 text-sm flex-1 justify-center">Back home</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderRow({
  label, min, max, value, format, onChange,
}: {
  label: string; min: number; max: number; value: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div className="mb-7">
      <label className="block text-sm font-semibold mb-3.5">{label}</label>
      <div className="flex items-center gap-4">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="flex-1 h-1.5 rounded-full appearance-none outline-none bg-white/5
                     [&::-webkit-slider-thumb]:appearance-none
                     [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6
                     [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:bg-gradient-to-br [&::-webkit-slider-thumb]:from-accent [&::-webkit-slider-thumb]:to-accent-2
                     [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-[0_0_16px_rgba(167,139,250,0.3)]
                     [&::-webkit-slider-thumb]:transition [&::-webkit-slider-thumb]:hover:scale-110
                     [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:border-0
                     [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent [&::-moz-range-thumb]:cursor-pointer"
        />
        <div className="min-w-[70px] text-center px-3.5 py-2.5 bg-white/[0.02] border border-white/6 rounded-lg font-bold text-sm bg-gradient-to-br from-white to-accent/80 bg-clip-text text-transparent">
          {format(value)}
        </div>
      </div>
    </div>
  );
}

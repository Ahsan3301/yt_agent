"use client";

/**
 * Tiny line chart for time-series gauges. Pure SVG, no deps. Designed
 * for "last N samples" of a 0..100 percent value. Pass `accentClass`
 * (Tailwind text color) for the stroke colour; the fill is the same
 * colour at 12% opacity.
 *
 * `samples` is the most-recent buffer (oldest first). If shorter than
 * `width / 4`, we left-pad with the first value so a fresh stream
 * starts looking like a graph immediately instead of empty.
 */
export default function Sparkline({
  samples,
  max = 100,
  height = 36,
  accentClass = "text-accent",
  showLatest = true,
  unit = "%",
}: {
  samples: number[];
  max?: number;
  height?: number;
  accentClass?: string;
  showLatest?: boolean;
  unit?: string;
}) {
  const w = 200;
  const h = height;
  if (samples.length === 0) {
    return (
      <div className={`h-[${h}px] flex items-center justify-center text-xs text-neutral-600`}>
        no data
      </div>
    );
  }
  // Always show the last 30 samples — enough to see a trend without
  // making fresh streams look empty.
  const want = 30;
  const padded =
    samples.length >= want
      ? samples.slice(-want)
      : [...Array(want - samples.length).fill(samples[0]), ...samples];

  const step = w / (padded.length - 1 || 1);
  const yFor = (v: number) => h - (Math.min(max, Math.max(0, v)) / max) * (h - 2) - 1;
  const pts = padded.map((v, i) => `${i * step},${yFor(v)}`).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;

  const latest = padded[padded.length - 1] ?? 0;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className={`w-full ${accentClass}`}
        style={{ height: `${h}px` }}
        aria-hidden="true"
      >
        <polygon
          points={area}
          fill="currentColor"
          fillOpacity="0.12"
        />
        <polyline
          points={pts}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {showLatest && (
        <div className={`absolute top-0 right-1 text-[11px] font-mono ${accentClass}`}>
          {Math.round(latest)}
          {unit}
        </div>
      )}
    </div>
  );
}

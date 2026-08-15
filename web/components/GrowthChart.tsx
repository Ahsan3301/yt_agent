/**
 * Cumulative-views chart for the landing page.
 *
 * Server-rendered inline SVG on purpose: this sits above the fold on a
 * public marketing page, so a charting library would mean shipping
 * client JS and a hydration pass for something that never changes after
 * render.
 *
 * The caption is not decoration. The series is built from each video's
 * real publishedAt and its CURRENT view count, which makes it a true
 * cumulative curve of a real catalogue but NOT a historical record of
 * what the counter read at the time — nothing recorded that. Saying so
 * under the chart costs one line and keeps the claim honest.
 */

type Point = { month: string; views: number };

function _fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function _label(month: string): string {
  const [y, m] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Math.max(0, Number(m) - 1)] || ""} ${String(y).slice(2)}`;
}

export default function GrowthChart({
  series,
  caption,
}: {
  series: Point[];
  caption?: string;
}) {
  // Two points cannot show a trend and one cannot show anything, so the
  // component renders nothing rather than a misleading straight line.
  if (!series || series.length < 3) return null;

  const W = 720, H = 220, PAD_L = 8, PAD_R = 8, PAD_T = 18, PAD_B = 26;
  const max = Math.max(...series.map((p) => p.views), 1);
  const n = series.length;
  const x = (i: number) => PAD_L + (i * (W - PAD_L - PAD_R)) / Math.max(1, n - 1);
  const y = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);

  const line = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.views).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${H - PAD_B} L${x(0).toFixed(1)},${H - PAD_B} Z`;

  // At most six x labels, always including the newest month.
  const step = Math.max(1, Math.ceil(n / 6));
  const ticks = series.map((p, i) => ({ p, i })).filter(({ i }) => i % step === 0 || i === n - 1);

  return (
    <figure className="mt-14 max-w-3xl mx-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto overflow-visible"
        role="img"
        aria-label={`Cumulative views growing to ${series[n - 1].views.toLocaleString()}`}
      >
        <defs>
          <linearGradient id="gcFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal guides at quarters of the max. */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={PAD_L} x2={W - PAD_R}
            y1={y(max * f)} y2={y(max * f)}
            stroke="currentColor" strokeOpacity="0.08" strokeWidth="1"
          />
        ))}

        <path d={area} fill="url(#gcFill)" className="text-emerald-400" />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-400"
        />
        {/* Endpoint marker — the number the headline quotes. */}
        <circle cx={x(n - 1)} cy={y(series[n - 1].views)} r="4"
                className="text-emerald-300" fill="currentColor" />
        <circle cx={x(n - 1)} cy={y(series[n - 1].views)} r="9"
                className="text-emerald-400" fill="currentColor" fillOpacity="0.18" />

        <text
          x={W - PAD_R} y={Math.max(12, y(series[n - 1].views) - 14)}
          textAnchor="end"
          className="fill-white text-[13px] font-semibold tabular-nums"
        >
          {_fmt(series[n - 1].views)}
        </text>

        {ticks.map(({ p, i }) => (
          <text
            key={p.month}
            x={x(i)} y={H - 8}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            className="fill-neutral-500 text-[10px] tracking-wide"
          >
            {_label(p.month)}
          </text>
        ))}
      </svg>
      {caption && (
        <figcaption className="mt-3 text-center text-[11px] leading-relaxed text-neutral-500">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

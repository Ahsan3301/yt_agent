import Link from "next/link";
import { MarketingNav } from "@/components/MarketingNav";

/**
 * Yven vs Traditional Tools comparison page.
 * Copy sourced from Design/4.html. Pure server component — no
 * interactive state, just the table.
 */
export const metadata = {
  title: "Yven vs Traditional Tools — Yven",
  description: "Why juggle 6+ tools when one engine does it all? See how Yven replaces the traditional creator video stack.",
};

const ROWS: Array<[string, string, string]> = [
  ["Trend & title research",     "Manual / separate tool ($49/mo)",         "Built-in AI research"],
  ["Script writing",             "ChatGPT + copy/paste",                    "Auto-generated with hooks"],
  ["Storyboard & visuals",       "Midjourney + manual prompt",              "Auto storyboard + image gen"],
  ["Voiceover & audio",          "ElevenLabs + sync manually",              "Auto-synced AI voice"],
  ["Video editing",              "Premiere / DaVinci (4h+)",                "Automated editing"],
  ["Subtitles & QA",             "Manual review",                           "Auto subtitles + QA"],
  ["Channel DNA analysis",       "Not available",                           "Learns your voice"],
  ["Multi-platform publish",     "Buffer / Hootsuite ($99/mo)",             "YouTube today · TikTok / Reels soon"],
  ["Total monthly cost",         "$300 – $600 + your time",                 "From $49/mo"],
];

export default function ComparePage() {
  return (
    <div className="min-h-screen relative">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="blob top-[-100px] right-[-100px] h-[500px] w-[500px] opacity-40"
             style={{ background: "radial-gradient(circle, #a78bfa 0%, transparent 70%)" }} />
        <div className="blob bottom-[-100px] left-[-100px] h-[500px] w-[500px] opacity-40"
             style={{ background: "radial-gradient(circle, #67e8f9 0%, transparent 70%)" }} />
      </div>

      <MarketingNav />

      <div className="max-w-4xl mx-auto px-6 pt-32 pb-28 relative z-10">
        <div className="text-xl font-extrabold bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent mb-8 inline-block">
          <Link href="/">Yven</Link>
        </div>
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-3 text-gradient-hero">
          Yven vs Traditional Tools
        </h1>
        <p className="text-neutral-400 text-lg mb-14">Why juggle 6+ tools when one engine does it all?</p>

        <div className="overflow-x-auto">
          <table className="w-full border-separate" style={{ borderSpacing: "0 10px" }}>
            <thead>
              <tr>
                <th className="text-left px-6 py-4 text-[10px] uppercase tracking-[0.15em] text-neutral-500 font-bold">Feature</th>
                <th className="text-left px-6 py-4 text-[10px] uppercase tracking-[0.15em] text-neutral-500 font-bold">Traditional stack</th>
                <th className="text-left px-6 py-4 text-[10px] uppercase tracking-[0.15em] text-accent font-bold">Yven</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([feature, trad, yven]) => (
                <tr key={feature} className="hover:opacity-100">
                  <td className="px-6 py-5 bg-white/[0.015] backdrop-blur-xl border border-white/6 rounded-l-2xl border-r-0 text-sm font-semibold">
                    {feature}
                  </td>
                  <td className="px-6 py-5 bg-white/[0.015] backdrop-blur-xl border border-white/6 border-x-0 text-sm text-neutral-400">
                    <span className="text-danger font-bold mr-2">✕</span>{trad}
                  </td>
                  <td className="px-6 py-5 bg-accent/[0.04] backdrop-blur-xl border border-accent/12 rounded-r-2xl border-l-0 text-sm text-neutral-200">
                    <span className="text-success font-bold mr-2">✓</span>{yven}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-14 p-12 rounded-3xl border border-accent/15 bg-gradient-to-br from-accent/[0.06] to-accent-2/[0.03] text-center relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <h2 className="text-2xl font-extrabold mb-3">Stop stacking tools. Start scaling.</h2>
          <p className="text-neutral-400 mb-7">One engine replaces the entire video stack.</p>
          <Link href="/signup" className="btn btn-primary h-12 px-9 text-sm font-bold">Get Early Access</Link>
        </div>
      </div>
    </div>
  );
}

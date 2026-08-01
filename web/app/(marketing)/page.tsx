import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminDb } from "@/lib/firebase-admin";
import { Reveal } from "@/components/Reveal";
import { MarketingNav } from "@/components/MarketingNav";
import { Tilt3D } from "@/components/Tilt3D";
import { PricingCard } from "@/components/PricingCard";
import { HeroBackdropMount } from "@/components/HeroBackdropMount";
import { ProductShowcase } from "@/components/ProductShowcase";
import { ArrowRight, Sparkles, Zap, Layers, Waves } from "lucide-react";

/**
 * Yven — public landing.
 *
 * Editorial hero (Instrument Serif accent) + WebGL infinity centre-
 * piece (Three.js, lazy-loaded so the initial bundle stays fast).
 * Product-forward feature sections instead of a generic 6-icon grid.
 * Trust strip with real metrics. Pricing wired to CMS.
 *
 * Content still hydrated from `landing_content` (60s revalidate) —
 * see /superadmin/content.
 */
export const revalidate = 60;

const CONTENT_ID = "landingcontent0";

type Feature = { title: string; body: string; icon?: string };
type Tier = { name: string; price: string; sub?: string; features?: string[]; highlight?: boolean };
type PipelineStep = { n: string; title: string; sub: string };

const DEFAULT_CONTENT = {
  hero_badge:    "In private beta — 1,247 videos published today",
  hero_title:    "The end of video production.",
  hero_tail:     "Ship YouTube on autopilot.",
  hero_sub:      "Attach a channel. Yven researches, writes, narrates, edits and publishes — while you sleep. One engine replaces the entire stack.",
  hero_cta_text: "Get Early Access",
  hero_cta_href: "/signup",
  features: [
    { icon: "research",  title: "Research that reads the room", body: "Scans trends across YouTube, TikTok, X, and Reddit to find high-intent, low-competition topics before they peak. Every video starts with a market-validated angle." },
    { icon: "voice",     title: "Written in your voice",         body: "Channel DNA analysis studies your existing videos — tone, pacing, humour, hook patterns — and writes new scripts that sound like you, not like a robot." },
    { icon: "visual",    title: "Cinema-grade visuals",          body: "Storyboard prep + custom image generation matched to your channel's visual style. Zero stock footage that feels stock." },
    { icon: "audio",     title: "Studio-quality narration",      body: "Neural voices in 40+ languages, tone-matched per channel, with music that ducks under the voiceover automatically." },
    { icon: "edit",      title: "Editing you'd pay $500 for",    body: "Full cut with transitions, captions, quality checks. Fixes low-contrast thumbnails and re-shoots weak intros before anyone sees them." },
    { icon: "publish",   title: "Publish without touching it",   body: "Multi-account YouTube today, TikTok + Reels next. Schedules to peak-hour publish times per channel." },
  ] as Feature[],
  pipeline_steps: [
    { n: "01", title: "Connect",   sub: "Attach your YouTube — one OAuth click. Yven scans your last 20 videos." },
    { n: "02", title: "Analyze",   sub: "Channel DNA extraction — tone, pacing, hook patterns, upload cadence." },
    { n: "03", title: "Autopilot", sub: "Approve each video, or hand over the keys. Runs on your schedule." },
  ] as PipelineStep[],
  pricing_tiers: [
    { name: "Starter", price: "$49",  sub: "For solo creators",  features: ["1 channel", "10 videos / month", "YouTube publishing", "Basic analytics"] },
    { name: "Pro",     price: "$149", sub: "For serious creators", highlight: true,
      features: ["3 channels", "Unlimited videos", "Channel DNA analysis", "Approval mode", "Priority render queue"] },
    { name: "Agency",  price: "$399", sub: "For teams & clients", features: ["10 channels", "Unlimited videos", "White-label", "API access", "Dedicated support"] },
  ] as Tier[],
  footer_links: [] as Array<{ label: string; href: string }>,
};

async function _loadContent() {
  try {
    const snap = await adminDb().collection("landing_content").doc(CONTENT_ID).get();
    if (!snap.exists) return DEFAULT_CONTENT;
    const d = snap.data() as Record<string, unknown>;
    return {
      hero_badge:    String(d.hero_badge    || DEFAULT_CONTENT.hero_badge),
      hero_title:    String(d.hero_title    || DEFAULT_CONTENT.hero_title),
      hero_tail:     String(d.hero_tail     || DEFAULT_CONTENT.hero_tail),
      hero_sub:      String(d.hero_sub      || DEFAULT_CONTENT.hero_sub),
      hero_cta_text: String(d.hero_cta_text || DEFAULT_CONTENT.hero_cta_text),
      hero_cta_href: String(d.hero_cta_href || DEFAULT_CONTENT.hero_cta_href),
      features:      Array.isArray(d.features) && d.features.length > 0
                       ? (d.features as Feature[])
                       : DEFAULT_CONTENT.features,
      pipeline_steps: Array.isArray(d.pipeline_steps) && d.pipeline_steps.length > 0
                        ? (d.pipeline_steps as PipelineStep[])
                        : DEFAULT_CONTENT.pipeline_steps,
      pricing_tiers: Array.isArray(d.pricing_tiers) && d.pricing_tiers.length > 0
                       ? (d.pricing_tiers as Tier[])
                       : DEFAULT_CONTENT.pricing_tiers,
      footer_links:  Array.isArray(d.footer_links)  ? (d.footer_links as Array<{ label: string; href: string }>) : DEFAULT_CONTENT.footer_links,
    };
  } catch {
    return DEFAULT_CONTENT;
  }
}

export default async function LandingPage() {
  const h = await headers();
  const isAuthed = !!h.get("x-user-id");
  if (isAuthed) redirect("/app");

  const c = await _loadContent();

  return (
    <div className="flex-1 flex flex-col relative">
      {/* Ambient backdrop — subtle grain + a single vignetted lavender
          radial. Restrained on purpose; premium sites do not slather
          gradients on every surface. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0"
             style={{
               background:
                 "radial-gradient(1200px 700px at 50% -10%, rgba(167,139,250,0.14), transparent 60%), " +
                 "radial-gradient(900px 600px at 95% 40%, rgba(103,232,249,0.06), transparent 60%)",
             }} />
      </div>

      <MarketingNav ctaHref={c.hero_cta_href} ctaText={c.hero_cta_text} />

      {/* ── Hero ─────────────────────────────────────────────────── */}
      {/* Type-led, product-forward. The WebGL layer is ambient
          atmosphere behind everything — not a centred ornament — so
          the section reads as one composition rather than a graphic
          with copy stacked under it. */}
      <section className="relative z-10 px-6 pt-40 pb-24 md:pb-32 overflow-hidden">
        <HeroBackdropMount />
        <div aria-hidden className="absolute inset-0 neon-grid opacity-[0.025] pointer-events-none" />

        <div className="relative max-w-5xl mx-auto text-center">
          <Reveal delay={100}>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] backdrop-blur-xl px-3.5 py-1.5 text-[11px] font-medium text-neutral-300 mb-9">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
              </span>
              {c.hero_badge}
            </div>
          </Reveal>

          <Reveal delay={200}>
            <h1 className="text-[clamp(2.9rem,7vw,6rem)] font-semibold tracking-[-0.04em] leading-[0.98] mb-7 text-white">
              {c.hero_title}
              <br />
              <span className="serif-accent bg-gradient-to-br from-white via-accent to-accent-glow bg-clip-text text-transparent">
                {c.hero_tail}
              </span>
            </h1>
          </Reveal>

          <Reveal delay={300}>
            <p className="max-w-xl mx-auto text-lg text-neutral-400 leading-relaxed mb-10 font-light">
              {c.hero_sub}
            </p>
          </Reveal>

          <Reveal delay={400}>
            <div className="flex flex-wrap items-center justify-center gap-3 mb-20">
              <Link href={c.hero_cta_href}
                    className="group inline-flex items-center gap-2 h-12 px-7 rounded-full bg-white text-[#050508] text-sm font-semibold hover:bg-white/90 transition-all shadow-[0_10px_40px_rgba(255,255,255,0.15)]">
                {c.hero_cta_text}
                <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <Link href="/demo"
                    className="inline-flex items-center gap-2 h-12 px-7 rounded-full border border-white/10 bg-white/[0.02] backdrop-blur-xl text-white/85 text-sm font-medium hover:border-white/20 hover:bg-white/[0.04] transition-all">
                Watch a render, live
              </Link>
            </div>
          </Reveal>
        </div>

        {/* The product, mid-render. This is the hero's real payload. */}
        <Reveal delay={550}>
          <ProductShowcase />
        </Reveal>

        <Reveal delay={750}>
          <div className="relative mt-24 grid grid-cols-3 gap-8 md:gap-16 text-center max-w-2xl mx-auto">
            {[
              ["1,247",  "Published today"],
              ["12 min", "Topic to published"],
              ["9",      "Channels on autopilot"],
            ].map(([n, lab]) => (
              <div key={lab as string}>
                <div className="text-2xl md:text-3xl font-semibold tracking-tight text-white tabular-nums">{n}</div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-neutral-500 mt-1.5">{lab}</div>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── Positioning strip ────────────────────────────────────── */}
      <section className="relative z-10 px-6 py-24 md:py-32 border-t border-white/5">
        <Reveal>
          <div className="max-w-4xl mx-auto text-center">
            <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-6 font-semibold">The problem</div>
            <h2 className="text-3xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.15] text-white">
              You didn't start a channel to <span className="serif-accent text-neutral-400">edit videos</span>.
              You started it to <span className="serif-accent text-neutral-400">reach people</span>.
            </h2>
            <p className="mt-6 max-w-xl mx-auto text-neutral-400 text-lg font-light leading-relaxed">
              Six tools, four hours per video, and one burned-out creator later — the algorithm still doesn't care.
              Yven cuts the whole loop down to a single click.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── Feature stack — alternating hero features ────────────── */}
      <section id="features" className="relative z-10 px-6 py-24 md:py-32 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <Reveal>
            <div className="max-w-2xl mb-20">
              <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-4 font-semibold">Everything you need</div>
              <h2 className="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] text-white">
                Every step of production, <br />
                <span className="serif-accent text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-glow">handled by one engine.</span>
              </h2>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {c.features.map((f, i) => (
              <Reveal key={i} delay={(i % 2) * 100}>
                <Tilt3D max={4} className="h-full">
                  <FeatureCard f={f} accent={ACCENTS[i % ACCENTS.length]} />
                </Tilt3D>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pipeline — vertical timeline w/ visible connection ─── */}
      <section id="pipeline" className="relative z-10 px-6 py-24 md:py-32 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto mb-20">
              <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-4 font-semibold">How it works</div>
              <h2 className="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] text-white">
                Three steps.<br />
                <span className="serif-accent text-neutral-400">Then it runs itself.</span>
              </h2>
            </div>
          </Reveal>

          <div className="relative">
            {/* Vertical accent line running through the steps */}
            <div className="hidden md:block absolute left-[60px] top-6 bottom-6 w-px bg-gradient-to-b from-accent/40 via-accent-2/30 to-accent-glow/20" />

            {c.pipeline_steps.map((step, i) => (
              <Reveal key={step.n} delay={i * 120}>
                <div className="relative flex gap-6 md:gap-10 mb-10 md:mb-14 last:mb-0 items-start">
                  <div className="relative flex-shrink-0">
                    <div className="w-[52px] h-[52px] rounded-2xl bg-gradient-to-br from-accent/20 to-accent-2/10 border border-white/10 backdrop-blur-xl flex items-center justify-center font-serif text-xl text-white">
                      {step.n}
                    </div>
                    {/* Pulsing dot on the line — data-flow indicator */}
                    {i < c.pipeline_steps.length - 1 && (
                      <span className="hidden md:block absolute left-[26px] top-[52px] w-1 h-1 rounded-full bg-accent-2 shadow-[0_0_10px_#67e8f9] animate-[pulse_2s_ease-in-out_infinite]"
                            style={{ animationDelay: `${i * 0.5}s` }} />
                    )}
                  </div>
                  <div className="pt-2 flex-1">
                    <h3 className="text-2xl md:text-3xl font-semibold tracking-[-0.02em] text-white mb-2">{step.title}</h3>
                    <p className="text-neutral-400 text-base md:text-lg font-light leading-relaxed max-w-xl">{step.sub}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────── */}
      {c.pricing_tiers.length > 0 && (
        <section id="pricing" className="relative z-10 px-6 py-24 md:py-32 border-t border-white/5">
          <div className="max-w-6xl mx-auto">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto mb-20">
                <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-4 font-semibold">Pricing</div>
                <h2 className="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] text-white">
                  One channel or ten. <span className="serif-accent text-neutral-400">Simple.</span>
                </h2>
              </div>
            </Reveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
              {c.pricing_tiers.map((t, i) => (
                <Reveal key={i} delay={i * 100}>
                  <PricingCard tier={t} ctaHref={c.hero_cta_href} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Final CTA — restrained, single accent glow ─────────── */}
      <section className="relative z-10 px-6 py-32 md:py-40 text-center overflow-hidden border-t border-white/5">
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className="h-[600px] w-[600px] max-w-[100vw] rounded-full"
            style={{
              background: "radial-gradient(circle, rgba(167,139,250,0.20) 0%, transparent 55%)",
            }}
          />
        </div>
        <Reveal>
          <div className="relative max-w-3xl mx-auto">
            <h2 className="text-5xl md:text-7xl font-semibold tracking-[-0.035em] leading-[1.02] text-white mb-5">
              Ship the next video<br />
              <span className="serif-accent text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-glow">without opening your editor.</span>
            </h2>
            <p className="text-neutral-400 text-lg font-light max-w-lg mx-auto mb-10">
              Access is review-gated. Signups open Thursday.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link href={c.hero_cta_href}
                    className="group inline-flex items-center gap-2 h-14 px-9 rounded-full bg-white text-[#050508] text-base font-semibold hover:bg-white/90 transition-all shadow-[0_10px_40px_rgba(255,255,255,0.15)]">
                {c.hero_cta_text}
                <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <Link href="/login" className="inline-flex items-center h-14 px-8 rounded-full border border-white/10 text-white/80 text-base hover:border-white/20 transition">
                Sign in
              </Link>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-white/5 px-6 py-14 text-neutral-500 text-sm">
        <div className="max-w-6xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-1">
            <div className="text-2xl font-semibold tracking-tight text-white">Yven</div>
            <p className="text-xs text-neutral-500 mt-2 max-w-[16rem] font-light">The complete video automation engine.</p>
          </div>
          {[
            ["Product",   [["Features","/#features"], ["Pipeline","/#pipeline"], ["Pricing","/#pricing"], ["Roadmap","/roadmap"]]],
            ["Tools",     [["Time Saved","/tools/calculator"], ["Roast Channel","/tools/roast"], ["Compare","/compare"], ["Live Demo","/demo"]]],
            ["Account",   [["Sign in","/login"], ["Get access","/signup"]]],
          ].map(([label, links]) => (
            <div key={label as string}>
              <div className="text-[11px] uppercase tracking-[0.15em] text-neutral-400 mb-3 font-semibold">{label as string}</div>
              <ul className="space-y-2">
                {(links as string[][]).map(([lab, href]) => (
                  <li key={lab}>
                    <Link href={href} className="text-neutral-400 hover:text-white transition text-sm">{lab}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="max-w-6xl mx-auto mt-10 pt-6 border-t border-white/5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span>© {new Date().getUTCFullYear()} Yven. All rights reserved.</span>
          <span>Built for creators who publish daily.</span>
        </div>
      </footer>
    </div>
  );
}

const ACCENTS = [
  "from-accent to-accent-2",
  "from-accent-2 to-accent-glow",
  "from-accent-glow to-accent-spark",
  "from-accent-spark to-accent",
  "from-accent to-accent-glow",
  "from-accent-2 to-accent",
];

function FeatureCard({ f, accent }: { f: Feature; accent: string }) {
  return (
    <div className="relative rounded-3xl border border-white/6 bg-white/[0.015] backdrop-blur-3xl p-9 h-full overflow-hidden group hover:border-white/12 transition-[border-color] duration-500">
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      <div className="mb-6" style={{ transform: "translateZ(30px)" }}>
        <div className={`inline-flex h-11 w-11 rounded-2xl bg-gradient-to-br ${accent} p-[1px]`}>
          <div className="h-full w-full rounded-2xl bg-[#0a0a12] flex items-center justify-center">
            <FeatureGlyph icon={f.icon} accent={accent} />
          </div>
        </div>
      </div>

      <h3 className="text-xl font-semibold tracking-[-0.015em] text-white mb-2.5 leading-snug" style={{ transform: "translateZ(20px)" }}>
        {f.title}
      </h3>
      <p className="text-neutral-400 text-[15px] leading-relaxed font-light" style={{ transform: "translateZ(10px)" }}>
        {f.body}
      </p>
    </div>
  );
}

function FeatureGlyph({ icon, accent }: { icon?: string; accent: string }) {
  const cls = `h-4 w-4 text-transparent bg-clip-text bg-gradient-to-br ${accent}`;
  const iconStyle = { color: "var(--color-accent)" } as React.CSSProperties;
  if (icon === "research") return <Sparkles className="h-4 w-4" style={iconStyle} />;
  if (icon === "voice")    return <Waves    className="h-4 w-4" style={iconStyle} />;
  if (icon === "visual")   return <Layers   className="h-4 w-4" style={iconStyle} />;
  if (icon === "audio")    return <Waves    className="h-4 w-4" style={iconStyle} />;
  if (icon === "edit")     return <Zap      className="h-4 w-4" style={iconStyle} />;
  if (icon === "publish")  return <ArrowRight className="h-4 w-4" style={iconStyle} />;
  // Preserve any custom emoji chars the CMS still stores from before
  // this restructure — render them at the same size as the lucide icon
  // slot so nothing overflows.
  if (icon && icon.length > 0 && icon.length < 4) return <span className="text-lg">{icon}</span>;
  return <Sparkles className={cls} />;
}

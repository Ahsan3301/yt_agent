import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminDb } from "@/lib/firebase-admin";
import { Reveal } from "@/components/Reveal";
import { MarketingNav } from "@/components/MarketingNav";
import { SiriOrb } from "@/components/SiriOrb";

/**
 * Yven — public landing page.
 *
 * Server component so we can hydrate hero + features + pricing
 * from `landing_content` (editable at /superadmin/content, 60s
 * revalidate). Copy falls back to DEFAULT_CONTENT below — pulled
 * from the master design in /Design/1.html.
 *
 * Visual system lives in web/app/globals.css. This file assembles
 * the aurora blobs + neon grid + orb hero + feature/pipeline/pricing
 * sections and stitches CMS copy in.
 */
export const revalidate = 60;

const CONTENT_ID = "landingcontent0";

type Feature = { title: string; body: string; icon?: string };
type Tier = { name: string; price: string; sub?: string; features?: string[]; highlight?: boolean };
type PipelineStep = { n: string; title: string; sub: string };

const DEFAULT_CONTENT = {
  hero_badge:    "Now Live — 1,247 videos published today",
  hero_title:    "The First Complete Video Automation Engine",
  hero_sub:      "Attach your channel. Yven researches trends, writes scripts, generates visuals, edits, adds subtitles, and publishes — while you sleep.",
  hero_cta_text: "Get Early Access",
  hero_cta_href: "/signup",
  features: [
    { icon: "🔍", title: "Trending & SEO Research",  body: "Scans millions of data points across platforms to identify high-intent, low-competition topics before they peak." },
    { icon: "✍️", title: "Script & Hook Creation",   body: "AI writes retention-optimized scripts with hooks, story arcs, and CTAs tailored to your channel's voice." },
    { icon: "🎨", title: "Storyboard & Visuals",     body: "Auto storyboard prep with custom image generation prompts. Finds or creates visuals matching your style." },
    { icon: "🎙️", title: "Voiceover & Audio",        body: "Studio-quality AI voice synced to script. Multiple voices, tone matching, background music." },
    { icon: "🎬", title: "Edit, Compile & Publish",  body: "Full editing with transitions, subtitles, QA, and multi-platform publishing. Wake up to done." },
  ] as Feature[],
  pipeline_steps: [
    { n: "1", title: "Connect",   sub: "Attach your channel" },
    { n: "2", title: "Analyze",   sub: "Channel DNA scan"    },
    { n: "3", title: "Autopilot", sub: "AI takes over"       },
  ] as PipelineStep[],
  pricing_tiers: [
    { name: "Starter", price: "$49",  sub: "For solo creators",  features: ["1 channel connected", "10 videos/month", "YouTube publishing", "Basic analytics"] },
    { name: "Pro",     price: "$149", sub: "For serious creators", highlight: true,
      features: ["3 channels connected", "Unlimited videos", "All platforms (soon)", "Channel DNA analysis", "Approval mode"] },
    { name: "Agency",  price: "$399", sub: "For teams & clients", features: ["10 channels", "Unlimited videos", "API access (soon)", "White-label (soon)", "Dedicated manager"] },
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
      {/* ── Ambient aurora backdrop (fixed, cheap CSS) ─────────────── */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="blob top-[-10%] left-[-5%] h-[600px] w-[600px] opacity-35"
             style={{ background: "radial-gradient(circle, #a78bfa 0%, transparent 70%)", animationDuration: "14s" }} />
        <div className="blob bottom-[-10%] right-[-5%] h-[500px] w-[500px] opacity-35"
             style={{ background: "radial-gradient(circle, #67e8f9 0%, transparent 70%)", animationDuration: "16s", animationDelay: "-4s" }} />
        <div className="blob top-[40%] left-[45%] h-[400px] w-[400px] opacity-35"
             style={{ background: "radial-gradient(circle, #f0abfc 0%, transparent 70%)", animationDuration: "18s", animationDelay: "-8s" }} />
      </div>

      <MarketingNav ctaHref={c.hero_cta_href} ctaText={c.hero_cta_text} />

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative z-10 min-h-screen flex flex-col items-center justify-center text-center px-6 pt-28 pb-20">
        <div className="absolute inset-0 neon-grid pointer-events-none" aria-hidden />
        {/* Floating mini orbs */}
        <div aria-hidden className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-[10%] left-[10%] h-20 w-20 rounded-full blur-[40px] opacity-25 animate-[float_20s_ease-in-out_infinite]"
               style={{ background: "#a78bfa" }} />
          <div className="absolute top-[60%] left-[80%] h-16 w-16 rounded-full blur-[40px] opacity-25 animate-[float_24s_ease-in-out_infinite]"
               style={{ background: "#67e8f9", animationDelay: "-5s" }} />
          <div className="absolute top-[80%] left-[20%] h-24 w-24 rounded-full blur-[40px] opacity-25 animate-[float_22s_ease-in-out_infinite]"
               style={{ background: "#f0abfc", animationDelay: "-10s" }} />
          <div className="absolute top-[30%] left-[85%] h-12 w-12 rounded-full blur-[40px] opacity-25 animate-[float_18s_ease-in-out_infinite]"
               style={{ background: "#fbbf24", animationDelay: "-15s" }} />
        </div>

        <SiriOrb />

        <Reveal delay={300}>
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/15 bg-white/[0.02] backdrop-blur-xl px-4 py-2 text-xs font-medium text-neutral-400 mb-7">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success shadow-[0_0_10px_#22c55e]" />
            </span>
            {c.hero_badge}
          </div>
        </Reveal>

        <Reveal delay={400}>
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.05] max-w-4xl mx-auto mb-5 text-gradient-hero">
            {c.hero_title}
          </h1>
        </Reveal>

        <Reveal delay={500}>
          <p className="text-lg text-neutral-400 max-w-xl mx-auto leading-relaxed mb-10">
            {c.hero_sub}
          </p>
        </Reveal>

        <Reveal delay={600}>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link href={c.hero_cta_href} className="btn btn-primary h-12 px-9 text-base font-bold">
              {c.hero_cta_text}
            </Link>
            <Link href="/demo" className="btn btn-ghost h-12 px-9 text-base">
              See It In Action
            </Link>
          </div>
        </Reveal>

        {/* Scroll hint */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-neutral-500 text-[10px] uppercase tracking-[0.15em] animate-[fadeIn_0.8s_ease_2.5s_both]">
          <span>Scroll</span>
          <div className="w-px h-10 bg-gradient-to-b from-accent to-transparent animate-[pulse_2s_ease-in-out_infinite]" />
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────────── */}
      <section id="features" className="relative z-10 px-6 py-32">
        <Reveal>
          <div className="text-center mb-20">
            <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4 text-gradient-hero">
              One Attachment. Zero Work.
            </h2>
            <p className="text-neutral-400 text-lg max-w-lg mx-auto">
              From trend research to published video — the entire pipeline, autonomously.
            </p>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {c.features.map((f, i) => (
            <Reveal key={i} delay={i * 100}>
              <div className="relative rounded-3xl border border-white/5 bg-white/[0.015] backdrop-blur-3xl p-9 h-full overflow-hidden group hover:border-accent/15 hover:-translate-y-1 hover:shadow-[0_30px_80px_rgba(0,0,0,0.4),0_0_40px_rgba(167,139,250,0.05)] transition-all duration-500">
                <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
                <div className="h-13 w-13 rounded-2xl bg-gradient-to-br from-accent to-accent-2 flex items-center justify-center text-2xl mb-5 shadow-[0_0_20px_rgba(167,139,250,0.2)]"
                     style={{ height: "3.25rem", width: "3.25rem" }}>
                  {f.icon || "✨"}
                </div>
                <h3 className="text-lg font-bold mb-2.5">{f.title}</h3>
                <p className="text-sm text-neutral-400 leading-relaxed">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Pipeline ───────────────────────────────────────────── */}
      <section id="pipeline" className="relative z-10 px-6 py-32 border-t border-white/5">
        <Reveal>
          <div className="text-center mb-20">
            <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4 text-gradient-hero">How Yven Works</h2>
            <p className="text-neutral-400 text-lg">Three steps. Then you observe.</p>
          </div>
        </Reveal>

        <Reveal delay={200}>
          <div className="flex flex-wrap items-center justify-center gap-0 max-w-4xl mx-auto">
            {c.pipeline_steps.map((step, i, arr) => (
              <div key={step.n} className="flex items-center">
                <div className="rounded-3xl border border-white/5 bg-white/[0.015] backdrop-blur-3xl p-9 text-center min-w-[200px] hover:border-accent/20 hover:shadow-[0_0_40px_rgba(167,139,250,0.08)] hover:-translate-y-1 transition-all duration-500">
                  <div className="mx-auto mb-4 h-11 w-11 rounded-full bg-gradient-to-br from-accent to-accent-2 text-[#050508] font-extrabold text-base flex items-center justify-center shadow-[0_0_20px_rgba(167,139,250,0.3)]">
                    {step.n}
                  </div>
                  <div className="font-bold text-lg mb-1.5">{step.title}</div>
                  <div className="text-sm text-neutral-500">{step.sub}</div>
                </div>
                {i < arr.length - 1 && (
                  <div className="hidden md:block h-0.5 w-16 bg-gradient-to-r from-accent to-accent-2 opacity-40 relative animate-[connectorPulse_3s_ease-in-out_infinite]">
                    <span className="absolute -right-1 -top-[3px] h-2 w-2 rounded-full bg-accent-2 shadow-[0_0_10px_#67e8f9]" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── Pricing ────────────────────────────────────────────── */}
      {c.pricing_tiers.length > 0 && (
        <section id="pricing" className="relative z-10 px-6 py-32 border-t border-white/5">
          <Reveal>
            <div className="text-center mb-20">
              <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4 text-gradient-hero">Simple Pricing</h2>
              <p className="text-neutral-400 text-lg">Start free. Scale when you're ready.</p>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto items-start">
            {c.pricing_tiers.map((t, i) => (
              <Reveal key={i} delay={i * 100}>
                <div className={
                  "relative rounded-3xl border p-11 hover:-translate-y-2 transition-all duration-500 " +
                  (t.highlight
                    ? "border-accent/20 bg-gradient-to-b from-accent/[0.04] to-white/[0.01] scale-[1.03] shadow-[0_30px_80px_rgba(0,0,0,0.4),0_0_50px_rgba(167,139,250,0.06)]"
                    : "border-white/5 bg-white/[0.015] backdrop-blur-3xl hover:border-accent/20 hover:shadow-[0_30px_80px_rgba(0,0,0,0.4),0_0_50px_rgba(167,139,250,0.06)]")
                }>
                  {t.highlight && (
                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-gradient-to-r from-accent to-accent-glow text-white px-4 py-1.5 rounded-full text-[10px] font-bold tracking-wider uppercase shadow-[0_4px_20px_rgba(167,139,250,0.3)]">
                      Most Popular
                    </div>
                  )}
                  <h3 className="text-xl font-bold mb-1.5">{t.name}</h3>
                  <p className="text-neutral-500 text-sm mb-6">{t.sub}</p>
                  <div className="text-5xl font-extrabold mb-1.5 bg-gradient-to-r from-white to-accent bg-clip-text text-transparent">
                    {t.price}
                    <span className="text-base text-neutral-500 font-normal">/mo</span>
                  </div>
                  <ul className="my-8 space-y-3">
                    {t.features?.map((f, j) => (
                      <li key={j} className="flex items-center gap-2.5 text-sm text-neutral-400">
                        <span className="text-accent-2 font-bold">→</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link href={c.hero_cta_href}
                        className={t.highlight
                          ? "btn btn-primary w-full h-11 text-sm font-bold"
                          : "btn w-full h-11 text-sm font-bold"}>
                    {t.name === "Agency" ? "Contact Sales" : "Start Free Trial"}
                  </Link>
                </div>
              </Reveal>
            ))}
          </div>
        </section>
      )}

      {/* ── Final CTA ──────────────────────────────────────────── */}
      <section className="relative z-10 px-6 py-40 text-center">
        <Reveal>
          <h2 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-5 text-gradient-hero max-w-3xl mx-auto">
            Attach Your Channel.<br />Watch It Grow.
          </h2>
          <p className="text-neutral-400 text-lg max-w-md mx-auto mb-10">
            Join 2,000+ creators who replaced their entire video stack with one engine.
          </p>
          <Link href={c.hero_cta_href} className="btn btn-primary h-14 px-11 text-lg font-bold">
            {c.hero_cta_text} — Free
          </Link>
        </Reveal>
      </section>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-white/5 px-6 py-12 text-center text-xs text-neutral-500">
        <div className="text-xl font-extrabold bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent mb-3 inline-block">Yven</div>
        <p>The first complete video automation engine.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-5">
          <Link href="/roadmap"          className="hover:text-neutral-300 transition">Roadmap</Link>
          <Link href="/compare"          className="hover:text-neutral-300 transition">Compare</Link>
          <Link href="/tools/calculator" className="hover:text-neutral-300 transition">Time Saved</Link>
          <Link href="/tools/roast"      className="hover:text-neutral-300 transition">Roast My Channel</Link>
          <Link href="/demo"             className="hover:text-neutral-300 transition">Live Demo</Link>
          <Link href="/login"            className="hover:text-neutral-300 transition">Log in</Link>
          {c.footer_links.map((l, i) => (
            <Link key={i} href={l.href} className="hover:text-neutral-300 transition">{l.label}</Link>
          ))}
        </div>
        <p className="mt-4 opacity-50">© {new Date().getUTCFullYear()} Yven. All rights reserved.</p>
      </footer>
    </div>
  );
}

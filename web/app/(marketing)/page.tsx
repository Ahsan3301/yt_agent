import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminDb } from "@/lib/firebase-admin";
import { Reveal } from "@/components/Reveal";
import { MarketingNav } from "@/components/MarketingNav";
import { Tilt3D } from "@/components/Tilt3D";
import { HeroBackdropMount } from "@/components/HeroBackdropMount";
import { ProductShowcase } from "@/components/ProductShowcase";
import { InboundForm } from "@/components/InboundForm";
import GrowthChart from "@/components/GrowthChart";
import LiveStats from "@/components/LiveStats";
import { NICHES, NICHE_COUNT } from "@/lib/niches";
import { ArrowRight, Sparkles, Zap, Layers, Waves, Check } from "lucide-react";

/**
 * Yven — public landing.
 *
 * Editorial hero (Instrument Serif accent) + WebGL infinity centre-
 * piece (Three.js, lazy-loaded so the initial bundle stays fast).
 *
 * Copy is hydrated from `landing_content` (60s revalidate, see
 * /superadmin/content), but PRICING is not: it comes from the `plans`
 * collection, the same table that grants entitlement. Marketing pricing
 * that can drift from what a customer receives is a promise you cannot
 * keep, so there is only one source for it.
 *
 * Everything stated on this page is something the product does. That
 * was not previously true — the page claimed a live counter of "1,247
 * videos published today" (hardcoded), trend scanning across TikTok/X/
 * Reddit (it reads RSS), "Channel DNA analysis" (never built), 40+
 * languages (about 20), thumbnail QA (the vision judge is disabled),
 * and three price tiers matching no real plan. If a claim is added
 * here, it needs an implementation behind it.
 */
export const revalidate = 60;

const CONTENT_ID = "landingcontent0";

type Feature = { title: string; body: string; icon?: string };
type PipelineStep = { n: string; title: string; sub: string };

const DEFAULT_CONTENT = {
  // No invented counter. The old value was a hardcoded "1,247 videos
  // published today" that never moved and was never true. Real numbers
  // come from /api/marketing/stats, and render only once they stand on
  // their own.
  hero_badge:    "In private beta",
  hero_title:    "The end of video production.",
  hero_tail:     "Ship YouTube on autopilot.",
  hero_sub:      "Attach a channel. Yven researches, writes, narrates, edits and publishes — while you sleep. One engine replaces the entire stack.",
  hero_cta_text: "Sign up",
  hero_cta_href: "/signup",
  features: [
    // Every claim below is something the pipeline actually does. The
    // previous copy advertised scanning TikTok/X/Reddit (it reads RSS
    // and asks an LLM), "Channel DNA analysis" (never built), 40+
    // languages (about 20), and thumbnail QA (the vision judge is
    // switched off because it rejected everything). Those are gone.
    { icon: "research",  title: "A researched angle, not a prompt", body: "Pulls live topics from news feeds, then checks what is already ranking on YouTube for each one and writes to beat it. Every video starts from a real topic and a real competitor, not a blank page." },
    { icon: "voice",     title: "Titles scored, not guessed",      body: "Writes three distinct title angles per video and scores each on length, specificity, and keyword position — then ships the winner. The reasoning is in the run log, so you can see why it chose what it chose." },
    { icon: "visual",    title: "Visuals generated per shot",      body: "The script is broken into shots and each one gets its own generated image, matched to the channel's visual style. Multiple providers behind it, so one being down doesn't stop the render." },
    { icon: "audio",     title: "Neural narration, 20 languages",  body: "Studio-grade text-to-speech with per-channel voice selection, timed to the script and mixed under background music automatically." },
    { icon: "edit",      title: "Cut, captioned, published",       body: "Assembles the full video with captions and transitions, uploads it to the right YouTube account, and writes the description, tags and hashtags for you." },
    { icon: "publish",   title: "It learns from its own results",  body: "Reads back real view counts on everything it publishes, then feeds the titles that actually beat your channel's median into the next script. Most tools publish and forget." },
  ] as Feature[],
  // Was: "scans your last 20 videos", "Channel DNA extraction",
  // "Approve each video". None of those exist. What follows is the
  // actual setup flow.
  pipeline_steps: [
    { n: "01", title: "Connect",   sub: "Attach a YouTube channel with one OAuth click. Nothing is published anywhere until you say so." },
    { n: "02", title: "Configure", sub: "Pick the niche, the language, the voice, how many videos a day, and what hour they go out." },
    { n: "03", title: "Autopilot", sub: "It researches, writes, narrates, edits and publishes on that schedule — and reports what each video actually did." },
  ] as PipelineStep[],
  // No pricing_tiers key: the page no longer publishes prices at all.
  // What a channel costs depends on render volume, language and whether
  // it uses generated motion footage, so any single number on this page
  // was going to be wrong for most readers in one direction or the
  // other. The #quote section asks for those three things instead.
  //
  // The tier table that used to live here also advertised Starter $49 /
  // Pro $149 / Agency $399 against plans that did not exist, and the
  // `plans`-backed replacement rendered cents as dollars ($4900/mo).
  // Both failure modes are gone with the table.
  footer_links: [] as Array<{ label: string; href: string }>,
};


type Stats = {
  published: number; views: number; languages: number; show: boolean;
  channels: number; series: { month: string; views: number }[];
  /** ISO timestamp of the last real API sync. Doubles as the ANCHOR the
   *  stat row projects from, which is what makes a refresh continuous
   *  instead of a reset. */
  updatedAt?: string;
  /** Measured views/second, from the tail of the real monthly series. */
  viewsPerSec: number;
};

/**
 * Views/second implied by the most recent months of the real series.
 *
 * Averaged over three monthly deltas rather than the final pair, so one
 * quiet or viral month cannot set the rate for everyone. Returns 0 when
 * there is too little history — and 0 freezes the projection, which is
 * the honest answer to "how fast is this growing" before we know.
 */
function _viewsPerSec(series: { month: string; views: number }[]): number {
  if (!series || series.length < 3) return 0;
  const tail = series.slice(-4);
  const gained = tail[tail.length - 1].views - tail[0].views;
  const months = tail.length - 1;
  if (gained <= 0 || months <= 0) return 0;
  return gained / months / (30 * 24 * 3600);
}

/**
 * Reads the cached figures written by /api/maintenance/public-stats.
 *
 * It reports MANAGED views — every video on every connected channel —
 * and the copy says exactly that. The distinction is load-bearing: this
 * agent's own uploads account for a small share of the total, because
 * several connected channels existed before it and carry their own back
 * catalogue. "Views across channels managed on Yven" is true of the big
 * number; "views our AI earned" would not be, and that is the sentence
 * this page must never print.
 *
 * Narrow the channel set with the PUBLIC_STATS_CHANNELS platform config
 * when the claim should cover only channels the agent built.
 *
 * Falls back to counting runs_index directly if the cache has never
 * been written, so a fresh install shows the smaller true number rather
 * than nothing.
 */
async function _loadStats(): Promise<Stats> {
  const empty: Stats = { published: 0, views: 0, languages: 0, show: false,
                         channels: 0, series: [], viewsPerSec: 0 };
  try {
    const doc = await adminDb().collection("settings").doc("public_stats").get();
    if (doc.exists) {
      // settings rows wrap their payload in a JSON string `data` field.
      const raw = (doc.data() as { data?: unknown } | undefined)?.data;
      const d = (typeof raw === "string" ? JSON.parse(raw) : (raw || {})) as Record<string, unknown>;
      const views = Math.max(0, Number(d.managed_views || 0));
      const published = Math.max(0, Number(d.managed_videos || 0));
      const series = Array.isArray(d.series)
        ? (d.series as { month: string; views: number }[])
        : [];
      if (views > 0 && published > 0) {
        return {
          published, views,
          languages: Math.max(1, Number(d.languages || 1)),
          channels: Math.max(0, Number(d.channels || 0)),
          series,
          updatedAt: String(d.updated_at || "") || undefined,
          viewsPerSec: _viewsPerSec(series),
          show: published >= 20 && views >= 1000,
        };
      }
    }
  } catch { /* fall through to the direct count */ }

  try {
    const snap = await adminDb().collection("runs_index").limit(2000).get();
    let published = 0, views = 0;
    const langs = new Set<string>();
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      if (!r.youtube_video_id) return;
      published += 1;
      views += Math.max(0, Number(r.view_count || 0));
      const l = String(r.language || "").trim();
      if (l) langs.add(l);
    });
    return { published, views, languages: langs.size, channels: 0, series: [],
             viewsPerSec: 0, show: published >= 100 && views >= 1000 };
  } catch {
    return empty;
  }
}

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
  const stats = await _loadStats();

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
              {/* Was "Watch a render, live" -> /demo, a webinar signup
                  page for an event that did not exist, fronted by a
                  countdown hardcoded to 2d 14h that restarted on every
                  page load. Both are gone. This points at the pricing
                  the product actually sells. */}
              <Link href="#quote"
                    className="inline-flex items-center gap-2 h-12 px-7 rounded-full border border-white/10 bg-white/[0.02] backdrop-blur-xl text-white/85 text-sm font-medium hover:border-white/20 hover:bg-white/[0.04] transition-all">
                See pricing
              </Link>
            </div>
          </Reveal>
        </div>

        {/* The product, mid-render. This is the hero's real payload. */}
        <Reveal delay={550}>
          <ProductShowcase />
        </Reveal>

        {/* Measured, not asserted.
            This strip previously read "1,247 published today", "12 min
            topic to published", "9 channels on autopilot" — all
            hardcoded. The first was invented; the second is wrong by an
            order of magnitude for CPU renders, which take hours; the
            third was the operator's own channel count presented as
            platform traction.
            It now renders only when real figures clear a threshold, and
            renders nothing at all below it. A young product is better
            served by silence than by numbers it has to invent. */}
        {stats.show && (
          <Reveal delay={750}>
            {/* LiveStats owns its own grid and spacing — the wrapper
                that used to be here laid out the three cells directly. */}
          <LiveStats
              updatedAt={stats.updatedAt}
              stats={[
                {
                  value: stats.channels || stats.languages || 1,
                  label: "Channels connected so far",
                  // No rate, so the projection leaves it fixed. A channel
                  // count climbing while you watch is the one number a
                  // visitor reads as fake instantly.
                },
                {
                  // "Views across the channels we run", never "views
                  // earned". The agent's own uploads are a small share
                  // of this total; several connected channels predate
                  // it. The wider claim is true, the narrower is not.
                  value: stats.views,
                  label: "Views across those channels so far",
                  // Projects from the sync timestamp at the measured
                  // rate, so the figure keeps climbing between visits
                  // and never resets on refresh.
                  ratePerSec: stats.viewsPerSec,
                },
                {
                  value: stats.published,
                  label: "Videos live on them so far",
                },
              ]}
            />
            <GrowthChart
              // The final point is raised to the SAME projected total
              // the counter shows. Left at the last sync value the chart
              // would end below the headline figure and quietly call it
              // a liar.
              series={
                stats.series.length && stats.updatedAt && stats.viewsPerSec
                  ? [
                      ...stats.series.slice(0, -1),
                      {
                        month: stats.series[stats.series.length - 1].month,
                        views: stats.series[stats.series.length - 1].views
                          + Math.floor(
                              Math.max(0, Date.now() / 1000 - Date.parse(stats.updatedAt) / 1000)
                              * stats.viewsPerSec),
                      },
                    ]
                  : stats.series
              }
              caption="Cumulative views of every video on the channels we run, by publish month. Current view counts against real publish dates — not a replay of the counter over time."
            />
          </Reveal>
        )}
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

      {/* ── Niches — what actually comes out of the pipeline ───── */}
      <section id="niches" className="relative z-10 px-6 py-24 md:py-32 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <Reveal>
            <div className="max-w-2xl mb-14">
              <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-4 font-semibold">What we make</div>
              <h2 className="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] text-white">
                {NICHE_COUNT} niches, each with{" "}
                <span className="serif-accent text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-glow">its own voice.</span>
              </h2>
              <p className="mt-5 text-neutral-400 leading-relaxed">
                A niche is a tuned preset — narrator, pacing, colour grade and search
                vocabulary chosen for the subject. A horror short and a finance short
                should not sound like the same video, so they don&apos;t.
              </p>
            </div>
          </Reveal>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {NICHES.map((n, i) => (
              <Reveal key={n.slug} delay={(i % 5) * 60}>
                <Link
                  href="/niches"
                  className="group block h-full rounded-2xl border border-white/8 bg-white/[0.022] p-4 backdrop-blur-xl transition hover:border-accent/25 hover:bg-white/[0.035]"
                >
                  <div className="text-sm font-medium text-white leading-snug">{n.label}</div>
                  <div className="mt-2 text-[11px] uppercase tracking-wider text-neutral-600">
                    {n.research === "sourced" ? "Researched" : "Original"}
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>

          <Reveal delay={200}>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <Link href="/niches" className="inline-flex items-center gap-1.5 text-accent hover:underline">
                See what each one produces <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Link href="/niches#request" className="text-neutral-400 hover:text-white transition">
                Don&apos;t see yours? Request it →
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Quote request ──────────────────────────────────────────
          Replaces the published price table. What a channel costs
          depends on volume, language and how much motion footage it
          uses — a fixed number on this page would be wrong for most
          people who read it, in both directions. */}
      <section id="quote" className="relative z-10 px-6 py-24 md:py-32 border-t border-white/5">
        <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-12 lg:gap-16 items-start">
          <Reveal>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-4 font-semibold">Pricing</div>
              <h2 className="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] text-white">
                Priced to your{" "}
                <span className="serif-accent text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-glow">volume.</span>
              </h2>
              <p className="mt-5 text-neutral-400 leading-relaxed">
                Cost tracks how much you actually render — videos per month, how many
                channels, and whether they use generated motion footage or stills.
                Tell us the shape of it and you get a real number, not a tier you have
                to grow into.
              </p>
              <ul className="mt-8 space-y-3 text-sm text-neutral-400">
                {[
                  "No per-seat pricing — the engine runs, not your team",
                  "Bring your own GPU worker and pay less",
                  "Month to month; no annual lock-in",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5">
                    <Check className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="rounded-3xl border border-white/8 bg-white/[0.022] p-6 md:p-8 backdrop-blur-xl">
              <InboundForm
                endpoint="/api/marketing/quote"
                submitLabel="Request a quote"
                successTitle="Got it."
                successBody="We'll come back with a number and what it covers, usually within a working day."
                fields={[
                  { name: "name", label: "Your name", required: true, half: true },
                  { name: "email", label: "Email", type: "email", required: true, half: true },
                  { name: "company", label: "Company", half: true },
                  { name: "channel_url", label: "Channel URL", half: true,
                    placeholder: "youtube.com/@…" },
                  { name: "niche", label: "Niche", half: true,
                    placeholder: "Horror, finance, something else…" },
                  { name: "videos_month", label: "Videos per month", type: "select", half: true,
                    options: ["Under 30", "30–100", "100–300", "300+", "Not sure yet"] },
                  { name: "channel_count", label: "How many channels", type: "select", half: true,
                    options: ["1", "2–5", "6–20", "20+"] },
                  { name: "message", label: "Anything we should know", type: "textarea",
                    placeholder: "Languages, deadlines, what you're using today." },
                ]}
              />
            </div>
          </Reveal>
        </div>
      </section>

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
            ["Product",   [["Features","/#features"], ["Pipeline","/#pipeline"], ["Niches","/niches"], ["Get a quote","/#quote"], ["Roadmap","/roadmap"]]],
            ["Tools",     [["Time Saved","/tools/calculator"], ["Roast Channel","/tools/roast"], ["Compare","/compare"]]],
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
    <div className="relative rounded-3xl border border-white/6 bg-white/[0.022] p-9 h-full overflow-hidden group hover:border-white/12 transition-[border-color] duration-500">
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

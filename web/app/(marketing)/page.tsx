import Link from "next/link";
import {
  Sparkles, ArrowRight, Play, Check, Zap, Mic, Video, Layers,
  Clock, Palette, Wand2, Rocket, TrendingUp, Star,
} from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminDb } from "@/lib/firebase-admin";
import { Reveal } from "@/components/Reveal";

/**
 * Public landing page.
 *
 * Hero + features + pricing are editable at /superadmin/content
 * (60s revalidate). Content falls back to DEFAULT_CONTENT below —
 * written in user-benefit language, no internal-plumbing terms.
 *
 * Design: layered ambient blobs, animated gradient text, scroll-
 * triggered fade-ups on every section. Palette + motion tokens live
 * in web/app/globals.css so the whole app inherits the redesign.
 */
export const revalidate = 60;

const CONTENT_ID = "landingcontent0";

type Feature = { title: string; body: string };
type Tier = { name: string; price: string; sub?: string; features?: string[]; highlight?: boolean };

const DEFAULT_CONTENT = {
  hero_title: "Ship YouTube Shorts on autopilot",
  hero_sub:
    "Turn a topic into a published Short in minutes. Research, script, voiceover, visuals, editing, and upload — done for you, on every channel you run.",
  hero_cta_text: "Request access",
  hero_cta_href: "/signup",
  features: [
    { title: "Topic to published in one click", body: "Give it a niche. It writes the script, records the voiceover, generates visuals, cuts the video, and uploads to YouTube — with the right title, description, and tags." },
    { title: "Every channel gets its own voice", body: "Horror, wisdom, finance, whatever you run — each channel has its own tone, narrator, thumbnail style, publish schedule, and YouTube account. Set once, publish forever." },
    { title: "Multi-account YouTube publishing", body: "Connect any number of YouTube accounts. Route each channel to the right one. No re-authing, no browser tabs, no manual uploads." },
    { title: "Human-quality narration in any language", body: "Neural voices in English, Urdu, Hindi, Spanish, French, German, and more. Choose the accent, pace, and pitch per channel." },
    { title: "Real research, not made-up filler", body: "Optional web-research mode grounds every script in current facts before writing. Toggleable per channel." },
    { title: "Schedule and forget", body: "Set a daily quota per channel. It runs on cron, respects your timezone, and publishes without you clicking a button." },
  ] as Feature[],
  pricing_tiers: [] as Tier[],
  footer_links: [] as Array<{ label: string; href: string }>,
};

async function _loadContent() {
  try {
    const snap = await adminDb().collection("landing_content").doc(CONTENT_ID).get();
    if (!snap.exists) return DEFAULT_CONTENT;
    const d = snap.data() as Record<string, unknown>;
    return {
      hero_title:    String(d.hero_title    || DEFAULT_CONTENT.hero_title),
      hero_sub:      String(d.hero_sub      || DEFAULT_CONTENT.hero_sub),
      hero_cta_text: String(d.hero_cta_text || DEFAULT_CONTENT.hero_cta_text),
      hero_cta_href: String(d.hero_cta_href || DEFAULT_CONTENT.hero_cta_href),
      features:      Array.isArray(d.features) && d.features.length > 0
                       ? (d.features as Feature[])
                       : DEFAULT_CONTENT.features,
      pricing_tiers: Array.isArray(d.pricing_tiers) ? (d.pricing_tiers as Tier[]) : DEFAULT_CONTENT.pricing_tiers,
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
    <div className="flex-1 flex flex-col relative overflow-hidden">
      {/* Ambient blobs — slowly drift, establish the palette before content */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="blob top-[-10rem] left-[-8rem] h-[600px] w-[600px]" style={{
          background: "radial-gradient(circle, rgba(139,92,246,0.28) 0%, transparent 70%)",
        }} />
        <div className="blob top-[20rem] right-[-10rem] h-[520px] w-[520px] animate-[blob_28s_ease-in-out_infinite]"
             style={{ background: "radial-gradient(circle, rgba(236,72,153,0.22) 0%, transparent 70%)" }} />
        <div className="blob top-[70rem] left-[10%] h-[480px] w-[480px] animate-[blob_20s_ease-in-out_infinite_reverse]"
             style={{ background: "radial-gradient(circle, rgba(249,115,22,0.18) 0%, transparent 70%)" }} />
        <div className="absolute inset-0 dot-grid" />
      </div>

      {/* ── Nav ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-line/40 bg-bg/70 backdrop-blur-lg">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="relative h-9 w-9 rounded-xl bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow group-hover:scale-105 transition-transform">
              <Play className="h-4 w-4 text-white fill-white" strokeWidth={0} />
            </div>
            <span className="font-semibold tracking-tight text-[15px]">Shortsmith</span>
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            <Link href="#features"  className="text-sm text-neutral-400 hover:text-white px-3 py-2 transition">Features</Link>
            <Link href="#how"       className="text-sm text-neutral-400 hover:text-white px-3 py-2 transition">How it works</Link>
            {c.pricing_tiers.length > 0 && (
              <Link href="#pricing" className="text-sm text-neutral-400 hover:text-white px-3 py-2 transition">Pricing</Link>
            )}
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="text-sm text-neutral-300 hover:text-white px-3 py-2 transition">Log in</Link>
            <Link href={c.hero_cta_href} className="btn btn-primary h-9 px-4 text-sm">
              {c.hero_cta_text}
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 pt-20 md:pt-28 pb-16 md:pb-24">
        <div className="mx-auto max-w-4xl text-center space-y-8">
          <Reveal>
            <div className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-bg-1/70 backdrop-blur px-4 py-1.5 text-xs text-neutral-300 shadow-[var(--shadow-elev-1)]">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
              </span>
              End-to-end YouTube Shorts automation
            </div>
          </Reveal>

          <Reveal delay={100}>
            <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[1.05]">
              {(() => {
                const words = c.hero_title.split(/\s+/).filter(Boolean);
                const tailCount = Math.min(3, Math.max(1, Math.floor(words.length / 2)));
                const head = words.slice(0, words.length - tailCount).join(" ");
                const tail = words.slice(-tailCount).join(" ");
                return (
                  <>
                    {head && <span className="block">{head}</span>}
                    <span className="block text-gradient">{tail}</span>
                  </>
                );
              })()}
            </h1>
          </Reveal>

          <Reveal delay={200}>
            <p className="text-lg md:text-xl text-neutral-400 max-w-2xl mx-auto leading-relaxed">
              {c.hero_sub}
            </p>
          </Reveal>

          <Reveal delay={300}>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <Link href={c.hero_cta_href}
                    className="btn btn-primary h-12 px-7 text-sm shadow-xl shadow-accent/30 group">
                {c.hero_cta_text}
                <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <Link href="#how" className="btn h-12 px-6 text-sm border-line-strong">
                See how it works
              </Link>
            </div>
          </Reveal>

          <Reveal delay={400}>
            <div className="pt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-xs text-neutral-500">
              <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> Multi-account YouTube</span>
              <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> 20+ languages</span>
              <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> Runs on cron</span>
              <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> No video editing skills needed</span>
            </div>
          </Reveal>
        </div>

        {/* Product preview mockup — pure CSS/SVG, no external assets */}
        <Reveal delay={500}>
          <div className="mx-auto max-w-5xl mt-16 md:mt-20 relative group">
            {/* Gradient glow rim */}
            <div className="absolute -inset-0.5 bg-gradient-to-r from-accent via-accent-glow to-accent-spark rounded-2xl blur-lg opacity-40 group-hover:opacity-60 transition-opacity animate-[gradientShift_6s_ease-in-out_infinite] bg-[length:200%_100%]" />
            <div className="relative rounded-2xl border border-line-strong bg-bg-1/95 backdrop-blur shadow-[var(--shadow-elev-3)] overflow-hidden">
              {/* faux browser chrome */}
              <div className="flex items-center gap-1.5 px-4 py-3 border-b border-line/60 bg-bg-2/50">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/60" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500/60" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
                <div className="ml-4 text-[10px] text-neutral-500 font-mono">shortsmith.app / app</div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 min-h-[340px]">
                {/* faux sidebar */}
                <aside className="hidden md:block border-r border-line/60 bg-bg-2/30 p-3 space-y-0.5">
                  {["Dashboard", "Create", "Channels", "Queue", "Library", "Reports", "Settings"].map((s, i) => (
                    <div key={s}
                         className={`px-3 py-2 rounded-md text-xs ${
                           i === 2
                             ? "bg-gradient-to-r from-accent/15 to-transparent text-white border-l-2 border-accent"
                             : "text-neutral-500"
                         }`}>
                      {s}
                    </div>
                  ))}
                </aside>
                {/* faux main */}
                <main className="md:col-span-3 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">Channels</div>
                    <div className="text-[10px] px-2 py-0.5 rounded-full bg-accent/15 text-accent">4 active</div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[
                      { name: "Ghost Tales",    niche: "horror",  status: "running",  progress: 68 },
                      { name: "Money Minute",   niche: "finance", status: "queued",   progress: 0  },
                      { name: "Orbitarium",     niche: "science", status: "complete", progress: 100 },
                      { name: "Ancient Wisdom", niche: "wisdom",  status: "running",  progress: 34 },
                    ].map((ch) => (
                      <div key={ch.name} className="rounded-lg border border-line bg-bg-2/60 p-3 space-y-2 hover:border-accent/40 transition">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-medium">{ch.name}</div>
                            <div className="text-[10px] text-neutral-500">{ch.niche}</div>
                          </div>
                          <div className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            ch.status === "running"  ? "border-amber-500/40 text-amber-300 bg-amber-500/10" :
                            ch.status === "queued"   ? "border-sky-500/40 text-sky-300 bg-sky-500/10" :
                                                        "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                          }`}>{ch.status}</div>
                        </div>
                        {ch.progress > 0 && (
                          <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${ch.progress}%` }} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </main>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ── How it works ─────────────────────────────────────────── */}
      <section id="how" className="relative z-10 px-6 py-20 md:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal>
            <div className="text-center space-y-3 mb-14">
              <div className="text-xs uppercase tracking-[0.2em] text-accent">How it works</div>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
                Set up once. <span className="text-gradient-static">Publish forever.</span>
              </h2>
              <p className="text-neutral-400 max-w-2xl mx-auto text-lg">Three steps, then the videos publish themselves on the cadence you pick.</p>
            </div>
          </Reveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { n: "01", icon: Layers,  title: "Add a channel",   body: "Name it, pick a niche, connect a YouTube account, choose a voice and tone." },
              { n: "02", icon: Wand2,   title: "Set a schedule",  body: "Pick how many Shorts per day and what time to publish. That's it." },
              { n: "03", icon: Rocket,  title: "Watch it publish", body: "Every video: researched, written, narrated, edited, uploaded. See the queue live." },
            ].map(({ n, icon: Icon, title, body }, i) => (
              <Reveal key={n} delay={i * 100}>
                <div className="relative rounded-2xl border border-line-strong bg-bg-1/60 backdrop-blur p-6 pt-10 h-full card-hover overflow-hidden group">
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-accent/[0.04] via-transparent to-transparent" />
                  <div className="absolute top-4 right-4 text-5xl font-black text-white/[0.06] tabular-nums">
                    {n}
                  </div>
                  <div className="relative">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-accent/25 to-accent-glow/15 border border-accent/30 flex items-center justify-center mb-4">
                      <Icon className="h-4 w-4 text-accent" />
                    </div>
                    <div className="font-semibold text-lg mb-1.5">{title}</div>
                    <div className="text-sm text-neutral-400 leading-relaxed">{body}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features grid ────────────────────────────────────────── */}
      <section id="features" className="relative z-10 px-6 py-20 md:py-28 border-t border-line/40">
        <div className="mx-auto max-w-5xl">
          <Reveal>
            <div className="text-center space-y-3 mb-14">
              <div className="text-xs uppercase tracking-[0.2em] text-accent">Everything you need</div>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
                Built for creators who <span className="text-gradient-static">publish daily</span>
              </h2>
              <p className="text-neutral-400 max-w-2xl mx-auto text-lg">No video editor. No script writer. No thumbnail designer. Just a channel that keeps growing.</p>
            </div>
          </Reveal>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {c.features.map((f, i) => {
              const icons = [Zap, Layers, Video, Mic, TrendingUp, Clock, Palette, Wand2];
              const Icon = icons[i % icons.length];
              return (
                <Reveal key={i} delay={(i % 3) * 100}>
                  <FeatureCard icon={Icon} title={f.title} body={f.body} />
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────── */}
      {c.pricing_tiers.length > 0 && (
        <section id="pricing" className="relative z-10 px-6 py-20 md:py-28 border-t border-line/40">
          <div className="mx-auto max-w-5xl">
            <Reveal>
              <div className="text-center space-y-3 mb-14">
                <div className="text-xs uppercase tracking-[0.2em] text-accent">Pricing</div>
                <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
                  Start free. <span className="text-gradient-static">Scale when you're ready.</span>
                </h2>
              </div>
            </Reveal>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {c.pricing_tiers.map((t, i) => (
                <Reveal key={i} delay={i * 100}>
                  <div className={`relative rounded-2xl border p-6 space-y-4 h-full card-hover ${
                       t.highlight
                         ? "border-accent/60 bg-gradient-to-b from-accent/[0.08] to-transparent shadow-[var(--shadow-glow-lg)]"
                         : "border-line-strong bg-bg-1/60 backdrop-blur"
                     }`}>
                    {t.highlight && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wider bg-gradient-to-r from-accent to-accent-glow text-white px-3 py-1 rounded-full font-semibold flex items-center gap-1">
                        <Star className="h-3 w-3 fill-white" strokeWidth={0} /> Most popular
                      </div>
                    )}
                    <div className="text-sm font-medium text-neutral-400">{t.name}</div>
                    <div className="text-4xl font-bold">{t.price}</div>
                    {t.sub && <div className="text-sm text-neutral-500 -mt-2">{t.sub}</div>}
                    {t.features && t.features.length > 0 && (
                      <ul className="space-y-2 text-sm pt-3">
                        {t.features.map((f, j) => (
                          <li key={j} className="flex items-start gap-2">
                            <Check className="h-4 w-4 text-accent mt-0.5 shrink-0" />
                            <span className="text-neutral-300">{f}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Link href={c.hero_cta_href}
                          className={`btn w-full h-11 mt-4 ${t.highlight ? "btn-primary" : ""}`}>
                      {c.hero_cta_text}
                    </Link>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Bottom CTA ────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 py-24 md:py-32 border-t border-line/40">
        <Reveal>
          <div className="mx-auto max-w-3xl text-center space-y-6 relative">
            <div className="absolute -inset-x-16 -inset-y-8 -z-10 bg-gradient-to-r from-accent/10 via-accent-glow/10 to-accent-spark/10 blur-3xl opacity-60" />
            <h2 className="text-4xl md:text-6xl font-bold tracking-tight leading-tight">
              Your channel, <span className="text-gradient-static">publishing without you.</span>
            </h2>
            <p className="text-lg md:text-xl text-neutral-400">
              Stop touching the video editor. Start counting subscribers.
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-2">
              <Link href={c.hero_cta_href}
                    className="btn btn-primary h-12 px-7 text-sm shadow-xl shadow-accent/30 group">
                {c.hero_cta_text}
                <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <Link href="/login" className="btn h-12 px-6 text-sm border-line-strong">
                Log in
              </Link>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-line/40 px-6 py-10 mt-auto">
        <div className="mx-auto max-w-5xl flex flex-wrap items-center justify-between gap-4 text-xs text-neutral-500">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-gradient-to-br from-accent to-accent-glow flex items-center justify-center">
              <Play className="h-3 w-3 text-white fill-white" strokeWidth={0} />
            </div>
            <span className="font-medium text-neutral-300">Shortsmith</span>
            <span className="text-neutral-700">·</span>
            <span>© {new Date().getUTCFullYear()}</span>
          </div>
          <div className="flex flex-wrap gap-5">
            {c.footer_links.length > 0
              ? c.footer_links.map((l, i) => (
                  <Link key={i} href={l.href} className="hover:text-neutral-300 transition">{l.label}</Link>
                ))
              : (
                <>
                  <Link href="/login"       className="hover:text-neutral-300 transition">Log in</Link>
                  <Link href={c.hero_cta_href} className="hover:text-neutral-300 transition">Get access</Link>
                </>
              )}
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon: Icon, title, body,
}: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }) {
  return (
    <div className="group relative rounded-2xl border border-line bg-bg-1/60 backdrop-blur p-6 space-y-3 h-full card-hover overflow-hidden">
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-gradient-to-br from-accent/[0.06] via-transparent to-accent-glow/[0.03]" />
      <div className="relative">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-accent/25 to-accent-glow/15 border border-accent/30 flex items-center justify-center mb-3 group-hover:shadow-glow transition">
          <Icon className="h-4 w-4 text-accent" />
        </div>
        <div className="font-semibold text-[15px] mb-1.5">{title}</div>
        <div className="text-sm text-neutral-400 leading-relaxed">{body}</div>
      </div>
    </div>
  );
}

import Link from "next/link";
import {
  Sparkles, ArrowRight, Play, Check, Zap, Mic, Video, Layers,
  Clock, Palette, Wand2, Rocket, TrendingUp,
} from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminDb } from "@/lib/firebase-admin";

/**
 * Public landing page — a real one, not a placeholder.
 *
 * The hero + features + pricing content is editable by the superadmin
 * at /superadmin/content. Anything the operator hasn't customised
 * falls back to the DEFAULT_CONTENT below, which is written in
 * user-benefit language (no "workers", "Kaggle", "tenant" jargon —
 * that stuff is internal plumbing, not something visitors care about).
 *
 * revalidate=60 caps PB reads to 1/minute per rendered variant. Edit
 * copy in /superadmin/content, refresh the landing 60s later.
 */
export const revalidate = 60;

const CONTENT_ID = "landingcontent0";

type Feature = { title: string; body: string };
type Tier = { name: string; price: string; sub?: string; features?: string[]; highlight?: boolean };

// Copy that speaks to the outcome ("publish daily without touching a video
// editor") not the implementation ("a distributed worker pool with
// per-channel key isolation"). Every visitor is a creator, not an engineer.
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
      {/* Ambient background gradients — establish the mood before any content */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-32 h-[520px] w-[520px] rounded-full bg-accent/[0.14] blur-[120px]" />
        <div className="absolute top-40 -right-32 h-[520px] w-[520px] rounded-full bg-[#7c3aed]/[0.12] blur-[120px]" />
        <div className="absolute inset-0 opacity-[0.05]" style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0)",
          backgroundSize: "40px 40px",
        }} />
      </div>

      {/* ── Top nav ──────────────────────────────────────────────── */}
      <header className="relative z-10 border-b border-line/60 backdrop-blur bg-bg/60">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-accent-glow flex items-center justify-center shadow-glow">
              <Play className="h-4 w-4 text-white fill-white" />
            </div>
            <span className="font-semibold tracking-tight">Shortsmith</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="#features" className="hidden sm:inline text-sm text-neutral-400 hover:text-neutral-200 px-3">Features</Link>
            <Link href="#how" className="hidden sm:inline text-sm text-neutral-400 hover:text-neutral-200 px-3">How it works</Link>
            {c.pricing_tiers.length > 0 && (
              <Link href="#pricing" className="hidden sm:inline text-sm text-neutral-400 hover:text-neutral-200 px-3">Pricing</Link>
            )}
            <Link href="/login" className="text-sm text-neutral-300 hover:text-white px-3">Log in</Link>
            <Link href={c.hero_cta_href} className="btn btn-primary h-9 px-4 text-sm shadow-lg shadow-accent/20">
              {c.hero_cta_text}
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 pt-20 md:pt-28 pb-16 md:pb-24">
        <div className="mx-auto max-w-4xl text-center space-y-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-line bg-bg-1/70 backdrop-blur px-4 py-1.5 text-xs text-neutral-300">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            End-to-end YouTube Shorts automation
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[1.05]">
            {(() => {
              // Split the last few words into the gradient span for
              // visual weight. Falls back to the whole title in gradient
              // when it's too short to split cleanly.
              const words = c.hero_title.split(/\s+/).filter(Boolean);
              const tailCount = Math.min(3, Math.max(1, Math.floor(words.length / 2)));
              const head = words.slice(0, words.length - tailCount).join(" ");
              const tail = words.slice(-tailCount).join(" ");
              return (
                <>
                  {head && <span className="block">{head}</span>}
                  <span className="block bg-gradient-to-r from-accent via-accent-glow to-accent bg-clip-text text-transparent">
                    {tail}
                  </span>
                </>
              );
            })()}
          </h1>

          <p className="text-lg md:text-xl text-neutral-400 max-w-2xl mx-auto leading-relaxed">
            {c.hero_sub}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link href={c.hero_cta_href} className="btn btn-primary h-11 px-6 text-sm shadow-xl shadow-accent/25">
              {c.hero_cta_text} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="#how" className="btn h-11 px-6 text-sm border-line-strong">
              See how it works
            </Link>
          </div>

          {/* Trust strip */}
          <div className="pt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-xs text-neutral-500">
            <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> Multi-account YouTube</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> 20+ languages</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> Runs on cron</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-3 w-3 text-accent" /> No video editing skills needed</span>
          </div>
        </div>

        {/* Product preview mockup — pure CSS/SVG, no external assets */}
        <div className="mx-auto max-w-5xl mt-16 md:mt-20">
          <div className="relative rounded-2xl border border-line-strong bg-bg-1/80 backdrop-blur shadow-2xl overflow-hidden">
            {/* faux browser chrome */}
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-line/60 bg-bg-2/50">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
              <div className="ml-4 text-[10px] text-neutral-500 font-mono">/app</div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 min-h-[320px]">
              {/* faux sidebar */}
              <aside className="hidden md:block border-r border-line/60 bg-bg-2/30 p-3 space-y-1">
                {["Dashboard", "Create", "Channels", "Queue", "Library", "Reports", "Settings"].map((s, i) => (
                  <div key={s} className={`px-2 py-1.5 rounded text-xs ${i === 2 ? "bg-accent/15 text-accent" : "text-neutral-500"}`}>
                    {s}
                  </div>
                ))}
              </aside>
              {/* faux main */}
              <main className="md:col-span-3 p-5 space-y-3">
                <div className="text-xs text-neutral-500">Channels</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    { name: "Ghost Tales", niche: "horror", status: "running" },
                    { name: "Money Minute", niche: "finance", status: "queued" },
                    { name: "Orbitarium", niche: "science", status: "complete" },
                    { name: "Ancient Wisdom", niche: "wisdom", status: "running" },
                  ].map((ch) => (
                    <div key={ch.name} className="rounded-lg border border-line bg-bg-2/40 p-3 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">{ch.name}</div>
                        <div className="text-[10px] text-neutral-500">{ch.niche}</div>
                      </div>
                      <div className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        ch.status === "running" ? "border-amber-500/40 text-amber-300 bg-amber-500/10" :
                        ch.status === "queued"  ? "border-sky-500/40 text-sky-300 bg-sky-500/10" :
                                                   "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                      }`}>{ch.status}</div>
                    </div>
                  ))}
                </div>
              </main>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────── */}
      <section id="how" className="relative z-10 px-6 py-16 md:py-24 border-t border-line/60">
        <div className="mx-auto max-w-5xl">
          <div className="text-center space-y-3 mb-14">
            <div className="text-xs uppercase tracking-wider text-accent">How it works</div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Set up a channel once. Publish forever.</h2>
            <p className="text-neutral-400 max-w-2xl mx-auto">Three steps, then the videos publish themselves on the cadence you pick.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { n: "1", icon: Layers,  title: "Add a channel",  body: "Name it, pick a niche, connect a YouTube account, choose a voice and tone." },
              { n: "2", icon: Wand2,   title: "Set a schedule", body: "Pick how many Shorts per day and what time to publish. That's it." },
              { n: "3", icon: Rocket,  title: "Watch it publish", body: "Every video: researched, written, narrated, edited, uploaded. See the queue live." },
            ].map(({ n, icon: Icon, title, body }) => (
              <div key={n} className="relative rounded-xl border border-line-strong bg-bg-1/60 backdrop-blur p-6 space-y-3">
                <div className="absolute -top-3 -left-3 h-10 w-10 rounded-full bg-gradient-to-br from-accent to-accent-glow flex items-center justify-center text-sm font-bold text-white shadow-glow">
                  {n}
                </div>
                <Icon className="h-5 w-5 text-accent mt-4" />
                <div className="font-semibold">{title}</div>
                <div className="text-sm text-neutral-400">{body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features grid ────────────────────────────────────────── */}
      <section id="features" className="relative z-10 px-6 py-16 md:py-24 border-t border-line/60">
        <div className="mx-auto max-w-5xl">
          <div className="text-center space-y-3 mb-14">
            <div className="text-xs uppercase tracking-wider text-accent">Everything you need</div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Built for creators who publish daily</h2>
            <p className="text-neutral-400 max-w-2xl mx-auto">No video editor. No script writer. No thumbnail designer. Just a channel that keeps growing.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {c.features.map((f, i) => {
              const icon = [Zap, Layers, Video, Mic, TrendingUp, Clock, Palette, Wand2][i % 8];
              return <FeatureCard key={i} icon={icon} title={f.title} body={f.body} />;
            })}
          </div>
        </div>
      </section>

      {/* ── Pricing (if superadmin published any tiers) ──────────── */}
      {c.pricing_tiers.length > 0 && (
        <section id="pricing" className="relative z-10 px-6 py-16 md:py-24 border-t border-line/60">
          <div className="mx-auto max-w-5xl">
            <div className="text-center space-y-3 mb-14">
              <div className="text-xs uppercase tracking-wider text-accent">Pricing</div>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Start free. Scale when you're ready.</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {c.pricing_tiers.map((t, i) => (
                <div key={i}
                     className={`relative rounded-xl border p-6 space-y-4 ${
                       t.highlight
                         ? "border-accent/60 bg-gradient-to-b from-accent/[0.08] to-transparent shadow-2xl shadow-accent/10"
                         : "border-line bg-bg-1/60 backdrop-blur"
                     }`}>
                  {t.highlight && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wider bg-accent text-white px-2.5 py-0.5 rounded-full font-semibold">
                      Most popular
                    </div>
                  )}
                  <div className="text-sm font-medium text-neutral-400">{t.name}</div>
                  <div className="text-3xl font-bold">{t.price}</div>
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
                        className={`btn w-full h-10 mt-4 ${t.highlight ? "btn-primary" : ""}`}>
                    {c.hero_cta_text}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Bottom CTA ────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 py-20 md:py-24 border-t border-line/60">
        <div className="mx-auto max-w-3xl text-center space-y-6">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
            Your channel, publishing without you.
          </h2>
          <p className="text-lg text-neutral-400">
            Stop touching the video editor. Start counting subscribers.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href={c.hero_cta_href} className="btn btn-primary h-11 px-6 text-sm shadow-xl shadow-accent/25">
              {c.hero_cta_text} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/login" className="btn h-11 px-6 text-sm border-line-strong">
              Log in
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-line/60 px-6 py-8 mt-auto">
        <div className="mx-auto max-w-5xl flex flex-wrap items-center justify-between gap-4 text-xs text-neutral-500">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-gradient-to-br from-accent to-accent-glow flex items-center justify-center">
              <Play className="h-3 w-3 text-white fill-white" />
            </div>
            <span>Shortsmith</span>
            <span className="text-neutral-700">·</span>
            <span>© {new Date().getUTCFullYear()}</span>
          </div>
          <div className="flex flex-wrap gap-5">
            {c.footer_links.length > 0
              ? c.footer_links.map((l, i) => (
                  <Link key={i} href={l.href} className="hover:text-neutral-300">{l.label}</Link>
                ))
              : (
                <>
                  <Link href="/login" className="hover:text-neutral-300">Log in</Link>
                  <Link href={c.hero_cta_href} className="hover:text-neutral-300">Get access</Link>
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
    <div className="group rounded-xl border border-line bg-bg-1/60 backdrop-blur p-5 space-y-2.5 hover:border-accent/40 hover:bg-bg-1/80 transition">
      <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-accent/25 to-accent-glow/20 border border-accent/30 flex items-center justify-center group-hover:shadow-glow transition">
        <Icon className="h-4 w-4 text-accent" />
      </div>
      <div className="font-semibold text-[15px]">{title}</div>
      <div className="text-sm text-neutral-400 leading-relaxed">{body}</div>
    </div>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { MarketingNav } from "@/components/MarketingNav";
import { Reveal } from "@/components/Reveal";
import { InboundForm } from "@/components/InboundForm";
import { NICHES, NICHE_COUNT } from "@/lib/niches";
import { Search, PenLine, ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Niches — Yven",
  description:
    `The ${NICHE_COUNT} content niches Yven produces out of the box, plus how to request one we don't cover yet.`,
};

/**
 * /niches — what the product actually makes.
 *
 * This page exists because the landing page described a pipeline
 * without ever saying what comes out of it. "Pick the niche" was the
 * only mention of niches anywhere on the site, which leaves a visitor
 * guessing whether their subject is supported.
 *
 * Each niche states plainly whether it is researched against live
 * sources or written original. That distinction is real (research_mode
 * in modules/channels.py) and it is the honest answer to "is this just
 * AI slop?" — for half the niches the answer is "no, it is checked",
 * and for the other half it is "no, it is written, like fiction is".
 */
export default function NichesPage() {
  const sourced = NICHES.filter((n) => n.research === "sourced");
  const original = NICHES.filter((n) => n.research === "original");

  return (
    <div className="relative min-h-screen bg-[#08080a]">
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-40 left-1/4 h-[500px] w-[500px] rounded-full bg-accent/[0.07] blur-[120px]" />
        <div className="absolute top-1/2 right-0 h-[400px] w-[400px] rounded-full bg-accent-glow/[0.05] blur-[120px]" />
      </div>

      <MarketingNav />

      {/* ── Header ─────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 pt-32 pb-16 md:pt-40">
        <div className="max-w-4xl mx-auto text-center">
          <Reveal>
            <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-4 font-semibold">
              What we produce
            </div>
            <h1 className="text-4xl md:text-6xl font-semibold tracking-[-0.03em] leading-[1.05] text-white">
              {NICHE_COUNT} niches, ready to run.{" "}
              <span className="serif-accent text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-glow">
                Or ask for yours.
              </span>
            </h1>
            <p className="mt-6 text-base md:text-lg text-neutral-400 max-w-2xl mx-auto leading-relaxed">
              Each niche is a tuned preset — its own narrator voice, pacing, colour
              grade and search vocabulary. It is not one generic template with the
              topic swapped out, which is why a horror short and a finance short
              from Yven do not sound like the same video.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Researched niches ──────────────────────────────────── */}
      <NicheGroup
        icon={<Search className="h-4 w-4" />}
        eyebrow="Researched"
        title="Checked against live sources"
        blurb="Before a word is written, the pipeline pulls what is currently ranking on YouTube for the subject and researches the claim itself. Facts, numbers and dates in these videos come from somewhere real."
        niches={sourced}
      />

      {/* ── Original niches ────────────────────────────────────── */}
      <NicheGroup
        icon={<PenLine className="h-4 w-4" />}
        eyebrow="Original"
        title="Written, not reported"
        blurb="These are storytelling formats. There is no fact to check in a ghost story — the work is structure, escalation and a last line that reframes the first. Topic selection still uses live YouTube data to find what people are actually watching."
        niches={original}
      />

      {/* ── Custom niche request ───────────────────────────────── */}
      <section id="request" className="relative z-10 px-6 py-24 border-t border-white/5">
        <div className="max-w-2xl mx-auto">
          <Reveal>
            <div className="text-center mb-10">
              <div className="text-[11px] uppercase tracking-[0.18em] text-accent mb-4 font-semibold">
                Not listed?
              </div>
              <h2 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] text-white">
                Request a niche
              </h2>
              <p className="mt-4 text-sm md:text-base text-neutral-400 leading-relaxed">
                The engine can already build a channel around a subject that isn&apos;t on
                this list — it writes its own preset at runtime. Telling us which one you
                want is how it gets promoted to a tuned built-in, with a voice and a look
                chosen for it rather than inferred.
              </p>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="rounded-3xl border border-white/8 bg-white/[0.022] p-6 md:p-8 backdrop-blur-xl">
              <InboundForm
                endpoint="/api/marketing/niche-request"
                submitLabel="Send request"
                successTitle="Request received."
                successBody="We read every one of these — they decide which niche gets built next. If yours is a fit we'll email you."
                fields={[
                  { name: "niche_name", label: "The niche", required: true, half: true,
                    placeholder: "True crime, aquarium care, F1 history…" },
                  { name: "language", label: "Language", half: true,
                    placeholder: "English, Urdu, Spanish…",
                    help: "We render in any language the voice engine supports." },
                  { name: "examples", label: "Channels doing this well", type: "textarea",
                    placeholder: "Links or channel names — one per line.",
                    help: "The fastest way to show us the tone you're after." },
                  { name: "name", label: "Your name", required: true, half: true },
                  { name: "email", label: "Email", type: "email", required: true, half: true },
                  { name: "message", label: "Anything else", type: "textarea",
                    placeholder: "Audience, posting cadence, what you've tried already." },
                ]}
              />
            </div>
          </Reveal>

          <div className="mt-8 text-center text-sm text-neutral-500">
            Want pricing for a specific volume?{" "}
            <Link href="/#quote" className="text-accent hover:underline">
              Request a quote
            </Link>{" "}
            instead.
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

function NicheGroup({
  icon, eyebrow, title, blurb, niches,
}: {
  icon: React.ReactNode; eyebrow: string; title: string; blurb: string;
  niches: typeof NICHES;
}) {
  if (niches.length === 0) return null;
  return (
    <section className="relative z-10 px-6 py-16 border-t border-white/5">
      <div className="max-w-5xl mx-auto">
        <Reveal>
          <div className="max-w-2xl mb-10">
            <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-accent mb-3 font-semibold">
              {icon} {eyebrow}
            </div>
            <h2 className="text-2xl md:text-3xl font-semibold tracking-[-0.02em] text-white">
              {title}
            </h2>
            <p className="mt-3 text-sm text-neutral-400 leading-relaxed">{blurb}</p>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {niches.map((n, i) => (
            <Reveal key={n.slug} delay={(i % 2) * 80}>
              <div className="h-full rounded-2xl border border-white/8 bg-white/[0.022] p-5 backdrop-blur-xl transition hover:border-accent/25 hover:bg-white/[0.035]">
                <div className="text-white font-medium">{n.label}</div>
                <p className="mt-1.5 text-sm text-neutral-400 leading-relaxed">{n.blurb}</p>
                {n.example && (
                  <p className="mt-3 text-[13px] text-neutral-500 italic border-l border-white/10 pl-3">
                    {n.example}
                  </p>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function MarketingFooter() {
  return (
    <footer className="relative z-10 border-t border-white/5 px-6 py-12">
      <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-neutral-500">
        <span>© {new Date().getFullYear()} Yven</span>
        <div className="flex items-center gap-6">
          <Link href="/" className="hover:text-white transition">Home</Link>
          <Link href="/#quote" className="hover:text-white transition">Get a quote</Link>
          <Link href="/contact" className="hover:text-white transition">Contact</Link>
          <Link href="/login" className="inline-flex items-center gap-1 hover:text-white transition">
            Sign in <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </footer>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { MarketingNav } from "@/components/MarketingNav";
import { Reveal } from "@/components/Reveal";
import { InboundForm } from "@/components/InboundForm";
import { ArrowRight, Receipt, Sparkles, LifeBuoy } from "lucide-react";

export const metadata: Metadata = {
  title: "Contact — Yven",
  description: "Get in touch with the Yven team.",
};

/**
 * /contact — general enquiries.
 *
 * The three cards at the top exist to route people away from this form
 * when a more specific one will get them a better answer. A quote
 * request captured through a general contact box arrives without the
 * volume and niche, which means a reply that just asks for them.
 */
export default function ContactPage() {
  return (
    <div className="relative min-h-screen bg-[#08080a]">
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-40 right-1/4 h-[500px] w-[500px] rounded-full bg-accent/[0.07] blur-[120px]" />
      </div>

      <MarketingNav />

      <section className="relative z-10 px-6 pt-32 pb-16 md:pt-40">
        <div className="max-w-3xl mx-auto text-center">
          <Reveal>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] text-white">
              Talk to us
            </h1>
            <p className="mt-5 text-base text-neutral-400 max-w-xl mx-auto leading-relaxed">
              A real person reads these. If your question is about pricing or a
              niche we don&apos;t cover yet, the links below will get you a faster,
              more useful answer.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="relative z-10 px-6 pb-4">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-3">
          <RouteCard
            href="/#quote"
            icon={<Receipt className="h-4 w-4" />}
            title="Pricing"
            body="Tell us the volume and we'll quote it."
          />
          <RouteCard
            href="/niches#request"
            icon={<Sparkles className="h-4 w-4" />}
            title="A niche we don't list"
            body="Request it — that's how the next one gets picked."
          />
          <RouteCard
            href="/login"
            icon={<LifeBuoy className="h-4 w-4" />}
            title="Already a customer"
            body="Sign in — support is inside the dashboard."
          />
        </div>
      </section>

      <section className="relative z-10 px-6 py-16">
        <div className="max-w-2xl mx-auto">
          <Reveal delay={100}>
            <div className="rounded-3xl border border-white/8 bg-white/[0.022] p-6 md:p-8 backdrop-blur-xl">
              <div className="text-sm font-medium text-white mb-1">Everything else</div>
              <p className="text-xs text-neutral-500 mb-6">
                Partnerships, press, security reports, or anything the cards above
                don&apos;t cover.
              </p>
              <InboundForm
                endpoint="/api/marketing/contact"
                submitLabel="Send message"
                successTitle="Message sent."
                successBody="We'll reply to the address you gave us, usually within a couple of working days."
                fields={[
                  { name: "name", label: "Your name", required: true, half: true },
                  { name: "email", label: "Email", type: "email", required: true, half: true },
                  { name: "subject", label: "Subject", placeholder: "What's this about?" },
                  { name: "message", label: "Message", type: "textarea", required: true,
                    placeholder: "As much detail as you like." },
                ]}
              />
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/5 px-6 py-12">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-neutral-500">
          <span>© {new Date().getFullYear()} Yven</span>
          <div className="flex items-center gap-6">
            <Link href="/" className="hover:text-white transition">Home</Link>
            <Link href="/niches" className="hover:text-white transition">Niches</Link>
            <Link href="/login" className="inline-flex items-center gap-1 hover:text-white transition">
              Sign in <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function RouteCard({ href, icon, title, body }: {
  href: string; icon: React.ReactNode; title: string; body: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-white/8 bg-white/[0.022] p-4 backdrop-blur-xl transition hover:border-accent/25 hover:bg-white/[0.035]"
    >
      <div className="flex items-center gap-2 text-accent mb-1.5">{icon}</div>
      <div className="text-sm font-medium text-white flex items-center gap-1">
        {title}
        <ArrowRight className="h-3 w-3 opacity-0 -translate-x-1 transition group-hover:opacity-100 group-hover:translate-x-0" />
      </div>
      <p className="text-xs text-neutral-500 mt-1 leading-relaxed">{body}</p>
    </Link>
  );
}

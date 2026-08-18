import Link from "next/link";
import type { Metadata } from "next";
import { adminDb } from "@/lib/firebase-admin";
import { Reveal } from "@/components/Reveal";
import { MarketingNav } from "@/components/MarketingNav";
import { Check } from "lucide-react";

export const metadata: Metadata = {
  title: "Pricing — Yven",
  description:
    "Automated YouTube Shorts from $19/month. Research, script, voiceover, edit and publish — on autopilot.",
};

export const revalidate = 60;

/**
 * Public pricing.
 *
 * Reads the `plans` collection — the SAME table that grants entitlement.
 * A hardcoded price list is a promise you cannot keep: this page would
 * say $49 while the plan row said something else, and the customer would
 * be right either way. This codebase has already shipped that failure in
 * both directions — three tiers matching no real plan, then a
 * plans-backed table rendering cents as dollars at $4900/mo.
 *
 * price_* are CENTS. Dividing by 100 happens in exactly one place here,
 * which is the whole fix for the second of those bugs.
 *
 * `founder` is internal and never shown. Enterprise carries
 * features.custom_pricing so it renders "Custom" rather than "$0" — a $0
 * badge on the top tier is worse than showing no price at all.
 */

type Plan = {
  slug: string;
  name: string;
  price_monthly: number;
  max_channels: number;
  max_renders_month: number;
  features?: {
    headline?: string;
    items?: string[];
    best_for?: string;
    recommended?: boolean;
    custom_pricing?: boolean;
  };
  sort_order?: number;
  active?: boolean;
};

async function _plans(): Promise<Plan[]> {
  try {
    const snap = await adminDb().collection("plans").limit(50).get();
    const rows: Plan[] = [];
    snap.forEach((d) => {
      const p = (d.data() || {}) as Plan;
      if (p.active === false) return;
      if (p.slug === "founder") return;
      rows.push(p);
    });
    return rows.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  } catch {
    return [];
  }
}

function priceLabel(p: Plan): string {
  if (p.features?.custom_pricing) return "Custom";
  const cents = Number(p.price_monthly || 0);
  return cents > 0 ? `$${Math.round(cents / 100)}` : "Free";
}

export default async function PricingPage() {
  const plans = await _plans();

  return (
    <main className="min-h-screen bg-black text-white">
      <MarketingNav />

      <section className="px-6 pt-32 pb-16 max-w-3xl mx-auto text-center">
        <Reveal>
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Start creating with Yven.
          </h1>
          <p className="mt-5 text-neutral-400 text-lg">
            No credit card required. Want more time?{" "}
            <Link href="/referrals" className="text-white underline underline-offset-4">
              Invite your friends.
            </Link>
          </p>
        </Reveal>
      </section>

      <section className="px-6 pb-8 max-w-7xl mx-auto">
        {plans.length === 0 ? (
          // Never render an empty grid — it reads as "the product is free".
          <p className="text-center text-neutral-500">
            Pricing is being updated —{" "}
            <Link href="/contact" className="underline">ask us</Link> for current rates.
          </p>
        ) : (
          <div className="grid gap-5 md:grid-cols-3 lg:grid-cols-5 items-start">
            {plans.map((p, i) => {
              const rec = !!p.features?.recommended;
              const paid = !p.features?.custom_pricing && Number(p.price_monthly) > 0;
              return (
                <Reveal key={p.slug} delay={80 * i}>
                  <div
                    className={`relative rounded-2xl border p-6 h-full flex flex-col ${
                      rec
                        ? "border-emerald-400/40 bg-emerald-400/[0.04]"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    {rec && (
                      <span className="absolute -top-2.5 left-6 text-[10px] uppercase tracking-[0.14em] bg-emerald-400 text-black px-2 py-0.5 rounded-full font-bold">
                        Recommended
                      </span>
                    )}

                    <h2 className="text-base font-semibold text-white">{p.name}</h2>

                    <div className="mt-3 flex items-baseline gap-1">
                      <span className="text-3xl font-semibold tracking-tight tabular-nums">
                        {priceLabel(p)}
                      </span>
                      {paid && <span className="text-sm text-neutral-500">/mo</span>}
                    </div>

                    <p className="mt-2 text-sm text-neutral-300">
                      {p.features?.custom_pricing
                        ? "150+ videos/month"
                        : `${p.max_renders_month || "Unlimited"} videos/month`}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {p.max_channels
                        ? `${p.max_channels} channel${p.max_channels === 1 ? "" : "s"}`
                        : "Unlimited channels"}
                    </p>
                    {p.features?.best_for && (
                      <p className="mt-1 text-xs text-neutral-500">{p.features.best_for}</p>
                    )}

                    <div className="my-5 h-px bg-white/10" />

                    {p.features?.headline && (
                      <p className="text-xs font-medium text-neutral-300 mb-3">
                        {p.features.headline}
                      </p>
                    )}

                    <ul className="space-y-2 text-sm text-neutral-400 flex-1">
                      {(p.features?.items || []).map((it) => (
                        <li key={it} className="flex gap-2">
                          <Check className="h-4 w-4 shrink-0 text-emerald-400/80 mt-0.5" />
                          <span>{it}</span>
                        </li>
                      ))}
                    </ul>

                    <Link
                      href={p.features?.custom_pricing ? "/contact" : "/signup"}
                      className={`mt-6 block text-center px-4 py-2.5 rounded-full text-sm font-semibold transition ${
                        rec
                          ? "bg-white text-black hover:bg-neutral-200"
                          : "border border-white/15 text-neutral-200 hover:border-white/30 hover:text-white"
                      }`}
                    >
                      {p.features?.custom_pricing
                        ? "Contact sales"
                        : paid
                        ? "Get started"
                        : "Start free"}
                    </Link>
                  </div>
                </Reveal>
              );
            })}
          </div>
        )}
      </section>

      <section className="px-6 py-20 max-w-3xl mx-auto text-center">
        <Reveal>
          <h2 className="text-2xl font-semibold tracking-tight">Want more time?</h2>
          <p className="mt-3 text-neutral-400">
            Invite creators to Yven and earn free time on Creator — no card, no catch.
          </p>
          <div className="mt-6 inline-flex flex-col sm:flex-row gap-3">
            <Link
              href="/referrals"
              className="px-6 py-3 rounded-full bg-white text-black text-sm font-semibold hover:bg-neutral-200 transition"
            >
              See the referral program
            </Link>
            <Link
              href="/contact"
              className="px-6 py-3 rounded-full border border-white/15 text-sm font-medium text-neutral-300 hover:text-white hover:border-white/30 transition"
            >
              Talk to us
            </Link>
          </div>
        </Reveal>
      </section>
    </main>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { Reveal } from "@/components/Reveal";
import { MarketingNav } from "@/components/MarketingNav";
import { REWARD_TIERS } from "@/lib/referral-rewards";

export const metadata: Metadata = {
  title: "Referral program — Yven",
  description:
    "Invite creators to Yven and earn free time on the Pro plan. Five approved referrals earns 14 days, ten earns a month.",
};

/**
 * Public explainer for the referral program.
 *
 * Deliberately reads REWARD_TIERS rather than restating the numbers.
 * A marketing page that hardcodes "5 referrals = 14 days" becomes a
 * false promise the moment the tiers move, and nothing would fail to
 * warn anyone — the page would simply be wrong. Importing the same
 * constant the granting code uses means the page cannot disagree with
 * what the product actually does.
 *
 * The personal link lives behind sign-in (/app/referrals) because it is
 * per-user and only exists once an account does. This page's job is to
 * explain the offer and hand people to signup.
 */
export default function ReferralsPage() {
  const tiers = [...REWARD_TIERS].sort((a, b) => a.at - b.at);

  const steps = [
    {
      n: "01",
      title: "Get your link",
      body: "Sign up and open Referrals in your dashboard. Your link is there the moment your account exists — nothing to apply for.",
    },
    {
      n: "02",
      title: "Share it",
      body: "Send it to creators who would actually use this. The link tags anyone who signs up through it to your account automatically.",
    },
    {
      n: "03",
      title: "They join",
      body: "A referral counts once the person you invited has an approved or paid account. Sign-ups that never activate do not count toward a tier.",
    },
    {
      n: "04",
      title: "Free time lands",
      body: "Hit a tier and the credit is applied to your account automatically. No claiming, no code to enter, no support ticket.",
    },
  ];

  return (
    <main className="min-h-screen bg-black text-white">
      <MarketingNav />

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="relative px-6 pt-32 pb-20 max-w-5xl mx-auto text-center">
        <Reveal>
          <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-400/80 mb-5">
            Referral program
          </p>
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Bring other creators.
            <br />
            <span className="bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent">
              Run yours for free.
            </span>
          </h1>
          <p className="mt-6 text-neutral-400 text-lg max-w-xl mx-auto leading-relaxed">
            Every creator you bring who sticks around earns you free time on
            the Pro plan. No cap on how many you invite.
          </p>
        </Reveal>

        <Reveal delay={150}>
          <div className="mt-10 flex flex-wrap gap-3 justify-center">
            <Link
              href="/signup"
              className="px-6 py-3 rounded-full bg-white text-black text-sm font-semibold hover:bg-neutral-200 transition"
            >
              Create an account
            </Link>
            <Link
              href="/app/referrals"
              className="px-6 py-3 rounded-full border border-white/15 text-sm font-medium text-neutral-300 hover:text-white hover:border-white/30 transition"
            >
              I already have one
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ── Tiers ────────────────────────────────────────────── */}
      <section className="px-6 pb-8 max-w-4xl mx-auto">
        <Reveal delay={200}>
          <div className="grid gap-5 sm:grid-cols-2">
            {tiers.map((t, i) => (
              <div
                key={t.at}
                className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center overflow-hidden"
              >
                {i === tiers.length - 1 && (
                  <span className="absolute top-4 right-4 text-[10px] uppercase tracking-[0.14em] text-emerald-400/90">
                    Best value
                  </span>
                )}
                <div className="text-5xl font-semibold tracking-tight tabular-nums">
                  {t.at}
                </div>
                <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                  approved referrals
                </div>
                <div className="my-6 h-px bg-white/10" />
                <div className="text-2xl font-semibold text-emerald-400">
                  {t.label}
                </div>
                <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                  on Pro, applied automatically
                </div>
              </div>
            ))}
          </div>
          <p className="mt-5 text-center text-xs text-neutral-500">
            Tiers are cumulative and each is granted once. Reaching{" "}
            {tiers[tiers.length - 1]?.at} does not re-grant the earlier tier.
          </p>
        </Reveal>
      </section>

      {/* ── How it works ─────────────────────────────────────── */}
      <section className="px-6 py-20 max-w-5xl mx-auto">
        <Reveal>
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-center">
            How it works
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={100 + i * 80}>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-7 h-full">
                <div className="text-[11px] font-mono text-emerald-400/70 tracking-widest">
                  {s.n}
                </div>
                <h3 className="mt-3 text-base font-semibold text-white">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
                  {s.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Rules ────────────────────────────────────────────── */}
      <section className="px-6 pb-24 max-w-3xl mx-auto">
        <Reveal>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8">
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-neutral-300">
              The fine print, in plain words
            </h2>
            <ul className="mt-5 space-y-3 text-sm text-neutral-400 leading-relaxed">
              <li>
                <span className="text-neutral-200">What counts.</span> A
                referral is approved once the person you invited has an
                approved or paid account. A sign-up that never activates does
                not count.
              </li>
              <li>
                <span className="text-neutral-200">One person, once.</span>{" "}
                Each referred account counts a single time, for whoever
                referred them first.
              </li>
              <li>
                <span className="text-neutral-200">No self-referrals.</span>{" "}
                Inviting yourself with another address does not earn anything.
              </li>
              <li>
                <span className="text-neutral-200">Credit stacks on time,
                not price.</span> Rewards extend how long you run on Pro. They
                are not cash and are not refundable.
              </li>
              <li>
                <span className="text-neutral-200">Nothing to claim.</span>{" "}
                Crossing a tier applies the credit to your account by itself.
                If it has not appeared, tell us and we will look.
              </li>
            </ul>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="mt-10 text-center">
            <Link
              href="/signup"
              className="inline-block px-7 py-3 rounded-full bg-white text-black text-sm font-semibold hover:bg-neutral-200 transition"
            >
              Get your referral link
            </Link>
            <p className="mt-4 text-xs text-neutral-500">
              Questions about the program?{" "}
              <Link href="/contact" className="text-neutral-300 underline underline-offset-4 hover:text-white">
                Ask us
              </Link>
              .
            </p>
          </div>
        </Reveal>
      </section>
    </main>
  );
}

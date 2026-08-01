import Link from "next/link";
import { Check } from "lucide-react";
import { Tilt3D } from "./Tilt3D";

type Tier = { name: string; price: string; sub?: string; features?: string[]; highlight?: boolean };

/**
 * Pricing card — extracted so the landing page stays skimmable.
 * Featured tier has a subtle inner glow + gets Tilt3D scale=1.03,
 * others use scale=1. Both wrap in Tilt3D for the 3D parallax on
 * mouse move — the effect is subtle here (max=4°) because pricing
 * needs to read as trustworthy, not gimmicky.
 */
export function PricingCard({ tier, ctaHref }: { tier: Tier; ctaHref: string }) {
  return (
    <Tilt3D max={4} scale={tier.highlight ? 1.03 : 1} className="h-full">
      <div className={
        "relative rounded-3xl border p-8 h-full transition-[border-color,box-shadow] duration-500 " +
        (tier.highlight
          ? "border-accent/25 bg-gradient-to-b from-accent/[0.04] to-white/[0.01] shadow-[0_30px_80px_rgba(0,0,0,0.4),0_0_50px_rgba(167,139,250,0.08)]"
          : "border-white/6 bg-white/[0.015] backdrop-blur-3xl hover:border-white/12")
      }>
        {tier.highlight && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-accent to-accent-glow text-white px-3.5 py-1 rounded-full text-[10px] font-semibold tracking-[0.14em] uppercase shadow-[0_4px_20px_rgba(167,139,250,0.3)]">
            Most Popular
          </div>
        )}

        <div style={{ transform: "translateZ(20px)" }}>
          <h3 className="text-lg font-semibold tracking-[-0.01em] text-white mb-1">{tier.name}</h3>
          <p className="text-neutral-500 text-sm mb-6 font-light">{tier.sub}</p>

          <div className="flex items-baseline gap-1 mb-8">
            <span className="text-5xl font-semibold tracking-[-0.03em] text-white">{tier.price}</span>
            <span className="text-neutral-500 text-sm">/mo</span>
          </div>

          {tier.features && tier.features.length > 0 && (
            <ul className="space-y-2.5 mb-8">
              {tier.features.map((f, j) => (
                <li key={j} className="flex items-start gap-2.5 text-sm text-neutral-300 font-light">
                  <Check className="h-4 w-4 text-accent mt-0.5 shrink-0" strokeWidth={2.5} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}

          <Link href={ctaHref}
                className={
                  "block text-center w-full py-3 rounded-full text-sm font-semibold transition-all " +
                  (tier.highlight
                    ? "bg-white text-[#050508] hover:bg-white/90 shadow-[0_10px_40px_rgba(255,255,255,0.15)]"
                    : "border border-white/10 text-white/85 hover:border-white/20 hover:bg-white/[0.03]")
                }>
            {tier.name === "Agency" ? "Contact Sales" : "Start Free Trial"}
          </Link>
        </div>
      </div>
    </Tilt3D>
  );
}

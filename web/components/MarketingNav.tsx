"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Floating pill navigation used on every marketing / public page.
 * Fades in a stronger backdrop on scroll so it stays legible over
 * light hero content.
 */
export function MarketingNav({ ctaHref = "/signup", ctaText = "Get Early Access" }: { ctaHref?: string; ctaText?: string }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 50);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <nav className={
      "fixed top-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-6 rounded-full px-6 py-2.5 " +
      "border transition-all duration-400 backdrop-blur-2xl " +
      (scrolled
        ? "bg-[#050508]/80 border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        : "bg-white/[0.02] border-white/6")
    }>
      <Link href="/" className="font-extrabold text-lg tracking-tight bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent">
        Yven
      </Link>
      <ul className="hidden md:flex items-center gap-5 list-none text-xs font-medium">
        <li><Link href="/#features"       className="text-neutral-400 hover:text-white transition">Features</Link></li>
        <li><Link href="/#pipeline"       className="text-neutral-400 hover:text-white transition">How It Works</Link></li>
        <li><Link href="/#pricing"        className="text-neutral-400 hover:text-white transition">Pricing</Link></li>
        <li><Link href="/roadmap"         className="text-neutral-400 hover:text-white transition">Roadmap</Link></li>
        <li><Link href="/compare"         className="text-neutral-400 hover:text-white transition">Compare</Link></li>
      </ul>
      <Link href={ctaHref}
            className="bg-gradient-to-br from-accent to-accent-2 text-[#050508] px-4 py-2 rounded-full font-bold text-xs hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(167,139,250,0.4)] transition-all">
        {ctaText}
      </Link>
    </nav>
  );
}

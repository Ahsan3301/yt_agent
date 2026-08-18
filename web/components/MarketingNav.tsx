"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";

/**
 * Floating pill navigation used on every marketing / public page.
 * Fades in a stronger backdrop on scroll so it stays legible over
 * light hero content.
 */
export function MarketingNav({ ctaHref = "/signup", ctaText = "Get Early Access" }: { ctaHref?: string; ctaText?: string }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  // Lock the page behind the sheet. Without this the body scrolls under
  // an open overlay, which on iOS also drags the sheet around with it.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 50);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  const LINKS = [
    { href: "/#features",  label: "Features"     },
    { href: "/niches",     label: "Niches"       },
    { href: "/#pipeline",  label: "How It Works" },
    { href: "/pricing",    label: "Pricing"      },
    { href: "/referrals",  label: "Referrals"    },
    { href: "/roadmap",    label: "Roadmap"      },
    { href: "/contact",    label: "Contact"      },
  ];

  return (
    <>
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
        <li><Link href="/niches"          className="text-neutral-400 hover:text-white transition">Niches</Link></li>
        <li><Link href="/#pipeline"       className="text-neutral-400 hover:text-white transition">How It Works</Link></li>
        {/* Lands on /pricing now that real tiers are published. It
            pointed at the #quote form during the period when no prices
            existed. */}
        <li><Link href="/pricing"         className="text-neutral-400 hover:text-white transition">Pricing</Link></li>
        <li><Link href="/referrals"       className="text-neutral-400 hover:text-white transition">Referrals</Link></li>
        <li><Link href="/roadmap"         className="text-neutral-400 hover:text-white transition">Roadmap</Link></li>
        <li><Link href="/contact"         className="text-neutral-400 hover:text-white transition">Contact</Link></li>
      </ul>
      <div className="flex items-center gap-2 md:gap-3">
        {/* Hamburger. Every nav link was `hidden md:flex` with NO mobile
            affordance, so a phone visitor could not reach Pricing,
            Niches, Referrals, Roadmap or Contact at all — the whole site
            was three links wide on the device most people arrive on. */}
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="md:hidden -mr-1 h-11 w-11 flex items-center justify-center rounded-full
                     text-neutral-300 hover:text-white hover:bg-white/5 active:scale-90 transition"
        >
          <Menu className="h-5 w-5" />
        </button>
        {/* Log in sat nowhere on the marketing site, so an existing
            customer had to know /login by heart. Plain text beside the
            gradient CTA: returning users look for the quiet link, new
            ones for the loud button, and neither should compete. */}
        {/* px/py so this clears the 44px minimum tap target — it
            measured 21x32 before, which is a miss on a phone. */}
        <Link href="/login"
              className="hidden sm:inline-flex items-center px-3 py-2.5 text-xs font-medium
                         text-neutral-400 hover:text-white transition">
          Log in
        </Link>
        <Link href={ctaHref}
              className="bg-gradient-to-br from-accent to-accent-2 text-[#050508] px-4 py-2 rounded-full font-bold text-xs hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(167,139,250,0.4)] transition-all">
          {ctaText}
        </Link>
      </div>
    </nav>

    {/* ── Mobile sheet ──────────────────────────────────────────
        Slides from the right like a native app drawer, full-height,
        with generous rows: 44px+ targets, one destination per line. */}
    {open && (
      <div className="md:hidden fixed inset-0 z-[60]">
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]"
          onClick={() => setOpen(false)}
        />
        <aside className="absolute right-0 top-0 h-full w-[78%] max-w-xs bg-[#050508]/95 backdrop-blur-2xl
                          border-l border-white/10 flex flex-col
                          pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]
                          animate-[fadeUp_0.28s_cubic-bezier(0.16,1,0.3,1)_both]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
            <span className="font-extrabold text-lg tracking-tight bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent">
              Yven
            </span>
            <button onClick={() => setOpen(false)} aria-label="Close menu"
                    className="p-2 -mr-2 rounded-full text-neutral-400 hover:text-white active:scale-90 transition">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)}
                    className="block px-5 py-3.5 text-[15px] text-neutral-300 hover:text-white
                               hover:bg-white/[0.04] active:bg-white/[0.07] transition">
                {l.label}
              </Link>
            ))}
          </div>

          <div className="p-4 space-y-2 border-t border-white/8">
            <Link href="/login" onClick={() => setOpen(false)}
                  className="block text-center px-4 py-3 rounded-full border border-white/15
                             text-sm font-medium text-neutral-200 active:scale-[0.98] transition">
              Log in
            </Link>
            <Link href={ctaHref} onClick={() => setOpen(false)}
                  className="block text-center px-4 py-3 rounded-full bg-gradient-to-br from-accent to-accent-2
                             text-[#050508] text-sm font-bold active:scale-[0.98] transition">
              {ctaText}
            </Link>
          </div>
        </aside>
      </div>
    )}
    </>
  );
}

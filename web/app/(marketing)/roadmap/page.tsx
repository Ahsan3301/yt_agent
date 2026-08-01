"use client";

import Link from "next/link";
import { useState } from "react";
import { MarketingNav } from "@/components/MarketingNav";

/**
 * Public roadmap page.
 *
 * Three tabs — Live Now (what's shipped), Next Up (upcoming +
 * planned with vote counts), Changelog (dated history).
 *
 * Vote clicks are local-state only for now; the storage layer for
 * feature requests isn't built yet. That's why every "vote"
 * response persists in-tab only. Documented on the page so no
 * expectation of persistence is set.
 */
type Status = "live" | "next" | "planned";
type Item = { title: string; body: string; tag?: string; status: Status };

const LIVE: Item[] = [
  { status: "live", title: "Complete video pipeline",       body: "Research → Script → Storyboard → Visuals → Audio → Edit → QA → Publish. Fully autonomous." },
  { status: "live", title: "Multi-channel management",      body: "Attach any number of YouTube channels. Each gets its own tone, voice, and schedule." },
  { status: "live", title: "YouTube auto-publishing",       body: "Per-channel OAuth. Auto-title, description, tags, thumbnail." },
  { status: "live", title: "Approval mode",                 body: "Review every video before it goes live. Switch to autopilot when ready." },
];
const NEXT: Item[] = [
  { status: "next",    title: "Channel DNA analysis",        body: "AI learns your voice, pacing, humor, and style from existing content. No more generic output.", tag: "Q3 2026" },
  { status: "next",    title: "AI thumbnail generator",      body: "CTR-optimized thumbnails with face detection, contrast analysis, and A/B testing.", tag: "Q3 2026" },
  { status: "next",    title: "TikTok & Instagram Reels",    body: "Auto-publish beyond YouTube with native-format optimization per platform.", tag: "Q4 2026" },
  { status: "planned", title: "Team collaboration",          body: "Multi-user workspaces, client approvals, and role-based permissions for agencies.", tag: "Q4 2026" },
  { status: "planned", title: "Custom voice cloning",        body: "Upload your own voice samples for truly personalized narration.", tag: "Q1 2027" },
  { status: "planned", title: "Stripe billing + self-serve", body: "Card on file, plan upgrades, invoices — no more manual onboarding.", tag: "Q1 2027" },
];
const CHANGELOG: Array<{ date: string; items: Array<{ title: string; body: string }> }> = [
  { date: "August 2026", items: [
    { title: "v3.0 — Yven rebrand + design system",    body: "New identity, new palette, complete design overhaul across landing + dashboard." },
    { title: "v2.9 — Multi-tenant SaaS",               body: "Per-user isolation, admin approvals, plan quotas. From single-user to production-ready platform." },
  ]},
  { date: "July 2026", items: [
    { title: "v2.5 — Referral trial-unlock (coming)",  body: "Share Yven with 5 creators, unlock your trial instantly. Backend in progress." },
    { title: "v2.0 — MinIO object store + CDN",        body: "Rendered videos served directly, faster previews, smaller PB." },
  ]},
  { date: "June 2026", items: [
    { title: "v1.5 — Cloudflare Flux 2 image gen",     body: "Per-account rotation, klein-9b for scenes, higher-fidelity visuals." },
    { title: "v1.0 — Public beta",                     body: "Initial release with YouTube automation + full pipeline." },
  ]},
];

export default function RoadmapPage() {
  const [tab, setTab] = useState<"live" | "next" | "changelog">("live");

  return (
    <div className="min-h-screen relative">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="blob top-[-100px] right-[-100px] h-[500px] w-[500px] opacity-40"
             style={{ background: "radial-gradient(circle, #a78bfa 0%, transparent 70%)" }} />
        <div className="blob bottom-[-100px] left-[-100px] h-[500px] w-[500px] opacity-40"
             style={{ background: "radial-gradient(circle, #67e8f9 0%, transparent 70%)" }} />
      </div>

      <MarketingNav />

      <div className="max-w-3xl mx-auto px-6 pt-32 pb-24 relative z-10">
        <div className="text-xl font-extrabold bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent mb-8 inline-block">
          <Link href="/">Yven</Link>
        </div>
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-3 text-gradient-hero">Product Roadmap</h1>
        <p className="text-neutral-400 mb-10">What's live, what's next, and what you can vote for.</p>

        <div className="inline-flex gap-1.5 mb-10 bg-white/[0.015] backdrop-blur-2xl border border-white/6 rounded-xl p-1.5">
          {(["live","next","changelog"] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)}
                    className={
                      "px-5 py-2.5 rounded-lg text-sm font-semibold transition " +
                      (tab === k
                        ? "bg-accent/15 text-accent"
                        : "text-neutral-500 hover:text-neutral-300")
                    }>
              {k === "live" ? "Live Now" : k === "next" ? "Next Up" : "Changelog"}
            </button>
          ))}
        </div>

        {tab === "live" && (
          <div className="space-y-4">
            {LIVE.map((it) => (<RoadmapCard key={it.title} item={it} />))}
          </div>
        )}
        {tab === "next" && (
          <>
            <div className="text-xs text-neutral-500 mb-4 italic">
              Votes are local-only for now — persistent voting ships with the referrals backend.
            </div>
            <div className="space-y-4">
              {NEXT.map((it) => (<RoadmapCard key={it.title} item={it} votable />))}
            </div>
          </>
        )}
        {tab === "changelog" && (
          <div>
            {CHANGELOG.map((section) => (
              <div key={section.date}>
                <div className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 mt-8 mb-4 font-bold">{section.date}</div>
                <div className="space-y-4">
                  {section.items.map((it) => (
                    <RoadmapCard key={it.title} item={{ ...it, status: "live" as Status }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RoadmapCard({ item, votable }: { item: Item; votable?: boolean }) {
  const [voted, setVoted] = useState(false);
  const dotClass =
    item.status === "live" ? "bg-success shadow-[0_0_10px_#22c55e]" :
    item.status === "next" ? "bg-warn shadow-[0_0_10px_#fbbf24]"    :
                             "bg-neutral-500";
  const tagClass =
    item.status === "live" ? "bg-success/10 text-success" :
    item.status === "next" ? "bg-warn/10 text-amber-300"  :
                             "bg-white/5 text-neutral-400";

  return (
    <div className="relative p-7 bg-white/[0.015] backdrop-blur-2xl border border-white/6 rounded-2xl flex items-start gap-4 hover:border-accent/15 transition-all overflow-hidden">
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-accent/15 to-transparent" />
      <div className={"w-2.5 h-2.5 rounded-full mt-2 shrink-0 " + dotClass} />
      <div className="flex-1">
        <h3 className="text-base font-bold mb-1.5">{item.title}</h3>
        <p className="text-neutral-400 text-sm leading-relaxed">{item.body}</p>
        {item.tag && (
          <span className={"inline-block mt-2.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider " + tagClass}>
            {item.tag}
          </span>
        )}
      </div>
      {votable && (
        <button
          onClick={() => setVoted(true)}
          disabled={voted}
          className={
            "shrink-0 px-4 py-2 rounded-lg text-xs font-semibold transition border " +
            (voted
              ? "border-success/40 text-success bg-success/5 shadow-[0_0_12px_rgba(34,197,94,0.1)]"
              : "border-white/8 text-neutral-400 hover:border-accent hover:text-accent hover:shadow-[0_0_12px_rgba(167,139,250,0.15)] bg-white/[0.02]")
          }>
          {voted ? "Voted ✓" : "Vote"}
        </button>
      )}
    </div>
  );
}

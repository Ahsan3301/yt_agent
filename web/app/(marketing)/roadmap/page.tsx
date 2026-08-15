import Link from "next/link";
import { adminDb } from "@/lib/firebase-admin";
import { MarketingNav } from "@/components/MarketingNav";
import { RoadmapTabs } from "@/components/RoadmapTabs";

/**
 * Public roadmap.
 *
 * Server-fetches roadmap_items from PB. If PB is empty (fresh install /
 * migration just landed) or unreachable, falls back to a hardcoded
 * default set that matches the design. Editable at /superadmin/roadmap.
 *
 * DYNAMIC, not ISR. `revalidate = 60` was declared here but never took
 * effect: the PocketBase client fetches with no-store, so Next.js hit
 *
 *   Error: Page changed from static to dynamic at runtime /roadmap,
 *   reason: revalidate: 0 fetch .../roadmap_items/records
 *
 * on every request. The page still rendered — it fell back to dynamic —
 * so the only visible symptom was an error logged on each visit, which
 * is exactly the kind of thing that gets scrolled past for months.
 *
 * Declaring the truth removes the error. Restoring real caching means
 * making the PB client cacheable, which is a data-layer change and
 * affects every consumer, not just this page.
 */
export const dynamic = "force-dynamic";

export type Status = "live" | "next" | "planned" | "changelog";
export type Item = { status: Status; title: string; body: string; tag?: string; section?: string; sort_order?: number };

const DEFAULT_ITEMS: Item[] = [
  { status: "live", sort_order: 0, title: "Complete video pipeline",       body: "Research → Script → Storyboard → Visuals → Audio → Edit → QA → Publish. Fully autonomous." },
  { status: "live", sort_order: 1, title: "Multi-channel management",      body: "Attach any number of YouTube channels. Each gets its own tone, voice, and schedule." },
  // Thumbnail setting is attempted but YouTube rejects it with 403 on
  // channels that have not completed phone verification, so it is not
  // claimed here as a shipped capability.
  { status: "live", sort_order: 2, title: "YouTube auto-publishing",       body: "Per-channel OAuth. Writes the title, description, tags and hashtags for every upload." },
  { status: "live", sort_order: 3, title: "Performance feedback loop",     body: "Reads real view counts back from YouTube and feeds the titles that beat your median into the next script." },
  // Moved out of "live": video approval mode is not built. The only
  // approval flow in the codebase is an admin approving new USER
  // signups, which is a different thing entirely.
  { status: "next", sort_order: 3, title: "Approval mode",                 body: "Review every video before it goes live. Switch to autopilot when ready.", tag: "Q4 2026" },

  { status: "next", sort_order: 0, title: "Channel DNA analysis",          body: "AI learns your voice, pacing, humor, and style from existing content.", tag: "Q3 2026" },
  { status: "next", sort_order: 1, title: "AI thumbnail generator",        body: "CTR-optimized thumbnails with face detection, contrast analysis, and A/B testing.", tag: "Q3 2026" },
  { status: "next", sort_order: 2, title: "TikTok & Instagram Reels",      body: "Auto-publish beyond YouTube with native-format optimization per platform.", tag: "Q4 2026" },

  { status: "planned", sort_order: 0, title: "Team collaboration",         body: "Multi-user workspaces, client approvals, and role-based permissions for agencies.", tag: "Q4 2026" },
  { status: "planned", sort_order: 1, title: "Custom voice cloning",       body: "Upload your own voice samples for truly personalized narration.", tag: "Q1 2027" },
  { status: "planned", sort_order: 2, title: "Stripe billing + self-serve", body: "Card on file, plan upgrades, invoices — no more manual onboarding.", tag: "Q1 2027" },

  { status: "changelog", section: "August 2026", sort_order: 0, title: "v3.0 — Yven rebrand + design system",  body: "New identity, new palette, complete design overhaul across landing + dashboard." },
  { status: "changelog", section: "August 2026", sort_order: 1, title: "v2.9 — Multi-tenant SaaS",             body: "Per-user isolation, admin approvals, plan quotas. From single-user to production-ready platform." },
  { status: "changelog", section: "July 2026",   sort_order: 0, title: "v2.5 — Referral trial-unlock",         body: "Share Yven with 5 creators, unlock your trial instantly." },
  { status: "changelog", section: "June 2026",   sort_order: 0, title: "v1.5 — Cloudflare Flux 2 image gen",   body: "Per-account rotation, klein-9b for scenes, higher-fidelity visuals." },
  { status: "changelog", section: "June 2026",   sort_order: 1, title: "v1.0 — Public beta",                   body: "Initial release with YouTube automation + full pipeline." },
];

async function _loadItems(): Promise<Item[]> {
  try {
    const snap = await adminDb().collection("roadmap_items").orderBy("sort_order", "asc").get();
    if (snap.empty) return DEFAULT_ITEMS;
    return snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        status:     (["live","next","planned","changelog"].includes(x.status) ? x.status : "planned") as Status,
        title:      String(x.title || ""),
        body:       String(x.body  || ""),
        tag:        x.tag ? String(x.tag) : undefined,
        section:    x.section ? String(x.section) : undefined,
        sort_order: Number(x.sort_order) || 0,
      };
    }).filter((it) => it.title);
  } catch {
    return DEFAULT_ITEMS;
  }
}

export default async function RoadmapPage() {
  const items = await _loadItems();

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

        <RoadmapTabs items={items} />
      </div>
    </div>
  );
}

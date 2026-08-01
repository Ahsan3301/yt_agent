"use client";

import { useMemo, useState } from "react";
import type { Item, Status } from "@/app/(marketing)/roadmap/page";

/**
 * Tab-switcher + card renderer for the public roadmap.
 *
 * Items come from the parent server component (PB or fallback).
 * Voting is local-state only for now; persistent voting ships with
 * the referrals backend since we need a user id to attribute votes.
 */
export function RoadmapTabs({ items }: { items: Item[] }) {
  const [tab, setTab] = useState<"live" | "next" | "changelog">("live");

  const grouped = useMemo(() => {
    const byStatus: Record<Status, Item[]> = { live: [], next: [], planned: [], changelog: [] };
    for (const it of items) byStatus[it.status].push(it);
    for (const k of Object.keys(byStatus) as Status[]) {
      byStatus[k].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
    // Changelog groups by section, sections ordered by the order sections first appear.
    const sectionOrder: string[] = [];
    const bySection: Record<string, Item[]> = {};
    for (const it of byStatus.changelog) {
      const s = it.section || "Unreleased";
      if (!bySection[s]) { bySection[s] = []; sectionOrder.push(s); }
      bySection[s].push(it);
    }
    return { byStatus, changelogSections: sectionOrder.map((s) => ({ section: s, items: bySection[s] })) };
  }, [items]);

  return (
    <>
      <div className="inline-flex gap-1.5 mb-10 bg-white/[0.015] backdrop-blur-2xl border border-white/6 rounded-xl p-1.5">
        {(["live", "next", "changelog"] as const).map((k) => (
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
          {grouped.byStatus.live.length === 0 && <EmptyState label="No live items yet." />}
          {grouped.byStatus.live.map((it, i) => (<RoadmapCard key={i} item={it} />))}
        </div>
      )}

      {tab === "next" && (
        <>
          <div className="text-xs text-neutral-500 mb-4 italic">
            Votes are local-only for now — persistent voting ships with the referrals backend.
          </div>
          <div className="space-y-4">
            {grouped.byStatus.next.length === 0 && grouped.byStatus.planned.length === 0 && <EmptyState label="Nothing in the pipeline yet." />}
            {grouped.byStatus.next.map((it, i) => (<RoadmapCard key={`n${i}`} item={it} votable />))}
            {grouped.byStatus.planned.map((it, i) => (<RoadmapCard key={`p${i}`} item={it} votable />))}
          </div>
        </>
      )}

      {tab === "changelog" && (
        <div>
          {grouped.changelogSections.length === 0 && <EmptyState label="No changelog entries yet." />}
          {grouped.changelogSections.map(({ section, items }) => (
            <div key={section}>
              <div className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 mt-8 mb-4 font-bold">{section}</div>
              <div className="space-y-4">
                {items.map((it, i) => (<RoadmapCard key={i} item={it} />))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="text-center text-sm text-neutral-500 py-12 border border-dashed border-white/6 rounded-2xl">
      {label}
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

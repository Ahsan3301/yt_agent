"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, Eye, Plus, X, GripVertical, ScrollText } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

/**
 * Roadmap CMS — bulk upsert editor.
 *
 * Loads all roadmap_items on mount, presents a flat list of editable
 * cards, saves the whole set on submit. Deletes any row present at
 * load-time but absent at save-time.
 */

type Item = {
  id?: string;
  status: "live" | "next" | "planned" | "changelog";
  title: string;
  body: string;
  tag?: string;
  section?: string;
  sort_order?: number;
};

const STATUS_ORDER: Item["status"][] = ["live", "next", "planned", "changelog"];
const STATUS_LABEL: Record<Item["status"], string> = {
  live: "Live now",
  next: "Next up",
  planned: "Planned",
  changelog: "Changelog",
};

export default function RoadmapCMS() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/superadmin/roadmap");
        if (r.ok) {
          const d = await r.json();
          setItems((d.items || []).map((it: Item) => ({
            id: it.id,
            status: STATUS_ORDER.includes(it.status) ? it.status : "planned",
            title: it.title || "",
            body: it.body || "",
            tag: it.tag || "",
            section: it.section || "",
            sort_order: Number(it.sort_order) || 0,
          })));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/superadmin/roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setMsg(`Saved ${j.count} items. Public /roadmap picks this up on next load.`);
      else setMsg(`Error: ${j.error || `HTTP ${r.status}`}`);
    } finally {
      setBusy(false);
    }
  };

  const add = (status: Item["status"]) => {
    setItems((cur) => [...cur, {
      status,
      title: "",
      body: "",
      tag: "",
      section: status === "changelog" ? "Aug 2026" : "",
      sort_order: cur.filter((i) => i.status === status).length,
    }]);
  };

  const update = (idx: number, patch: Partial<Item>) => {
    setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const remove = (idx: number) => {
    setItems((cur) => cur.filter((_, i) => i !== idx));
  };

  const move = (idx: number, dir: -1 | 1) => {
    setItems((cur) => {
      const next = [...cur];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return next;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  if (loading) return (
    <div className="card text-center py-12 text-neutral-500">
      <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading roadmap…
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Superadmin"
        icon={ScrollText}
        title="Roadmap"
        subtitle="What shows on the public roadmap page. Keep it honest — visitors read this as a commitment."
        actions={
          <>
            <Link href="/roadmap" target="_blank" className="btn btn-ghost h-8 text-xs">
              <Eye className="h-3 w-3" /> Preview
            </Link>
            <button onClick={save} disabled={busy} className="btn btn-primary h-8 text-xs">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save all
            </button>
          </>
        }
      />

      {msg && <div className="card text-sm border-accent/30 bg-accent/5 text-accent">{msg}</div>}

      <div className="text-xs text-neutral-500 italic">
        Saving replaces the whole set — rows deleted here get deleted in PB. Voting persistence is deferred; the public page's Vote button is local-only for now.
      </div>

      {STATUS_ORDER.map((status) => {
        const scoped = items
          .map((it, i) => ({ it, i }))
          .filter(({ it }) => it.status === status);
        return (
          <div key={status} className="card space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{STATUS_LABEL[status]} <span className="text-neutral-500">({scoped.length})</span></div>
              <button onClick={() => add(status)} className="btn btn-ghost h-7 text-xs">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            {scoped.length === 0 && <div className="text-xs text-neutral-500">No {STATUS_LABEL[status]} items.</div>}
            {scoped.map(({ it, i }, localIdx) => (
              <div key={i} className="border border-line rounded p-3 space-y-2 relative">
                <div className="flex items-center gap-2 absolute top-2 right-2">
                  <button onClick={() => move(i, -1)}
                          disabled={localIdx === 0}
                          className="text-neutral-500 hover:text-white disabled:opacity-30" title="Move up">
                    <GripVertical className="h-3 w-3" />
                  </button>
                  <button onClick={() => remove(i)}
                          className="text-neutral-500 hover:text-red-300">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <input className="input" placeholder="Title"
                       value={it.title} onChange={(e) => update(i, { title: e.target.value })} />
                <textarea className="input" rows={2} placeholder="Body / description"
                          value={it.body} onChange={(e) => update(i, { body: e.target.value })} />
                <div className="grid grid-cols-2 gap-2">
                  <input className="input h-9" placeholder="Tag (Q3 2026 / v3.0 / etc)"
                         value={it.tag || ""} onChange={(e) => update(i, { tag: e.target.value })} />
                  {status === "changelog" ? (
                    <input className="input h-9" placeholder="Section (August 2026)"
                           value={it.section || ""} onChange={(e) => update(i, { section: e.target.value })} />
                  ) : (
                    <input className="input h-9" placeholder="Sort order (lower = higher)"
                           type="number"
                           value={it.sort_order ?? 0} onChange={(e) => update(i, { sort_order: Number(e.target.value) || 0 })} />
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

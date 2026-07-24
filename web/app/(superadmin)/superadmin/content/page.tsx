"use client";

import { useEffect, useState } from "react";
import { LayoutTemplate, Loader2, Save, Eye, Plus, X } from "lucide-react";
import Link from "next/link";

/**
 * Superadmin landing-content editor. Feeds the SSR read at /
 * (revalidates within 60s). No fine-grained per-block preview —
 * the "Preview" button just opens the live landing page in a new tab.
 */

type Feature = { title: string; body: string };
type Tier = { name: string; price: string; sub?: string; features?: string[]; highlight?: boolean };

type Content = {
  hero_title: string;
  hero_sub: string;
  hero_cta_text: string;
  hero_cta_href: string;
  features: Feature[];
  pricing_tiers: Tier[];
  footer_links: Array<{ label: string; href: string }>;
};

const EMPTY: Content = {
  hero_title: "",
  hero_sub: "",
  hero_cta_text: "Request access",
  hero_cta_href: "/signup",
  features: [],
  pricing_tiers: [],
  footer_links: [],
};

export default function ContentEditor() {
  const [c, setC] = useState<Content>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/superadmin/content");
        if (r.ok) {
          const d = await r.json();
          setC({ ...EMPTY, ...d, features: d.features || [], pricing_tiers: d.pricing_tiers || [], footer_links: d.footer_links || [] });
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/superadmin/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setMsg("Saved. Landing page will pick this up within ~60s.");
      else setMsg(`Error: ${j.error || `HTTP ${r.status}`}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return (
    <div className="card text-center py-12 text-neutral-500">
      <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading content…
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <LayoutTemplate className="h-5 w-5 text-accent" /> Landing content
        </h1>
        <div className="flex gap-2">
          <Link href="/" target="_blank" className="btn btn-ghost h-8 text-xs">
            <Eye className="h-3 w-3" /> Preview
          </Link>
          <button onClick={save} disabled={busy} className="btn btn-primary h-8 text-xs">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </button>
        </div>
      </div>

      {msg && <div className="card text-sm border-accent/30 bg-accent/5 text-accent">{msg}</div>}

      {/* Hero */}
      <div className="card space-y-3">
        <div className="text-sm font-medium">Hero</div>
        <div>
          <label className="label">Title</label>
          <input className="input" value={c.hero_title} onChange={(e) => setC({ ...c, hero_title: e.target.value })} />
        </div>
        <div>
          <label className="label">Subtitle</label>
          <textarea className="input" rows={2} value={c.hero_sub} onChange={(e) => setC({ ...c, hero_sub: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">CTA text</label>
            <input className="input" value={c.hero_cta_text} onChange={(e) => setC({ ...c, hero_cta_text: e.target.value })} />
          </div>
          <div>
            <label className="label">CTA link</label>
            <input className="input" value={c.hero_cta_href} onChange={(e) => setC({ ...c, hero_cta_href: e.target.value })} />
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Features</div>
          <button onClick={() => setC({ ...c, features: [...c.features, { title: "", body: "" }] })}
                  className="btn btn-ghost h-7 text-xs"><Plus className="h-3 w-3" /> Add</button>
        </div>
        {c.features.length === 0 && <div className="text-xs text-neutral-500">No features yet.</div>}
        {c.features.map((f, i) => (
          <div key={i} className="border border-line rounded p-3 space-y-2 relative">
            <button onClick={() => setC({ ...c, features: c.features.filter((_, j) => j !== i) })}
                    className="absolute top-2 right-2 text-neutral-500 hover:text-red-300">
              <X className="h-3 w-3" />
            </button>
            <input className="input" placeholder="Title"
                   value={f.title} onChange={(e) => {
              const next = [...c.features]; next[i] = { ...f, title: e.target.value };
              setC({ ...c, features: next });
            }} />
            <textarea className="input" rows={2} placeholder="Body"
                      value={f.body} onChange={(e) => {
              const next = [...c.features]; next[i] = { ...f, body: e.target.value };
              setC({ ...c, features: next });
            }} />
          </div>
        ))}
      </div>

      {/* Pricing tiers */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Pricing tiers</div>
          <button onClick={() => setC({ ...c, pricing_tiers: [...c.pricing_tiers, { name: "", price: "", features: [] }] })}
                  className="btn btn-ghost h-7 text-xs"><Plus className="h-3 w-3" /> Add tier</button>
        </div>
        {c.pricing_tiers.length === 0 && <div className="text-xs text-neutral-500">No pricing tiers yet. Add one to have them render on the landing.</div>}
        {c.pricing_tiers.map((t, i) => (
          <div key={i} className="border border-line rounded p-3 space-y-2 relative">
            <button onClick={() => setC({ ...c, pricing_tiers: c.pricing_tiers.filter((_, j) => j !== i) })}
                    className="absolute top-2 right-2 text-neutral-500 hover:text-red-300">
              <X className="h-3 w-3" />
            </button>
            <div className="grid grid-cols-2 gap-2">
              <input className="input" placeholder="Name (e.g. Free)" value={t.name}
                     onChange={(e) => {
                       const next = [...c.pricing_tiers]; next[i] = { ...t, name: e.target.value };
                       setC({ ...c, pricing_tiers: next });
                     }} />
              <input className="input" placeholder="Price (e.g. $0/mo)" value={t.price}
                     onChange={(e) => {
                       const next = [...c.pricing_tiers]; next[i] = { ...t, price: e.target.value };
                       setC({ ...c, pricing_tiers: next });
                     }} />
            </div>
            <input className="input" placeholder="Sub (e.g. BYO Kaggle worker)"
                   value={t.sub || ""} onChange={(e) => {
              const next = [...c.pricing_tiers]; next[i] = { ...t, sub: e.target.value };
              setC({ ...c, pricing_tiers: next });
            }} />
            <textarea className="input" rows={3}
                      placeholder="Features (one per line)"
                      value={(t.features || []).join("\n")}
                      onChange={(e) => {
                        const next = [...c.pricing_tiers];
                        next[i] = { ...t, features: e.target.value.split("\n").filter(Boolean) };
                        setC({ ...c, pricing_tiers: next });
                      }} />
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!t.highlight} onChange={(e) => {
                const next = [...c.pricing_tiers]; next[i] = { ...t, highlight: e.target.checked };
                setC({ ...c, pricing_tiers: next });
              }} />
              Highlight this tier (accent border)
            </label>
          </div>
        ))}
      </div>

      {/* Footer links */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Footer links</div>
          <button onClick={() => setC({ ...c, footer_links: [...c.footer_links, { label: "", href: "" }] })}
                  className="btn btn-ghost h-7 text-xs"><Plus className="h-3 w-3" /> Add</button>
        </div>
        {c.footer_links.length === 0 && <div className="text-xs text-neutral-500">No footer links yet.</div>}
        {c.footer_links.map((l, i) => (
          <div key={i} className="flex gap-2">
            <input className="input flex-1" placeholder="Label" value={l.label}
                   onChange={(e) => {
                     const next = [...c.footer_links]; next[i] = { ...l, label: e.target.value };
                     setC({ ...c, footer_links: next });
                   }} />
            <input className="input flex-1" placeholder="URL" value={l.href}
                   onChange={(e) => {
                     const next = [...c.footer_links]; next[i] = { ...l, href: e.target.value };
                     setC({ ...c, footer_links: next });
                   }} />
            <button onClick={() => setC({ ...c, footer_links: c.footer_links.filter((_, j) => j !== i) })}
                    className="btn btn-ghost h-9 px-2">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

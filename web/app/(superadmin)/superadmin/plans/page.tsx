"use client";

import { useEffect, useState } from "react";
import { Package, Plus, X, Save, Loader2, RefreshCw, Trash2, Star } from "lucide-react";

type Plan = {
  id?: string;
  slug: string;
  name: string;
  price_monthly: number;
  price_yearly: number;
  max_channels: number;
  max_renders_month: number;
  shared_worker_access: boolean;
  features?: string;
  active: boolean;
  sort_order: number;
};

const EMPTY: Plan = {
  slug: "", name: "", price_monthly: 0, price_yearly: 0,
  max_channels: 0, max_renders_month: 0,
  shared_worker_access: false, features: "", active: true, sort_order: 100,
};

/**
 * Superadmin plans CRUD.
 *   0 in max_channels / max_renders_month = UNLIMITED (matches quota.ts).
 *   Prices are in whole cents (2000 = $20/mo).
 */
export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [newForm, setNewForm] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/superadmin/plans");
      if (r.ok) setPlans(await r.json());
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async (p: Plan, mode: "create" | "update") => {
    setBusy(p.slug);
    try {
      const url = mode === "create" ? "/api/superadmin/plans" : `/api/superadmin/plans/${p.slug}`;
      const method = mode === "create" ? "POST" : "PUT";
      const r = await fetch(url, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(p),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setEditing(null); setNewForm(false);
        await load();
      } else {
        alert(`Failed: ${j.error || `HTTP ${r.status}`}`);
      }
    } finally { setBusy(null); }
  };

  const remove = async (slug: string) => {
    if (!confirm(`Delete plan '${slug}'? Users assigned to it must be reassigned first.`)) return;
    setBusy(slug);
    try {
      const r = await fetch(`/api/superadmin/plans/${slug}`, { method: "DELETE" });
      if (r.ok) await load();
      else { const j = await r.json().catch(() => ({})); alert(`Failed: ${j.error || `HTTP ${r.status}`}`); }
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Package className="h-5 w-5 text-accent" /> Plans
        </h1>
        <div className="flex gap-2">
          <button onClick={load} className="btn btn-ghost h-8 text-xs">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </button>
          <button onClick={() => setNewForm(true)} className="btn btn-primary h-8 text-xs">
            <Plus className="h-3 w-3" /> New plan
          </button>
        </div>
      </div>

      <p className="text-xs text-neutral-500">
        Prices are integers in cents (2000 = $20). Set <code className="px-1 rounded bg-bg-2">max_channels</code> or{" "}
        <code className="px-1 rounded bg-bg-2">max_renders_month</code> to <b>0</b> for unlimited.
        The <b>founder</b> plan (yours) is unlimited and unbypassable.
      </p>

      {newForm && (
        <PlanForm initial={EMPTY} isNew onSave={(p) => save(p, "create")}
                  onCancel={() => setNewForm(false)} busy={busy === EMPTY.slug} />
      )}

      {loading && plans.length === 0 ? (
        <div className="card text-center py-12 text-neutral-500">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading plans…
        </div>
      ) : (
        <div className="space-y-3">
          {plans.map((p) => editing?.slug === p.slug ? (
            <PlanForm key={p.slug} initial={p} onSave={(np) => save(np, "update")}
                      onCancel={() => setEditing(null)} busy={busy === p.slug} />
          ) : (
            <div key={p.slug} className="card space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Package className="h-5 w-5 text-accent" />
                  <div>
                    <div className="font-medium flex items-center gap-2">
                      {p.name} <span className="text-xs text-neutral-500 font-mono">{p.slug}</span>
                      {p.slug === "founder" && <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300"><Star className="inline h-2.5 w-2.5" /> founder</span>}
                      {!p.active && <span className="text-[10px] px-1.5 py-0.5 rounded border border-neutral-600 text-neutral-500">inactive</span>}
                    </div>
                    <div className="text-xs text-neutral-500">
                      ${(p.price_monthly / 100).toFixed(2)}/mo &nbsp;·&nbsp;
                      channels: {p.max_channels || "∞"} &nbsp;·&nbsp;
                      renders/mo: {p.max_renders_month || "∞"} &nbsp;·&nbsp;
                      {p.shared_worker_access ? "shared pool ✓" : "BYO only"}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditing(p)} className="btn btn-ghost h-7 text-xs">Edit</button>
                  {p.slug !== "founder" && (
                    <button onClick={() => remove(p.slug)}
                            disabled={busy === p.slug}
                            className="btn h-7 text-xs border-red-500/40 bg-red-500/5 text-red-300">
                      {busy === p.slug ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {plans.length === 0 && !loading && (
            <div className="card text-center py-8 text-neutral-500">No plans defined yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

function PlanForm({
  initial, isNew, onSave, onCancel, busy,
}: {
  initial: Plan; isNew?: boolean; onSave: (p: Plan) => void; onCancel: () => void; busy: boolean;
}) {
  const [p, setP] = useState<Plan>({ ...initial, features: initial.features || "" });
  return (
    <div className="card space-y-3 border-accent/40">
      <div className="text-sm font-medium">{isNew ? "New plan" : `Edit ${initial.slug}`}</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Slug (permanent, url-safe)</label>
          <input className="input font-mono" value={p.slug}
                 disabled={!isNew}
                 onChange={(e) => setP({ ...p, slug: e.target.value.toLowerCase() })} />
        </div>
        <div>
          <label className="label">Display name</label>
          <input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </div>
        <div>
          <label className="label">Monthly price (cents)</label>
          <input className="input font-mono" type="number" value={p.price_monthly}
                 onChange={(e) => setP({ ...p, price_monthly: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">Yearly price (cents)</label>
          <input className="input font-mono" type="number" value={p.price_yearly}
                 onChange={(e) => setP({ ...p, price_yearly: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">Max channels (0 = ∞)</label>
          <input className="input font-mono" type="number" value={p.max_channels}
                 onChange={(e) => setP({ ...p, max_channels: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">Max renders / month (0 = ∞)</label>
          <input className="input font-mono" type="number" value={p.max_renders_month}
                 onChange={(e) => setP({ ...p, max_renders_month: Number(e.target.value) })} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={p.shared_worker_access}
               onChange={(e) => setP({ ...p, shared_worker_access: e.target.checked })} />
        Shared worker access (paid users share Oracle + your Kaggle when idle)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={p.active}
               onChange={(e) => setP({ ...p, active: e.target.checked })} />
        Active (uncheck to hide from public signup pricing table)
      </label>
      <div>
        <label className="label">Sort order (lower = shown first)</label>
        <input className="input font-mono" type="number" value={p.sort_order}
               onChange={(e) => setP({ ...p, sort_order: Number(e.target.value) })} />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn btn-ghost h-8 text-xs">
          <X className="h-3 w-3" /> Cancel
        </button>
        <button onClick={() => onSave(p)} disabled={busy || !p.slug || !p.name}
                className="btn btn-primary h-8 text-xs">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Save
        </button>
      </div>
    </div>
  );
}

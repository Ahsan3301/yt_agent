"use client";

import { useEffect, useState } from "react";
import { Flag, Loader2, RefreshCw, Save, AlertTriangle } from "lucide-react";
import clsx from "clsx";

/**
 * Superadmin feature-flag toggler.
 *
 * Reads/writes settings/ktt7sdazit7wnsk (the flag singleton created
 * by migration 0016). Every toggle here changes SaaS-wide behaviour
 * live — the 30s cache in web/lib/flags.ts is busted on every save,
 * so gated code paths pick up the new value on the very next request.
 *
 * The blurb next to each toggle names the concrete effect so the
 * operator sees the blast radius before flipping.
 */

type Flags = {
  auth_v2_enabled: boolean;
  tenant_filter_enforced: boolean;
  signup_open: boolean;
  quotas_enforced: boolean;
  shared_pool_enabled: boolean;
  landing_cms_enabled: boolean;
};

const FLAG_META: Array<{
  key: keyof Flags;
  label: string;
  effect: string;
  danger?: boolean;
}> = [
  {
    key: "auth_v2_enabled",
    label: "Auth v2 enabled",
    effect: "Enables the email+password login path. Currently ON. Turning off falls back to the master-password-only mode — do NOT turn off unless you've re-set DASHBOARD_PASSWORD and know it works.",
  },
  {
    key: "tenant_filter_enforced",
    label: "Tenant filtering enforced",
    effect: "Every non-superadmin API call filters by user_id and cross-tenant .get()s return 404. Turn on ONLY after Phase 2b completes all remaining routes — flipping now would break the 20 unpatched routes.",
    danger: true,
  },
  {
    key: "signup_open",
    label: "Public signups open",
    effect: "Anyone hitting /signup can register (they land as status='pending' and need admin approval before they can log in).",
  },
  {
    key: "quotas_enforced",
    label: "Plan quotas enforced",
    effect: "requirePlanQuota() actually enforces max_channels + max_renders_month against the caller's plan. Superadmin + founder plan always bypass.",
  },
  {
    key: "shared_pool_enabled",
    label: "Shared worker pool enabled",
    effect: "Paid-tier users' jobs can be claimed by shared workers (Oracle side-worker, your Kaggle). Off = every job routes only to its owner's own workers.",
  },
  {
    key: "landing_cms_enabled",
    label: "Landing CMS active",
    effect: "Landing page reads live from landing_content instead of the hardcoded defaults. Off = defaults always shown (safety switch if the CMS row is corrupted).",
  },
];

export default function FlagsPage() {
  const [flags, setFlags] = useState<Flags | null>(null);
  const [pending, setPending] = useState<Partial<Flags>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/superadmin/flags");
      if (r.ok) { setFlags(await r.json()); setPending({}); }
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const effective = { ...flags, ...pending } as Flags | null;
  const dirty = Object.keys(pending).length > 0;

  const save = async () => {
    if (!dirty) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/superadmin/flags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setFlags(j.flags);
        setPending({});
        const changed = Object.keys(j.changed || {});
        setMsg(changed.length > 0
          ? `Saved. Changed: ${changed.join(", ")}. Effective within ~30s.`
          : "No effective change.");
      } else {
        setMsg(`Failed: ${j.error || `HTTP ${r.status}`}`);
      }
    } finally { setBusy(false); }
  };

  if (loading || !flags) return (
    <div className="card text-center py-12 text-neutral-500">
      <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading flags…
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Flag className="h-5 w-5 text-accent" /> Feature flags
        </h1>
        <div className="flex gap-2">
          <button onClick={load} className="btn btn-ghost h-8 text-xs">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          <button onClick={save} disabled={!dirty || busy}
                  className="btn btn-primary h-8 text-xs">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            {dirty ? `Save ${Object.keys(pending).length} change(s)` : "Saved"}
          </button>
        </div>
      </div>

      {msg && <div className="card text-sm border-accent/30 bg-accent/5 text-accent">{msg}</div>}

      <div className="space-y-2">
        {FLAG_META.map(({ key, label, effect, danger }) => {
          const current = Boolean(flags[key]);
          const upcoming = Boolean(effective![key]);
          const changed = current !== upcoming;
          return (
            <div key={key}
                 className={clsx(
                   "card space-y-2",
                   changed && "border-amber-500/40",
                 )}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-sm">{label}</div>
                    <code className="text-[10px] text-neutral-500 px-1 rounded bg-bg-2">{key}</code>
                    {danger && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/5 text-red-300">
                        <AlertTriangle className="h-2.5 w-2.5" /> risky
                      </span>
                    )}
                    {changed && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
                        pending: {upcoming ? "on" : "off"}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500 mt-1 max-w-2xl">{effect}</div>
                </div>
                <button
                  onClick={() => setPending((prev) => {
                    const next = { ...prev };
                    if (next[key] === !current) delete next[key];  // toggle back = clear diff
                    else next[key] = !upcoming;
                    return next;
                  })}
                  className={clsx(
                    "shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                    upcoming ? "bg-accent" : "bg-neutral-700",
                  )}
                  aria-pressed={upcoming}
                >
                  <span className={clsx(
                    "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
                    upcoming ? "translate-x-6" : "translate-x-1",
                  )} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

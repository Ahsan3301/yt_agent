"use client";

import { useEffect, useState } from "react";
import { Users, CheckCircle2, XCircle, Ban, Loader2, RefreshCw, User, Crown, Shield } from "lucide-react";
import clsx from "clsx";
import { PageHeader } from "@/components/PageHeader";

type AppUser = {
  id: string;
  email: string;
  role: "user" | "admin" | "superadmin";
  status: "pending" | "active" | "suspended";
  plan_id: string;
  plan_expires_at?: number;
  plan_note?: string;
  has_kaggle_key: boolean;
  kaggle_username: string;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number | null;
  last_login_at: number | null;
};

type Filter = "pending" | "active" | "suspended" | "all";

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [plans, setPlans] = useState<{ slug: string; name: string }[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const url = filter === "all" ? "/api/admin/users" : `/api/admin/users?status=${filter}`;
      const [ru, rp] = await Promise.all([
        fetch(url),
        fetch("/api/superadmin/plans"),  // 403s harmlessly for non-superadmin
      ]);
      if (ru.ok) setUsers(await ru.json());
      if (rp.ok) setPlans(await rp.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  // Manual billing: assigning a paid plan without a term means it
  // never lapses, and with no payment provider nothing else will
  // catch that. So a paid plan prompts for how long was paid for.
  const changePlan = async (u: AppUser, planId: string) => {
    if (planId === u.plan_id) return;
    let months = 0;
    let note = "";
    if (planId !== "free" && planId !== "founder") {
      const answer = window.prompt(
        `How many months has ${u.email} paid for?

` +
        `Leave blank for no expiry (comped / indefinite).`,
        "1",
      );
      if (answer === null) return;            // cancelled
      months = parseInt(answer, 10) || 0;
      note = window.prompt(
        "Payment note (optional) — e.g. 'PKR 8000, bank transfer'",
        "",
      ) || "";
    }
    setBusy(u.id);
    try {
      const r = await fetch(`/api/admin/users/${u.id}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId, months, note }),
      });
      if (r.ok) await load();
      else { const j = await r.json().catch(() => ({})); alert(`Failed: ${j.error || `HTTP ${r.status}`}`); }
    } finally { setBusy(null); }
  };

  const doAction = async (u: AppUser, action: "approve" | "suspend" | "reject") => {
    setBusy(u.id);
    try {
      const method = action === "reject" ? "DELETE" : "POST";
      const r = await fetch(`/api/admin/users/${u.id}/${action}`, { method });
      if (r.ok) {
        await load();
      } else {
        const j = await r.json().catch(() => ({}));
        alert(`Failed: ${j.error || `HTTP ${r.status}`}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const counts = users.reduce((acc, u) => { acc[u.status] = (acc[u.status] || 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operator"
        icon={Users}
        title="Users"
        subtitle="Approve, suspend, and manage signups."
        actions={
          <button onClick={load} className="btn btn-ghost h-8 text-xs">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </button>
        }
      />

      <div className="flex flex-wrap gap-1.5">
        {(["pending", "active", "suspended", "all"] as Filter[]).map((f) => (
          <button key={f}
                  onClick={() => setFilter(f)}
                  className={clsx(
                    "btn h-7 text-xs capitalize",
                    filter === f ? "border-accent/50 bg-accent/15 text-accent" : "btn-ghost",
                  )}>
            {f} {counts[f] != null && <span className="opacity-60">({counts[f]})</span>}
          </button>
        ))}
      </div>

      {loading && users.length === 0 ? (
        <div className="card text-center py-12 text-neutral-500">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading users…
        </div>
      ) : users.length === 0 ? (
        <div className="card text-center py-12 text-neutral-500">
          No {filter === "all" ? "" : filter} users.
          {filter === "pending" && " Nothing waiting for approval."}
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-bg-2/40">
              <tr className="text-left text-xs text-neutral-500">
                <th className="px-3 py-2">Email</th>
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Plan</th>
                <th className="px-2 py-2">Paid until</th>
                <th className="px-2 py-2">Kaggle</th>
                <th className="px-2 py-2">Created</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-line hover:bg-bg-2/30">
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs">{u.email}</div>
                    <div className="text-[10px] text-neutral-500 font-mono">{u.id}</div>
                  </td>
                  <td className="px-2 py-2">
                    <RolePill role={u.role} />
                  </td>
                  <td className="px-2 py-2">
                    <StatusPill status={u.status} />
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {plans.length > 0 ? (
                      <select value={u.plan_id || ""}
                              disabled={busy === u.id || u.role === "superadmin"}
                              onChange={(e) => changePlan(u, e.target.value)}
                              className="input h-7 text-xs py-0 w-24">
                        {!plans.some((p) => p.slug === u.plan_id) && u.plan_id && (
                          <option value={u.plan_id}>{u.plan_id}</option>
                        )}
                        {plans.map((p) => (
                          <option key={p.slug} value={p.slug}>{p.name || p.slug}</option>
                        ))}
                      </select>
                    ) : (
                      <span>{u.plan_id || "—"}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    <PlanTerm expiresAt={u.plan_expires_at} planId={u.plan_id} note={u.plan_note} />
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {u.has_kaggle_key ? (
                      <span className="text-emerald-300">{u.kaggle_username}</span>
                    ) : (
                      <span className="text-neutral-500">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs text-neutral-500">{fmtAge(u.created_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      {u.status === "pending" && (
                        <>
                          <button onClick={() => doAction(u, "approve")}
                                  disabled={busy === u.id}
                                  className="btn h-7 text-xs border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                            {busy === u.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                            Approve
                          </button>
                          <button onClick={() => doAction(u, "reject")}
                                  disabled={busy === u.id}
                                  className="btn h-7 text-xs border-red-500/40 bg-red-500/5 text-red-300">
                            <XCircle className="h-3 w-3" /> Reject
                          </button>
                        </>
                      )}
                      {u.status === "active" && u.role !== "superadmin" && (
                        <button onClick={() => doAction(u, "suspend")}
                                disabled={busy === u.id}
                                className="btn h-7 text-xs border-amber-500/40 bg-amber-500/10 text-amber-300">
                          {busy === u.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
                          Suspend
                        </button>
                      )}
                      {u.status === "suspended" && (
                        <button onClick={() => doAction(u, "approve")}
                                disabled={busy === u.id}
                                className="btn h-7 text-xs border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                          {busy === u.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                          Reinstate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RolePill({ role }: { role: string }) {
  const Icon = role === "superadmin" ? Crown : role === "admin" ? Shield : User;
  const cls = role === "superadmin" ? "text-amber-300 border-amber-500/40 bg-amber-500/10" :
              role === "admin"      ? "text-sky-300 border-sky-500/40 bg-sky-500/10" :
                                       "text-neutral-400 border-line bg-bg-2/50";
  return <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>
    <Icon className="h-3 w-3" /> {role}
  </span>;
}

function StatusPill({ status }: { status: string }) {
  const cls = status === "active"    ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" :
              status === "pending"   ? "text-amber-300 border-amber-500/40 bg-amber-500/10" :
              status === "suspended" ? "text-red-300 border-red-500/40 bg-red-500/5" :
                                        "text-neutral-400 border-line";
  return <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{status}</span>;
}

function fmtAge(sec: number | null): string {
  if (!sec) return "—";
  const now = Math.floor(Date.now() / 1000);
  const delta = now - sec;
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta/60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta/3600)}h ago`;
  return `${Math.floor(delta/86400)}d ago`;
}

/** Remaining paid term.
 *
 *  Free and founder legitimately have no expiry. A PAID plan with no
 *  expiry is flagged, because with manual billing nothing else will
 *  ever revoke it — that's an account being served indefinitely off
 *  one payment. */
function PlanTerm({
  expiresAt, planId, note,
}: { expiresAt?: number; planId?: string; note?: string }) {
  const isPaid = planId && planId !== "free" && planId !== "founder";
  if (!isPaid) return <span className="text-neutral-600">—</span>;

  if (!expiresAt) {
    return (
      <span className="pill pill-warn" title="No end date — this will never lapse on its own.">
        no expiry
      </span>
    );
  }

  const days = Math.ceil((expiresAt - Date.now() / 1000) / 86400);
  const when = new Date(expiresAt * 1000).toISOString().slice(0, 10);

  if (days < 0) {
    return <span className="pill pill-danger" title={note || ""}>expired {when}</span>;
  }
  if (days <= 7) {
    return <span className="pill pill-warn" title={note || ""}>{days}d left</span>;
  }
  return (
    <span className="text-neutral-400" title={note || ""}>
      {when} <span className="text-neutral-600">({days}d)</span>
    </span>
  );
}

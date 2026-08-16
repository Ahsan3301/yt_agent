"use client";

import { useEffect, useState } from "react";

/**
 * Quota request triage.
 *
 * Approving here is what actually moves a limit — the user-facing route
 * only records the ask. Each row is approvable AS ASKED or amended, so
 * granting 2 of a requested 3 channels takes one edit rather than a
 * trip to the database.
 *
 * Decided requests are shown too, not just pending: the value of a
 * ledger is being able to see what was handed out, and a queue that
 * empties itself on decision hides exactly that.
 */

type Req = {
  id: string; user_id: string; email?: string; status: string;
  want_channels?: number; want_videos_per_day?: number; want_days?: number;
  granted_channels?: number; granted_videos_per_day?: number; granted_days?: number;
  reason?: string; note?: string; created_at?: string; decided_at?: number;
};

export default function QuotaRequestsPage() {
  const [rows, setRows] = useState<Req[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, { ch: string; vd: string; d: string }>>({});

  const load = async () => {
    try {
      const r = await fetch("/api/admin/quota-requests");
      const d = await r.json();
      if (d?.ok) setRows(d.requests || []);
      else setErr(d?.error || "Could not load requests.");
    } catch { setErr("Network error."); }
  };
  useEffect(() => { load(); }, []);

  const decide = async (row: Req, action: "approve" | "deny") => {
    setBusy(row.id); setErr(null);
    const e = edit[row.id];
    try {
      const r = await fetch("/api/admin/quota-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: row.id, action,
          ...(action === "approve" && e ? {
            granted_channels: Number(e.ch) || undefined,
            granted_videos_per_day: Number(e.vd) || undefined,
            granted_days: Number(e.d) || undefined,
          } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d?.error || "Failed.");
      await load();
    } catch { setErr("Network error."); }
    finally { setBusy(null); }
  };

  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-white">Quota requests</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Approving writes the granted values straight onto the account. Leave a
          field blank to grant exactly what was asked.
        </p>
      </div>

      {err && <div className="card border-red-500/30 bg-red-500/[0.05] text-sm text-red-300">{err}</div>}

      <section>
        <h2 className="text-sm font-semibold text-neutral-300 mb-3">
          Pending {pending.length > 0 && <span className="text-amber-300">({pending.length})</span>}
        </h2>
        {pending.length === 0 && <p className="text-sm text-neutral-500">Nothing waiting.</p>}
        <div className="space-y-3">
          {pending.map((r) => {
            const e = edit[r.id] || { ch: "", vd: "", d: "" };
            return (
              <div key={r.id} className="card space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-white">{r.email || r.user_id}</span>
                  <span className="text-xs text-neutral-500 font-mono">{r.user_id}</span>
                </div>
                <div className="text-sm text-neutral-300">
                  Asked for:{" "}
                  {[r.want_channels && `${r.want_channels} channel(s)`,
                    r.want_videos_per_day && `${r.want_videos_per_day} video(s)/day`,
                    r.want_days && `${r.want_days} day(s)`].filter(Boolean).join(" · ") || "—"}
                </div>
                {r.reason && <p className="text-sm text-neutral-400 italic">“{r.reason}”</p>}
                <div className="grid gap-2 sm:grid-cols-3">
                  {(["ch", "vd", "d"] as const).map((k) => (
                    <input key={k} type="number" min="0" className="input h-9 text-sm"
                      placeholder={k === "ch" ? "grant channels" : k === "vd" ? "grant videos/day" : "grant days"}
                      value={e[k]}
                      onChange={(ev) => setEdit({ ...edit, [r.id]: { ...e, [k]: ev.target.value } })} />
                  ))}
                </div>
                <div className="flex gap-2">
                  <button disabled={busy === r.id} onClick={() => decide(r, "approve")}
                          className="btn btn-primary h-9 text-xs disabled:opacity-50">
                    {busy === r.id ? "Working…" : "Approve"}
                  </button>
                  <button disabled={busy === r.id} onClick={() => decide(r, "deny")}
                          className="btn h-9 text-xs disabled:opacity-50">Deny</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {decided.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-neutral-300 mb-3">Decided</h2>
          <div className="space-y-2">
            {decided.map((r) => (
              <div key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm border border-white/8 rounded-lg px-3.5 py-2.5">
                <span className="text-neutral-300">{r.email || r.user_id}</span>
                <span className={r.status === "approved" ? "text-emerald-300" : "text-neutral-500"}>
                  {r.status}
                  {r.status === "approved" && (
                    <span className="text-neutral-500">
                      {" "}· {[r.granted_channels && `${r.granted_channels} ch`,
                              r.granted_videos_per_day && `${r.granted_videos_per_day}/day`,
                              r.granted_days && `${r.granted_days}d`].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

"use client";

import { Fragment, useEffect, useState } from "react";
import { ScrollText, Loader2, RefreshCw, Filter } from "lucide-react";
import clsx from "clsx";

type Entry = {
  id: string;
  ts: number;
  actor_user_id: string;
  impersonated_user_id?: string;
  action: string;
  target_type: string;
  target_id: string;
  meta?: Record<string, unknown>;
  ip?: string;
  user_agent?: string;
};

/**
 * Read-only audit log viewer. Every user-state change, plan edit,
 * content save, and flag toggle lands here via web/lib/audit.ts.
 * Filters keep the tail scannable — no full-text search yet
 * (a Phase 7-ish enhancement).
 */
export default function AuditPage() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [actionFilter, setActionFilter] = useState<string>("");
  const [actorFilter, setActorFilter] = useState<string>("");

  const load = async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (actionFilter) p.set("action", actionFilter);
      if (actorFilter)  p.set("actor",  actorFilter);
      p.set("limit", "200");
      const r = await fetch("/api/superadmin/audit?" + p.toString());
      if (r.ok) setRows(await r.json());
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actionFilter, actorFilter]);

  const uniqueActions = Array.from(new Set(rows.map((r) => r.action))).sort();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-accent" /> Audit log
        </h1>
        <button onClick={load} className="btn btn-ghost h-8 text-xs">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Filter className="h-3 w-3 text-neutral-500" />
        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}
                className="input h-8 text-xs py-0 w-56">
          <option value="">All actions</option>
          {uniqueActions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input placeholder="filter by actor user id"
               className="input h-8 text-xs py-0 w-64 font-mono"
               value={actorFilter}
               onChange={(e) => setActorFilter(e.target.value)} />
        {(actionFilter || actorFilter) && (
          <button onClick={() => { setActionFilter(""); setActorFilter(""); }}
                  className="btn btn-ghost h-8 text-xs">Clear</button>
        )}
      </div>

      {loading && rows.length === 0 ? (
        <div className="card text-center py-12 text-neutral-500">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-8 text-neutral-500">
          No audit entries {actionFilter || actorFilter ? "match the current filters" : "yet"}.
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-line bg-bg-2/40">
              <tr className="text-left text-[10px] text-neutral-500 uppercase tracking-wider">
                <th className="px-3 py-2">When</th>
                <th className="px-2 py-2">Actor</th>
                <th className="px-2 py-2">Action</th>
                <th className="px-2 py-2">Target</th>
                <th className="px-3 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr className="border-t border-line hover:bg-bg-2/30 cursor-pointer"
                      onClick={() => setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(e.id)) next.delete(e.id); else next.add(e.id);
                        return next;
                      })}>
                    <td className="px-3 py-2 whitespace-nowrap text-neutral-400">{fmtTs(e.ts)}</td>
                    <td className="px-2 py-2 font-mono">
                      {shortId(e.actor_user_id)}
                      {e.impersonated_user_id && (
                        <span className="ml-1 text-amber-300">→ {shortId(e.impersonated_user_id)}</span>
                      )}
                    </td>
                    <td className="px-2 py-2"><ActionPill action={e.action} /></td>
                    <td className="px-2 py-2">
                      <span className="text-neutral-500">{e.target_type}/</span>
                      <span className="font-mono">{shortId(e.target_id)}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-500">
                      {expanded.has(e.id) ? "▾" : "▸"}
                    </td>
                  </tr>
                  {expanded.has(e.id) && (
                    <tr className="bg-bg-2/20">
                      <td colSpan={5} className="px-3 py-2 space-y-1">
                        <div className="text-[10px] text-neutral-500 uppercase tracking-wider">meta</div>
                        <pre className="text-[10px] overflow-x-auto font-mono">{JSON.stringify(e.meta || {}, null, 2)}</pre>
                        {(e.ip || e.user_agent) && (
                          <div className="text-[10px] text-neutral-500 pt-1">
                            {e.ip && <>ip: <code className="font-mono">{e.ip}</code>&nbsp;·&nbsp;</>}
                            {e.user_agent && <>ua: <code className="font-mono truncate max-w-md inline-block align-bottom">{e.user_agent}</code></>}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtTs(sec: number): string {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}
function shortId(s: string | undefined): string {
  if (!s) return "—";
  return s.length > 14 ? s.slice(0, 14) + "…" : s;
}
function ActionPill({ action }: { action: string }) {
  const [family] = action.split(".");
  const cls =
    family === "user"    ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" :
    family === "plan"    ? "text-sky-300 border-sky-500/40 bg-sky-500/10" :
    family === "content" ? "text-amber-300 border-amber-500/40 bg-amber-500/10" :
    family === "flags"   ? "text-red-300 border-red-500/40 bg-red-500/5" :
                           "text-neutral-400 border-line";
  return <span className={clsx("inline-flex text-[10px] px-1.5 py-0.5 rounded border font-mono", cls)}>{action}</span>;
}

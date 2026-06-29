"use client";

import { useEffect, useState, useMemo } from "react";
import clsx from "clsx";
import {
  ListChecks, Loader2, Play, Pause, Trash2, X, RefreshCcw,
  CheckCircle2, AlertCircle, Clock, Activity,
} from "lucide-react";

type Job = {
  id: string;
  status: string;
  channel?: string;
  dry_run?: boolean;
  queued_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
  percent?: number;
  current_step?: string | null;
  current_step_label?: string | null;
  backend_instance_id?: string | null;
  error?: string | null;
  run_id?: string | null;
  public_url?: string | null;
};

const STATUS_FILTERS = ["all", "queued", "running", "complete", "failed", "cancelled"] as const;
type Filter = typeof STATUS_FILTERS[number];

const STATUS_STYLES: Record<string, string> = {
  queued:    "border-amber-500/30 bg-amber-500/10 text-amber-300",
  running:   "border-sky-500/30 bg-sky-500/10 text-sky-300",
  complete:  "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  failed:    "border-red-500/30 bg-red-500/10 text-red-300",
  cancelled: "border-neutral-500/30 bg-neutral-500/10 text-neutral-300",
};

export default function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch("/api/jobs", { cache: "no-store" });
      const d = (await r.json()) as Job[];
      setJobs(Array.isArray(d) ? d : []);
      setLastError(null);
    } catch (e) {
      setLastError(String(e));
    }
    setLoading(false);
  };

  const refreshPause = async () => {
    try {
      const r = await fetch("/api/queue/pause", { cache: "no-store" });
      const d = await r.json();
      setPaused(!!d.paused);
    } catch {
      setPaused(false);
    }
  };

  useEffect(() => {
    refresh();
    refreshPause();
    // Backed off to 5s — matches the cache TTL on /api/jobs to avoid
    // wasted Firestore reads.
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return jobs;
    return jobs.filter((j) => j.status === filter);
  }, [jobs, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const j of jobs) c[j.status] = (c[j.status] || 0) + 1;
    c.all = jobs.length;
    return c;
  }, [jobs]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected(new Set(filtered.map((j) => j.id)));
  };
  const clearSelection = () => setSelected(new Set());

  const togglePause = async () => {
    if (paused === null) return;
    setBusyAction("pause");
    try {
      const r = await fetch("/api/queue/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !paused }),
      });
      const d = await r.json();
      setPaused(!!d.paused);
    } catch (e) {
      setLastError(String(e));
    }
    setBusyAction(null);
  };

  const bulk = async (action: "cancel" | "delete", scope: "selected" | "filter") => {
    const verb = action === "cancel" ? "Cancel" : "Delete";
    const target =
      scope === "selected"
        ? `${selected.size} selected job${selected.size === 1 ? "" : "s"}`
        : `all ${filter} jobs`;
    if (!confirm(`${verb} ${target}? This can't be undone.`)) return;
    setBusyAction(`bulk-${action}-${scope}`);
    try {
      const body: Record<string, unknown> = { action };
      if (scope === "selected") body.ids = Array.from(selected);
      else if (filter !== "all") body.filter = filter;
      const r = await fetch("/api/jobs/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) setLastError(d.error || `HTTP ${r.status}`);
      clearSelection();
      await refresh();
    } catch (e) {
      setLastError(String(e));
    }
    setBusyAction(null);
  };

  const cancelOne = async (id: string) => {
    if (!confirm(`Cancel job ${id.slice(0, 8)}…?`)) return;
    setBusyAction(`cancel-${id}`);
    try {
      await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setLastError(String(e));
    }
    setBusyAction(null);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ListChecks className="h-6 w-6 text-accent" />
            Job queue
          </h1>
          <p className="text-sm text-neutral-400 max-w-2xl">
            Every render the system has tracked. Cancel pending work,
            delete old terminal jobs, or pause the queue so no worker
            claims new jobs until you resume.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={togglePause}
            disabled={paused === null || busyAction === "pause"}
            className={clsx(
              "btn h-8 text-xs",
              paused ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "btn-ghost",
            )}
            title={paused ? "Queue is paused — click to resume" : "Pause: stop workers from claiming new queued jobs"}
          >
            {busyAction === "pause" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : paused ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            {paused === null ? "Loading…" : paused ? "Resume queue" : "Pause queue"}
          </button>
          <button onClick={refresh} className="btn btn-ghost h-8 text-xs">
            <RefreshCcw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Filter pills + bulk actions row */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => {
                setFilter(f);
                clearSelection();
              }}
              className={clsx(
                "px-2.5 h-7 rounded-md border text-xs inline-flex items-center gap-1.5",
                filter === f
                  ? "border-accent/50 bg-accent/10 text-white"
                  : "border-line text-neutral-400 hover:text-neutral-200",
              )}
            >
              {f}
              <span className="font-mono text-[10px] opacity-70">
                {counts[f] ?? 0}
              </span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {selected.size > 0 ? (
            <>
              <span className="text-xs text-neutral-400">
                {selected.size} selected
              </span>
              <button
                onClick={() => bulk("cancel", "selected")}
                disabled={!!busyAction}
                className="btn h-8 text-xs border-amber-500/40 bg-amber-500/10 text-amber-300"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
              <button
                onClick={() => bulk("delete", "selected")}
                disabled={!!busyAction}
                className="btn h-8 text-xs border-red-500/40 bg-red-500/10 text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
              <button
                onClick={clearSelection}
                className="btn btn-ghost h-8 text-xs"
              >
                Clear selection
              </button>
            </>
          ) : (
            filter !== "all" && filtered.length > 0 && (
              <>
                <button
                  onClick={selectAllFiltered}
                  className="btn btn-ghost h-8 text-xs"
                >
                  Select all
                </button>
                {(filter === "queued" || filter === "running") && (
                  <button
                    onClick={() => bulk("cancel", "filter")}
                    disabled={!!busyAction}
                    className="btn h-8 text-xs border-amber-500/40 bg-amber-500/10 text-amber-300"
                  >
                    <X className="h-3.5 w-3.5" /> Cancel all {filter}
                  </button>
                )}
                {(filter === "complete" || filter === "failed" || filter === "cancelled") && (
                  <button
                    onClick={() => bulk("delete", "filter")}
                    disabled={!!busyAction}
                    className="btn h-8 text-xs border-red-500/40 bg-red-500/10 text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete all {filter}
                  </button>
                )}
              </>
            )
          )}
        </div>
      </div>

      {lastError && (
        <div className="card border-red-500/30 bg-red-500/5 text-sm text-red-200">
          {lastError}
        </div>
      )}

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
            Loading queue…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-neutral-500">
            <ListChecks className="h-5 w-5 mx-auto mb-2 opacity-50" />
            {filter === "all" ? "Queue is empty." : `No ${filter} jobs.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-2 text-neutral-400 text-xs">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && selected.size === filtered.length}
                      onChange={() =>
                        selected.size === filtered.length
                          ? clearSelection()
                          : selectAllFiltered()
                      }
                      className="accent-accent"
                    />
                  </th>
                  <th className="text-left px-2 py-2">Job</th>
                  <th className="text-left px-2 py-2">Status</th>
                  <th className="text-left px-2 py-2">Channel</th>
                  <th className="text-left px-2 py-2">Step</th>
                  <th className="text-left px-2 py-2">Worker</th>
                  <th className="text-left px-2 py-2">Queued</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((j) => (
                  <JobRow
                    key={j.id}
                    job={j}
                    selected={selected.has(j.id)}
                    toggle={() => toggleSelected(j.id)}
                    onCancel={() => cancelOne(j.id)}
                    busy={busyAction === `cancel-${j.id}`}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({
  job, selected, toggle, onCancel, busy,
}: {
  job: Job;
  selected: boolean;
  toggle: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const canCancel = job.status === "queued" || job.status === "running";
  return (
    <tr className="border-t border-line hover:bg-bg-2/50">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={toggle}
          className="accent-accent"
        />
      </td>
      <td className="px-2 py-2">
        <div className="font-mono text-xs text-neutral-300">{job.id.slice(0, 12)}</div>
        {job.run_id && (
          <div className="font-mono text-[10px] text-neutral-500">
            run {job.run_id}
          </div>
        )}
      </td>
      <td className="px-2 py-2">
        <StatusPill status={job.status} />
        {job.percent != null && job.status === "running" && (
          <div className="text-[10px] text-neutral-500 mt-0.5 font-mono">
            {Math.round(job.percent)}%
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-neutral-300">
        {job.channel || "—"}
        {job.dry_run && (
          <span className="ml-1 text-[10px] text-neutral-500">(dry-run)</span>
        )}
      </td>
      <td className="px-2 py-2 text-xs text-neutral-400">
        {job.current_step_label || job.current_step || "—"}
      </td>
      <td className="px-2 py-2 text-xs text-neutral-500 font-mono truncate max-w-[180px]">
        {job.backend_instance_id?.slice(0, 18) || "—"}
      </td>
      <td className="px-2 py-2 text-xs text-neutral-500">{fmtAge(job.queued_at)}</td>
      <td className="px-3 py-2 text-right">
        {canCancel && (
          <button
            onClick={onCancel}
            disabled={busy}
            className="btn btn-ghost h-7 text-xs"
            title="Cancel this job"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            Cancel
          </button>
        )}
        {job.public_url && (
          <a
            href={job.public_url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost h-7 text-xs"
          >
            View
          </a>
        )}
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] || STATUS_STYLES.cancelled;
  const Icon =
    status === "complete" ? CheckCircle2 :
    status === "failed"   ? AlertCircle :
    status === "running"  ? Activity :
    status === "queued"   ? Clock :
    X;
  return (
    <span className={clsx("inline-flex items-center gap-1 px-2 h-6 rounded-md border text-xs", cls)}>
      <Icon className="h-3 w-3" />
      {status}
    </span>
  );
}

function fmtAge(epoch?: number | null): string {
  if (!epoch) return "—";
  const sec = Math.max(0, Date.now() / 1000 - epoch);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

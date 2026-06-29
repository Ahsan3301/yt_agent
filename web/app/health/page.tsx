"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  Activity, AlertCircle, CheckCircle2, Server, Loader2, RefreshCcw,
  Wifi, WifiOff, Box, AlertTriangle,
} from "lucide-react";

type WorkerCard = {
  instance_id: string;
  label: string | null;
  tier: string;
  status: string;
  gpu_name: string | null;
  url: string | null;
  last_seen: number;
  alive: boolean;
};

type ErrorEntry = {
  id: string;
  ts: number;
  class: string;
  msg: string;
  traceback: string;
  run_id: string;
  req_id: string;
  worker_label: string;
  level: string;
};

type Summary = {
  ts: number;
  workers: {
    online: number;
    gpu_alive: boolean;
    any_alive: boolean;
    cards: WorkerCard[];
  };
  jobs: {
    last_24h: {
      total: number;
      complete?: number;
      failed?: number;
      cancelled?: number;
      running?: number;
      queued?: number;
    };
    success_rate: number | null;
  };
  errors: ErrorEntry[];
  storage: {
    runs_index_count: number;
    jobs_count: number;
    errors_count: number;
  };
};

export default function HealthPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/health/summary", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || `HTTP ${r.status}`);
      } else {
        setData(d);
        setErr(null);
      }
    } catch (e) {
      setErr(String(e));
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    // Backed off to 30s — matches the /api/health/summary cache ttl
    // sweet spot. The page should feel live but not poll Firestore
    // every second.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-accent" />
            System health
          </h1>
          <p className="text-sm text-neutral-400 max-w-2xl">
            One-glance status across workers, recent jobs, errors. Auto-refreshes every 30 sec.
          </p>
        </div>
        <button onClick={refresh} disabled={loading} className="btn btn-ghost h-8 text-xs">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {err && (
        <div className="card border-red-500/30 bg-red-500/5 text-sm text-red-200">
          <AlertCircle className="inline h-4 w-4 mr-1" />
          {err}
        </div>
      )}

      {!data && !err && (
        <div className="card text-center text-neutral-500 py-10">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
          Loading…
        </div>
      )}

      {data && (
        <>
          {/* Top metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric
              label="Workers online"
              value={data.workers.online}
              tone={data.workers.online > 0 ? "good" : "warn"}
              icon={<Wifi className="h-4 w-4" />}
            />
            <Metric
              label="GPU available"
              value={data.workers.gpu_alive ? "yes" : "no"}
              tone={data.workers.gpu_alive ? "good" : "warn"}
              icon={<Server className="h-4 w-4" />}
            />
            <Metric
              label="Last 24h jobs"
              value={data.jobs.last_24h.total}
              tone="neutral"
              icon={<Box className="h-4 w-4" />}
            />
            <Metric
              label="Success rate"
              value={
                data.jobs.success_rate === null
                  ? "—"
                  : `${Math.round((data.jobs.success_rate || 0) * 100)}%`
              }
              tone={
                data.jobs.success_rate === null
                  ? "neutral"
                  : (data.jobs.success_rate || 0) > 0.8
                  ? "good"
                  : (data.jobs.success_rate || 0) > 0.5
                  ? "warn"
                  : "bad"
              }
              icon={<CheckCircle2 className="h-4 w-4" />}
            />
          </div>

          {/* Jobs breakdown */}
          <div className="card space-y-2">
            <div className="font-medium text-sm">Last 24h jobs by status</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
              <StatusCount label="complete"  value={data.jobs.last_24h.complete  || 0} cls="text-emerald-300" />
              <StatusCount label="running"   value={data.jobs.last_24h.running   || 0} cls="text-sky-300" />
              <StatusCount label="queued"    value={data.jobs.last_24h.queued    || 0} cls="text-amber-300" />
              <StatusCount label="failed"    value={data.jobs.last_24h.failed    || 0} cls="text-red-300" />
              <StatusCount label="cancelled" value={data.jobs.last_24h.cancelled || 0} cls="text-neutral-400" />
            </div>
          </div>

          {/* Workers fleet */}
          <div className="card space-y-3">
            <div className="font-medium text-sm">Worker fleet</div>
            {data.workers.cards.length === 0 ? (
              <div className="text-xs text-neutral-500">
                No workers in registry. Launch a backend from the Dashboard or click <Link href="/workers" className="text-accent">Workers</Link>.
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.workers.cards.map((w) => (
                  <div
                    key={w.instance_id}
                    className={clsx(
                      "rounded-md border px-3 py-2 flex items-center gap-2 text-xs",
                      w.alive
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-line bg-bg-2 opacity-60",
                    )}
                  >
                    {w.alive ? (
                      <Wifi className="h-3.5 w-3.5 text-emerald-300" />
                    ) : (
                      <WifiOff className="h-3.5 w-3.5 text-neutral-500" />
                    )}
                    <span className="font-medium">{w.label || w.instance_id}</span>
                    <span className={clsx(
                      "pill text-[10px]",
                      w.tier === "gpu" ? "pill-success" : "pill-info",
                    )}>
                      {w.tier?.toUpperCase()}
                    </span>
                    {w.gpu_name && (
                      <span className="pill pill-info text-[10px]">{w.gpu_name}</span>
                    )}
                    <span className="ml-auto text-[10px] text-neutral-500 font-mono">
                      last seen {fmtAge(w.last_seen)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent errors */}
          <div className="card space-y-3">
            <div className="font-medium text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-300" />
              Recent errors
              <span className="text-[10px] text-neutral-500">last 10 · {data.storage.errors_count} total stored</span>
            </div>
            {data.errors.length === 0 ? (
              <div className="text-xs text-neutral-500">
                No errors in the last 30 days. Nice.
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.errors.map((e) => (
                  <details key={e.id} className="rounded-md border border-line bg-bg-2 text-xs">
                    <summary className="px-3 py-2 cursor-pointer flex items-center gap-2 list-none">
                      <span className="text-red-300 font-medium truncate">{e.class || "(error)"}</span>
                      <span className="text-neutral-400 truncate flex-1">{e.msg?.slice(0, 140)}</span>
                      <span className="text-[10px] text-neutral-500 shrink-0">{fmtAge(e.ts)}</span>
                    </summary>
                    <div className="px-3 pb-3 space-y-2">
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-neutral-500">
                        {e.run_id && <div>run_id: <span className="font-mono text-neutral-300">{e.run_id}</span></div>}
                        {e.req_id && <div>req_id: <span className="font-mono text-neutral-300">{e.req_id}</span></div>}
                        {e.worker_label && <div>worker: <span className="font-mono text-neutral-300">{e.worker_label}</span></div>}
                        {e.level && <div>level: <span className="font-mono text-neutral-300">{e.level}</span></div>}
                      </div>
                      {e.traceback && (
                        <pre className="rounded bg-bg-1 border border-line p-2 text-[10px] overflow-x-auto whitespace-pre-wrap">
                          {e.traceback}
                        </pre>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label, value, tone, icon,
}: {
  label: string;
  value: number | string;
  tone: "good" | "warn" | "bad" | "neutral";
  icon: React.ReactNode;
}) {
  const cls =
    tone === "good"    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200" :
    tone === "warn"    ? "border-amber-500/30 bg-amber-500/5 text-amber-200" :
    tone === "bad"     ? "border-red-500/30 bg-red-500/5 text-red-200" :
                         "border-line bg-bg-2 text-neutral-300";
  return (
    <div className={clsx("rounded-md border p-3", cls)}>
      <div className="flex items-center gap-1.5 text-xs opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function StatusCount({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="rounded-md border border-line bg-bg-2 p-2">
      <div className="text-[10px] text-neutral-500 uppercase tracking-wider">{label}</div>
      <div className={clsx("text-lg font-mono font-semibold", cls)}>{value}</div>
    </div>
  );
}

function fmtAge(ts: number | undefined): string {
  if (!ts) return "—";
  const sec = Math.max(0, Date.now() / 1000 - ts);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

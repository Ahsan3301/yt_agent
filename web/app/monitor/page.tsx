"use client";

/**
 * Backend Monitor — one card per registered backend with live CPU /
 * RAM / disk / GPU and the currently-running job. Polls each backend's
 * /api/stats in parallel every 2 seconds.
 *
 * "Down" backends (in registry but unreachable) get a separate dead-row
 * at the bottom of the list so it's obvious which instance crashed.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Cpu, MemoryStick, HardDrive, Activity, Zap, Wifi, WifiOff,
  Server, Loader2, Box, Clock,
} from "lucide-react";
import {
  fetchLiveBackends, fetchStatsFor, type RegistryEntry, type BackendStats,
} from "@/lib/api";
import Sparkline from "@/components/Sparkline";

const POLL_MS = 2000;
const HISTORY_LEN = 30; // 30 samples × 2s = ~1 minute window

type BackendState = {
  entry: RegistryEntry;
  stats: BackendStats | null;
  reachable: boolean;
  history: {
    cpu: number[];
    mem: number[];
    gpu: number[];
    vram: number[];
  };
};

export default function MonitorPage() {
  const [backends, setBackends] = useState<Record<string, BackendState>>({});
  const [registryError, setRegistryError] = useState<string | null>(null);

  // Persist history across renders so we don't lose the sparkline when
  // React rerenders for other reasons.
  const historyRef = useRef<Record<string, BackendState["history"]>>({});

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const entries = await fetchLiveBackends();
        setRegistryError(null);

        // Snapshot existing keys so we can remove ones that disappeared.
        const seen = new Set<string>();

        // Fetch all backends' stats in parallel.
        const results = await Promise.all(
          entries.map(async (e) => {
            const id = e.instance_id || e.url;
            seen.add(id);
            const stats = await fetchStatsFor(e.url);
            return { id, entry: e, stats };
          }),
        );

        setBackends((prev) => {
          const next: Record<string, BackendState> = {};
          for (const { id, entry, stats } of results) {
            const h = historyRef.current[id] || { cpu: [], mem: [], gpu: [], vram: [] };
            if (stats) {
              h.cpu  = appendTrim(h.cpu,  stats.cpu_percent ?? 0);
              h.mem  = appendTrim(h.mem,  stats.mem_percent ?? 0);
              h.gpu  = appendTrim(h.gpu,  stats.gpu?.util_percent ?? 0);
              h.vram = appendTrim(h.vram, stats.gpu?.mem_percent ?? 0);
            }
            historyRef.current[id] = h;
            next[id] = {
              entry,
              stats,
              reachable: stats !== null,
              history: { ...h },
            };
          }
          return next;
        });
      } catch (e) {
        setRegistryError((e as Error).message || "registry fetch failed");
      } finally {
        if (!cancelled) setTimeout(poll, POLL_MS);
      }
    };
    poll();

    return () => { cancelled = true; };
  }, []);

  const list = Object.values(backends).sort((a, b) => {
    // GPU available first, then CPU available, then busy, then down.
    const rank = (b: BackendState) =>
      (!b.reachable ? 9 : 0) +
      (b.stats?.busy ? 3 : 0) +
      (b.entry.tier === "cpu" ? 1 : 0);
    return rank(a) - rank(b);
  });

  const online = list.filter((b) => b.reachable).length;
  const busy = list.filter((b) => b.stats?.busy).length;
  const totalQueue = list.reduce((acc, b) => acc + (b.stats?.queue_depth || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Monitor</h1>
          <p className="text-sm text-neutral-400">
            Real-time resource usage and job state across every connected backend.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Pill icon={Wifi}        label={`${online} online`}        color="emerald" />
          <Pill icon={Loader2}     label={`${busy} busy`}             color="amber" />
          <Pill icon={Box}         label={`${totalQueue} queued`}     color="neutral" />
        </div>
      </div>

      {registryError && (
        <div className="card border-amber-500/30 bg-amber-500/5 text-sm">
          Registry fetch error: <span className="text-amber-300">{registryError}</span>
        </div>
      )}

      {list.length === 0 && (
        <div className="card text-center text-neutral-400">
          No backends registered yet. Launch a Colab session or wait for the HF Space to come online.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {list.map((b) => (
          <BackendCard key={b.entry.instance_id || b.entry.url} bs={b} />
        ))}
      </div>
    </div>
  );
}

function BackendCard({ bs }: { bs: BackendState }) {
  const { entry, stats, reachable, history } = bs;
  const tierColor = entry.tier === "gpu" ? "text-emerald-400" : "text-sky-400";
  const statusColor = !reachable
    ? "text-red-400"
    : stats?.busy
    ? "text-amber-400"
    : "text-emerald-400";

  const uptime = stats?.uptime_seconds ?? 0;

  return (
    <div
      className={clsx(
        "card space-y-4",
        !reachable && "opacity-70",
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Server className={clsx("h-4 w-4", tierColor)} />
            <span className="font-semibold truncate">
              {entry.label || stats?.instance_label || entry.url.replace(/^https?:\/\//, "")}
            </span>
            <span className={clsx("pill", entry.tier === "gpu" ? "pill-success" : "pill-info")}>
              {entry.tier?.toUpperCase()}
            </span>
          </div>
          <div className="text-xs text-neutral-500 font-mono truncate">
            {entry.url}
          </div>
        </div>
        <div className={clsx("flex items-center gap-1 text-xs", statusColor)}>
          {reachable ? (
            stats?.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />
          ) : (
            <WifiOff className="h-3.5 w-3.5" />
          )}
          {!reachable ? "DOWN" : stats?.busy ? "BUSY" : "AVAILABLE"}
        </div>
      </div>

      {/* Active job (if any) */}
      {stats?.active_job ? (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-amber-300 font-medium">
              <Activity className="h-4 w-4" />
              {stats.active_job.current_step_label || stats.active_job.current_step || "running"}
            </div>
            <div className="font-mono text-xs text-amber-200">
              {Math.round(stats.active_job.percent ?? 0)}%
            </div>
          </div>
          <div className="text-xs text-neutral-400 font-mono truncate">
            run <span className="text-neutral-200">{stats.active_job.run_id || stats.active_job.id}</span>
            {stats.active_job.channel && (
              <span> · ch:{stats.active_job.channel}</span>
            )}
          </div>
          <div className="progress-track h-1">
            <div className="progress-fill h-1"
              style={{ width: `${Math.max(2, stats.active_job.percent ?? 0)}%` }} />
          </div>
        </div>
      ) : reachable ? (
        <div className="text-xs text-neutral-500 italic">No active job</div>
      ) : null}

      {/* Resource gauges */}
      {reachable && stats ? (
        <div className="grid grid-cols-2 gap-3">
          <Gauge
            label="CPU"
            icon={Cpu}
            value={stats.cpu_percent}
            unit="%"
            sub={stats.cpu_count ? `${stats.cpu_count} cores` : undefined}
            samples={history.cpu}
            accentClass="text-sky-400"
          />
          <Gauge
            label="RAM"
            icon={MemoryStick}
            value={stats.mem_percent}
            unit="%"
            sub={
              stats.mem_used_mb && stats.mem_total_mb
                ? `${gb(stats.mem_used_mb)} / ${gb(stats.mem_total_mb)} GB`
                : undefined
            }
            samples={history.mem}
            accentClass="text-emerald-400"
          />
          <Gauge
            label="GPU"
            icon={Zap}
            value={stats.gpu?.util_percent}
            unit="%"
            sub={stats.gpu?.name || (entry.tier === "cpu" ? "no GPU" : undefined)}
            samples={history.gpu}
            accentClass="text-fuchsia-400"
            disabled={!stats.gpu}
          />
          <Gauge
            label="VRAM"
            icon={MemoryStick}
            value={stats.gpu?.mem_percent}
            unit="%"
            sub={
              stats.gpu
                ? `${(stats.gpu.mem_used_mb / 1024).toFixed(1)} / ${(stats.gpu.mem_total_mb / 1024).toFixed(1)} GB`
                : undefined
            }
            samples={history.vram}
            accentClass="text-violet-400"
            disabled={!stats.gpu}
          />
        </div>
      ) : null}

      {/* Footer */}
      {reachable && stats ? (
        <div className="flex items-center justify-between text-xs text-neutral-500 gap-3 pt-1 border-t border-line">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3" /> up {fmtUptime(uptime)}
          </div>
          <div className="flex items-center gap-1.5">
            <HardDrive className="h-3 w-3" />
            {stats.disk_used_gb !== undefined
              ? `${stats.disk_used_gb} / ${stats.disk_total_gb} GB`
              : "—"}
          </div>
          <div>queue: {stats.queue_depth ?? 0}</div>
        </div>
      ) : !reachable ? (
        <div className="text-xs text-red-400">
          Last seen in registry but /api/stats unreachable — instance may have crashed or the tunnel closed.
        </div>
      ) : null}
    </div>
  );
}

function Gauge({
  label, icon: Icon, value, unit, sub, samples, accentClass, disabled,
}: {
  label: string;
  icon: any;
  value?: number;
  unit: string;
  sub?: string;
  samples: number[];
  accentClass: string;
  disabled?: boolean;
}) {
  return (
    <div className={clsx("rounded-md border border-line bg-bg-2 p-2.5", disabled && "opacity-40")}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 text-xs text-neutral-300">
          <Icon className={clsx("h-3.5 w-3.5", accentClass)} />
          {label}
        </div>
        <div className={clsx("text-sm font-mono", accentClass)}>
          {value !== undefined ? `${Math.round(value)}${unit}` : "—"}
        </div>
      </div>
      <Sparkline samples={samples} accentClass={accentClass} showLatest={false} />
      {sub && <div className="text-[10px] text-neutral-500 mt-1 truncate">{sub}</div>}
    </div>
  );
}

function Pill({ icon: Icon, label, color }: { icon: any; label: string; color: string }) {
  const cls: Record<string, string> = {
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    amber:   "border-amber-500/30   bg-amber-500/10   text-amber-300",
    neutral: "border-line bg-bg-2 text-neutral-300",
    red:     "border-red-500/30 bg-red-500/10 text-red-300",
  };
  return (
    <span className={clsx("inline-flex items-center gap-1 px-2 h-7 rounded-md border text-xs", cls[color])}>
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

function appendTrim(arr: number[], v: number): number[] {
  const next = [...arr, v];
  if (next.length > HISTORY_LEN) next.shift();
  return next;
}

function gb(mb: number) {
  return (mb / 1024).toFixed(1);
}

function fmtUptime(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

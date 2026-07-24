"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3, Trash2, Lock, KeyRound, Video, Sparkles,
  AlertTriangle, CheckCircle2, XCircle, RefreshCw, Filter,
  Calendar, Layers, ExternalLink, Loader2, ShieldAlert,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/Toast";

type ReportData = {
  days: number;
  totals: { jobs: number; complete: number; failed: number; videos: number; errors_last_24h: number };
  jobs_daily: Array<{ day: string; complete: number; failed: number; cancelled: number; total: number }>;
  top_channels: Array<{ channel: string; count: number; published: number; failed: number }>;
  videos: Array<{ id: string; run_id: string; channel: string; video_url: string | null; youtube_url: string | null; title: string; ok: boolean; finished_at: number; video_storage: string }>;
  errors_recent: Array<{ id: string; ts: number; kind: string; message: string; run_id: string; worker: string }>;
  cleanup_runs: Array<{ id: string; ts: number; triggered_by: string; days: number; jobs_deleted: number; runs_deleted: number; videos_requested: number; errors_deleted: number; orphan_queued_failed: number; idempotency_deleted: number; freed_estimate_mb: number; detail: string[]; errors: string[]; pre_snapshot: { jobs_total?: number; jobs_complete?: number; jobs_failed?: number; videos_total?: number; errors_total?: number } | null }>;
};

const STATUS_OPTIONS = ["", "complete", "failed", "cancelled", "running", "queued"];

export default function ReportsPage() {
  const toast = useToast();
  const [data, setData] = useState<ReportData | null>(null);
  const [days, setDays] = useState(30);
  const [channelFilter, setChannelFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({
        days: String(days),
        ...(channelFilter && { channel: channelFilter }),
        ...(statusFilter && { status: statusFilter }),
      });
      const r = await fetch(`/api/reports?${q}`, { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch (e) {
      toast.error("Couldn't load report", String(e));
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [days, channelFilter, statusFilter]); // eslint-disable-line

  const channelOptions = useMemo(() => {
    if (!data) return [];
    return data.top_channels.map((c) => c.channel).filter(Boolean);
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-accent" />
            Reports
          </h1>
          <p className="text-sm text-neutral-400 max-w-2xl mt-1">
            Everything that happened: jobs, publishes, errors, cleanups. Filters
            below narrow every panel simultaneously.
          </p>
        </div>
        <button onClick={refresh} className="btn btn-ghost h-8 text-xs">
          <RefreshCw className={clsx("h-3 w-3", loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Filter className="h-4 w-4 text-accent" /> Filters
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="label flex items-center gap-1">
              <Calendar className="h-3 w-3" /> Range
            </label>
            <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>Last 24 hours</option>
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
            </select>
          </div>
          <div>
            <label className="label flex items-center gap-1">
              <Layers className="h-3 w-3" /> Channel
            </label>
            <select className="select" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
              <option value="">All channels</option>
              {channelOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s || "All statuses"}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Totals row */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatTile label="Total jobs"      value={data.totals.jobs}            icon={BarChart3}    accent="text-accent" />
          <StatTile label="Completed"       value={data.totals.complete}        icon={CheckCircle2} accent="text-emerald-400" />
          <StatTile label="Failed"          value={data.totals.failed}          icon={XCircle}      accent="text-red-400" />
          <StatTile label="Videos published"value={data.totals.videos}          icon={Video}      accent="text-red-300" />
          <StatTile label="Errors (24 h)"   value={data.totals.errors_last_24h} icon={ShieldAlert}  accent="text-amber-300" />
        </div>
      )}

      {/* Cleanup panel */}
      <CleanupPanel onDone={refresh} recent={data?.cleanup_runs || []} />

      {/* Job timeline */}
      {data && data.jobs_daily.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-accent" /> Job activity — last {days} day{days === 1 ? "" : "s"}
          </div>
          <StackedBarChart data={data.jobs_daily} />
          <div className="flex items-center gap-4 text-[11px] text-neutral-500">
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-emerald-500/70" /> complete</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-red-500/70" /> failed</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-neutral-500/70" /> cancelled</span>
          </div>
        </div>
      )}

      {/* Channels breakdown */}
      {data && data.top_channels.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4 text-accent" /> Channels
          </div>
          <div className="space-y-2">
            {data.top_channels.map((c) => (
              <div key={c.channel} className="flex items-center gap-3">
                <div className="w-32 text-xs text-neutral-300 truncate">{c.channel || "(unset)"}</div>
                <div className="flex-1 h-4 bg-bg-2 rounded-sm overflow-hidden flex">
                  <div className="bg-emerald-500/60" style={{ width: `${_pct(c.published, c.count)}%` }} title={`published: ${c.published}`} />
                  <div className="bg-red-500/60" style={{ width: `${_pct(c.failed, c.count)}%` }} title={`failed: ${c.failed}`} />
                </div>
                <div className="text-[11px] text-neutral-400 font-mono w-14 text-right">{c.count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Published videos */}
      {data && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Video className="h-4 w-4 text-red-400" /> Published videos
              <span className="text-xs text-neutral-500">({data.videos.length})</span>
            </div>
          </div>
          {data.videos.length === 0 ? (
            <div className="text-xs text-neutral-500">No videos in this range.</div>
          ) : (
            <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
              {data.videos.map((v) => (
                <div key={v.id} className={clsx(
                  "flex items-center gap-3 rounded-md border px-3 py-2",
                  v.ok ? "border-line bg-bg-2" : "border-red-500/30 bg-red-500/5"
                )}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{v.title || v.run_id}</div>
                    <div className="text-[10px] text-neutral-500 font-mono truncate">
                      ch:{v.channel} · run:{v.run_id} · {new Date(v.finished_at * 1000).toLocaleString()}
                    </div>
                  </div>
                  {v.youtube_url && (
                    <a href={v.youtube_url} target="_blank" rel="noreferrer"
                       className="btn btn-ghost h-6 text-[10px]" title="Open on YouTube">
                      <Video className="h-3 w-3 text-red-400" /> YouTube
                    </a>
                  )}
                  {v.video_url && v.video_url !== v.youtube_url && (
                    <a href={String(v.video_url)} target="_blank" rel="noreferrer"
                       className="btn btn-ghost h-6 text-[10px]" title="Open source video">
                      <ExternalLink className="h-3 w-3" /> Source
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Errors */}
      {data && data.errors_recent.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-400" /> Errors
            <span className="text-xs text-neutral-500">({data.errors_recent.length})</span>
          </div>
          <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
            {data.errors_recent.map((e) => (
              <div key={e.id} className="rounded-md border border-line bg-bg-2 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  <span className="pill pill-warn text-[9px]">{String(e.kind || "error")}</span>
                  <span className="font-mono text-[10px] text-neutral-500">
                    {new Date(e.ts * 1000).toLocaleString()}
                  </span>
                  {e.worker && <span className="text-[10px] text-neutral-500">· {e.worker}</span>}
                  {e.run_id && <span className="text-[10px] text-neutral-500">· {e.run_id}</span>}
                </div>
                <div className="text-sm mt-0.5 text-neutral-200 break-words">{e.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cleanup panel ──────────────────────────────────────────────
function CleanupPanel({ onDone, recent }: {
  onDone: () => void;
  recent: ReportData["cleanup_runs"];
}) {
  const toast = useToast();
  const [hasPwd, setHasPwd] = useState(false);
  const [oracleConfigured, setOracleConfigured] = useState(false);
  const [password, setPassword] = useState("");
  const [days, setDays] = useState(1);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"run" | "set-password" | "clear-password">("run");
  const [newPwd, setNewPwd] = useState("");
  const [curPwd, setCurPwd] = useState("");
  const [oraclePwd, setOraclePwd] = useState("");

  const refreshHasPwd = async () => {
    try {
      const r = await fetch("/api/maintenance/cleanup-now", { cache: "no-store" });
      const j = await r.json();
      setHasPwd(!!j.has_password);
      setOracleConfigured(!!j.oracle_unlock_configured);
    } catch { /* ignore */ }
  };
  useEffect(() => { refreshHasPwd(); }, []);

  const runCleanup = async () => {
    if (!password.trim()) {
      toast.error("Enter cleanup password");
      return;
    }
    if (!confirm(`Delete everything older than ${days} day${days === 1 ? "" : "s"}? This is permanent.`)) return;
    setRunning(true);
    try {
      const r = await fetch("/api/maintenance/cleanup-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, days }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast.error("Cleanup failed", j.error || `HTTP ${r.status}`);
      } else {
        toast.success(
          "Cleanup done",
          `${j.jobs_deleted} jobs · ${j.runs_deleted} runs · ${j.errors_deleted} errors · ${j.videos_requested} videos queued for deletion`
        );
        setPassword("");
        onDone();
      }
    } catch (e) {
      toast.error("Cleanup failed", String(e));
    }
    setRunning(false);
  };

  const setPasswordAction = async () => {
    if (newPwd.trim().length < 4) {
      toast.error("Password must be at least 4 characters");
      return;
    }
    if (!hasPwd && !oraclePwd.trim()) {
      toast.error("Oracle unlock password is required for the first-time setup");
      return;
    }
    try {
      const r = await fetch("/api/maintenance/cleanup-now", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set",
          password: newPwd,
          current_password: curPwd || undefined,
          oracle_password: oraclePwd || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast.error("Couldn't set password", j.error || `HTTP ${r.status}`);
      } else {
        toast.success(hasPwd ? "Password replaced" : "Password set");
        setNewPwd("");
        setCurPwd("");
        setOraclePwd("");
        setMode("run");
        refreshHasPwd();
      }
    } catch (e) {
      toast.error("Couldn't set password", String(e));
    }
  };

  const clearPasswordAction = async () => {
    if (!curPwd.trim() && !oraclePwd.trim()) {
      toast.error("Enter the current cleanup password OR the Oracle unlock password to clear");
      return;
    }
    if (!confirm("Clear the cleanup password? Nobody will be able to run cleanup until a new one is set.")) return;
    try {
      const r = await fetch("/api/maintenance/cleanup-now", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear",
          current_password: curPwd || undefined,
          oracle_password: oraclePwd || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast.error("Clear failed", j.error || `HTTP ${r.status}`);
      } else {
        toast.info("Password cleared");
        setCurPwd("");
        setOraclePwd("");
        setMode("run");
        refreshHasPwd();
      }
    } catch (e) {
      toast.error("Clear failed", String(e));
    }
  };

  return (
    <div className="card space-y-3 border-red-500/20">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Trash2 className="h-4 w-4 text-red-300" /> Cleanup
          {hasPwd ? (
            <span className="pill text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">password set</span>
          ) : (
            <span className="pill text-[9px] bg-amber-500/20 text-amber-200 border border-amber-500/40">no password</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button className={clsx("btn btn-ghost h-7 text-[11px]", mode === "run" && "bg-bg-2")}
                  onClick={() => setMode("run")}>Run cleanup</button>
          <button className={clsx("btn btn-ghost h-7 text-[11px]", mode === "set-password" && "bg-bg-2")}
                  onClick={() => setMode("set-password")}>
            <KeyRound className="h-3 w-3" /> {hasPwd ? "Replace" : "Set"} password
          </button>
          {hasPwd && (
            <button className={clsx("btn btn-ghost h-7 text-[11px] text-red-300", mode === "clear-password" && "bg-bg-2")}
                    onClick={() => setMode("clear-password")}>Clear password</button>
          )}
        </div>
      </div>

      {mode === "run" && (
        <div className="space-y-3">
          <p className="text-[11px] text-neutral-500">
            Deletes failed / complete jobs, runs, error-log entries, and
            requests R2 video deletion for anything <b>finished more than
            N days ago</b> (i.e. the age slider is inclusive: 1 = "1 day
            and older"). Orphan queued jobs (&gt;2 h with no worker) are
            always failed regardless of the day setting.
            <br />
            <b>Cleanup history is never deleted</b> — every past run and its
            pre-cleanup snapshot are kept forever so this page can still
            show historical numbers even after the underlying rows are gone.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Cleanup password</label>
              <input
                type="password"
                autoComplete="current-password"
                className="input w-full"
                placeholder={hasPwd ? "Enter cleanup password" : "Set a password first"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={!hasPwd}
              />
            </div>
            <div>
              <label className="label">
                Older than <span className="text-accent font-mono">{days} day{days === 1 ? "" : "s"}</span>
              </label>
              <input type="range" min={1} max={30} step={1} value={days}
                     onChange={(e) => setDays(parseInt(e.target.value, 10))}
                     className="w-full accent-accent" />
              <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
                <span>1 d</span><span>7 d</span><span>14 d</span><span>30 d</span>
              </div>
            </div>
          </div>
          <button onClick={runCleanup} disabled={!hasPwd || running}
                  className="btn btn-primary h-9 text-sm">
            {running ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Cleaning…</>
            ) : (
              <><Trash2 className="h-4 w-4" /> Run cleanup</>
            )}
          </button>
        </div>
      )}

      {mode === "set-password" && (
        <div className="space-y-3">
          <p className="text-[11px] text-neutral-500">
            <Lock className="h-3 w-3 inline mr-1" />
            The password is hashed (scrypt) and never returned to the client.
            <br />
            {hasPwd ? (
              <>To replace, either enter the current cleanup password or the
                <b> Oracle unlock password</b> (the shared env-only secret).</>
            ) : (
              <>First-time setup requires the <b>Oracle unlock password</b>
                {" "}(env variable <code>ORACLE_UNLOCK_PASSWORD</code>). This
                prevents anyone with dashboard access from claiming the
                cleanup gate before you do.</>
            )}
          </p>
          {!oracleConfigured && !hasPwd && (
            <div className="text-[11px] text-amber-300 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
              <ShieldAlert className="h-3 w-3 inline mr-1" />
              ORACLE_UNLOCK_PASSWORD is not set on this dashboard container.
              Set it via Coolify env (same value you use for channel Oracle
              unlock) and redeploy before configuring cleanup.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {hasPwd && (
              <div>
                <label className="label">Current cleanup password</label>
                <input type="password" className="input w-full"
                       value={curPwd} onChange={(e) => setCurPwd(e.target.value)}
                       placeholder="One of the two auth fields" />
              </div>
            )}
            <div>
              <label className="label">
                Oracle unlock password
                {!hasPwd && <span className="text-red-300 ml-1">*</span>}
              </label>
              <input type="password" className="input w-full"
                     value={oraclePwd} onChange={(e) => setOraclePwd(e.target.value)}
                     placeholder={hasPwd ? "One of the two auth fields" : "Required for bootstrap"} />
            </div>
            <div className="md:col-span-2">
              <label className="label">New cleanup password</label>
              <input type="password" autoComplete="new-password" className="input w-full"
                     value={newPwd} onChange={(e) => setNewPwd(e.target.value)}
                     placeholder="At least 4 characters" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={setPasswordAction} className="btn btn-primary h-8 text-xs"
                    disabled={!oracleConfigured && !hasPwd}>
              <KeyRound className="h-3 w-3" /> Save password
            </button>
            <button onClick={() => { setMode("run"); setNewPwd(""); setCurPwd(""); setOraclePwd(""); }}
                    className="btn btn-ghost h-8 text-xs">Cancel</button>
          </div>
        </div>
      )}

      {mode === "clear-password" && (
        <div className="space-y-3">
          <p className="text-[11px] text-red-300">
            Clearing the password disables the Run cleanup button until a new
            one is set. Bring either the current cleanup password OR the
            Oracle unlock password to authorise this action.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Current cleanup password</label>
              <input type="password" className="input w-full"
                     value={curPwd} onChange={(e) => setCurPwd(e.target.value)}
                     placeholder="One of the two auth fields" />
            </div>
            <div>
              <label className="label">Oracle unlock password</label>
              <input type="password" className="input w-full"
                     value={oraclePwd} onChange={(e) => setOraclePwd(e.target.value)}
                     placeholder="One of the two auth fields" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={clearPasswordAction} className="btn h-8 text-xs bg-red-500/20 text-red-200 border border-red-500/30 hover:bg-red-500/30">
              Clear password
            </button>
            <button onClick={() => { setMode("run"); setCurPwd(""); setOraclePwd(""); }}
                    className="btn btn-ghost h-8 text-xs">Cancel</button>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="pt-2 border-t border-line space-y-1.5">
          <div className="text-xs text-neutral-400 font-medium">Recent cleanup runs</div>
          <div className="space-y-1 max-h-[240px] overflow-y-auto pr-1">
            {recent.map((c) => (
              <div key={c.id} className="rounded-md border border-line bg-bg-2 px-3 py-1.5">
                <div className="flex items-center justify-between text-[11px] text-neutral-400">
                  <div className="flex items-center gap-2">
                    <span className="pill pill-info text-[9px]">{c.triggered_by}</span>
                    <span className="font-mono">{new Date(c.ts * 1000).toLocaleString()}</span>
                  </div>
                  <div className="text-[10px] text-neutral-500">
                    &gt; {c.days} day{c.days === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="text-[11px] text-neutral-300 mt-0.5">
                  {c.jobs_deleted} jobs · {c.runs_deleted} runs · {c.errors_deleted} errors ·
                  {" "}{c.videos_requested} videos · ~{c.freed_estimate_mb} MB freed
                  {c.orphan_queued_failed > 0 && ` · ${c.orphan_queued_failed} orphan-queued`}
                </div>
                {c.pre_snapshot && (
                  <div className="text-[10px] text-neutral-500 mt-0.5">
                    Pre-cleanup snapshot: {c.pre_snapshot.jobs_total ?? 0} jobs
                    {" "}({c.pre_snapshot.jobs_complete ?? 0} complete, {c.pre_snapshot.jobs_failed ?? 0} failed)
                    {" · "}{c.pre_snapshot.videos_total ?? 0} videos
                    {" · "}{c.pre_snapshot.errors_total ?? 0} errors
                  </div>
                )}
                {(c.errors || []).length > 0 && (
                  <div className="text-[10px] text-red-300 mt-0.5">
                    Errors: {(c.errors || []).join("; ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small components ─────────────────────────────────────────────
function StatTile({ label, value, icon: Icon, accent }: {
  label: string; value: number; icon: React.ComponentType<{ className?: string }>; accent: string;
}) {
  return (
    <div className="card py-3">
      <div className="flex items-center gap-2">
        <Icon className={clsx("h-4 w-4", accent)} />
        <div className="text-[10px] text-neutral-500 uppercase tracking-wider">{label}</div>
      </div>
      <div className={clsx("text-2xl font-mono font-semibold mt-1", accent)}>{value}</div>
    </div>
  );
}

function StackedBarChart({ data }: {
  data: Array<{ day: string; complete: number; failed: number; cancelled: number; total: number }>;
}) {
  const max = Math.max(1, ...data.map((d) => d.total));
  // Show at most 60 bars.
  const rendered = data.slice(-60);
  return (
    <div className="flex items-end gap-[2px] h-32 pt-2">
      {rendered.map((d) => {
        const total = d.total || 0;
        const heightPct = (total / max) * 100;
        const completeH = total > 0 ? (d.complete / total) * heightPct : 0;
        const failedH = total > 0 ? (d.failed / total) * heightPct : 0;
        const cancelledH = total > 0 ? (d.cancelled / total) * heightPct : 0;
        return (
          <div key={d.day}
               className="flex-1 flex flex-col-reverse group relative"
               title={`${d.day}\ncomplete: ${d.complete}\nfailed: ${d.failed}\ncancelled: ${d.cancelled}`}
          >
            <div style={{ height: `${completeH}%` }} className="bg-emerald-500/70 min-h-[1px]" />
            <div style={{ height: `${failedH}%` }}   className="bg-red-500/70" />
            <div style={{ height: `${cancelledH}%` }} className="bg-neutral-500/70" />
          </div>
        );
      })}
    </div>
  );
}

function _pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.max(2, Math.round((part / total) * 100));
}

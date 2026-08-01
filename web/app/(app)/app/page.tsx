"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Play, Square, CheckCircle2, XCircle, Loader2, AlertTriangle,
  Film, Sparkles, Wand2, Layers, ListChecks, History, BarChart3,
  KeyRound, ArrowRight, Zap, Video, Clock, TrendingUp,
} from "lucide-react";
import clsx from "clsx";
import {
  getState, cancelRun, resetState, getPreflight,
  listRuns, listJobs, type RunState, type Run, type Job,
} from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer";
import LogsPanel from "@/components/LogsPanel";
import { PageHeader } from "@/components/PageHeader";
import { SetupChecklist, SetupChecklistSkeleton } from "@/components/SetupChecklist";

/**
 * Dashboard home — the "studio overview" page.
 *
 * Previously this was a hybrid: header + preflight + big quick-run
 * form (channel picker + dry-run + Run button) + live progress +
 * latest run + logs. The quick-run form duplicated /app/create and
 * /app/create/wizard — three creation entry points confused users.
 *
 * This rewrite pulls the create form OUT (dashboard is overview
 * only) and points users at the right specialised page:
 *   /app/create/wizard  — 5-step guided flow (default primary CTA)
 *   /app/create         — advanced free-form (topic seed, script
 *                         paste, image uploads, per-run overrides)
 *   /app/channels       — for scheduled + recurring publishing
 *
 * The overview surfaces the things a returning user actually wants:
 *   - Stat cards (channels, videos this week, success rate, last run)
 *   - Live progress if a render is in flight
 *   - Quick-action tiles to the specialised pages
 *   - Recent runs grid with thumbnails
 *   - Compact preflight banner only when something's wrong
 */

const STEP_ORDER = [
  ["research",  "Researching topic"],
  ["script",    "Writing script"],
  ["voiceover", "Generating voice"],
  ["footage",   "Fetching footage"],
  ["edit",      "Editing video"],
  ["upload",    "Uploading"],
] as const;

type Channel = { id: string; name: string; niche: string; enabled?: boolean };

export default function Dashboard() {
  const [state, setState] = useState<RunState>({ status: "idle" });
  const [runs, setRuns] = useState<Run[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [preflight, setPreflight] = useState<{ ok: boolean; error?: string } | null>(null);
  // Preflight talks about workers, Colab and Kaggle — operator
  // concerns. A customer can do nothing about them, so it's gated on
  // role rather than shown to everyone.
  const [isAdmin, setIsAdmin] = useState(false);
  const [ytCount, setYtCount] = useState<number | null>(null);
  const [brokenConnections, setBrokenConnections] = useState(0);

  const refresh = useCallback(async () => {
    try { setRuns(await listRuns()); } catch {}
    try { setJobs(await listJobs()); } catch {}
    try {
      const r = await fetch("/api/channels", { cache: "no-store" });
      if (r.ok) setChannels(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    getPreflight().then(setPreflight).catch(() => {});
    // Role decides whether operator-facing warnings render at all.
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsAdmin(!!d?.is_admin))
      .catch(() => setIsAdmin(false));
    // Drives the setup checklist, and warns about a dead connection
    // BEFORE a render is spent discovering it.
    fetch("/api/youtube/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) { setYtCount(0); return; }
        setYtCount((d.items || []).length);
        setBrokenConnections(Number(d.broken || 0));
      })
      .catch(() => setYtCount(0));
  }, [refresh]);

  // Poll run state — 3s while running, 10s when idle.
  useEffect(() => {
    let cancelled = false;
    let lastStatus: string | undefined = undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const s = await getState();
        setState(s);
        if (lastStatus === "running" && s.status !== "running") refresh();
        lastStatus = s.status;
      } catch {}
      const delay = state.status === "running" ? 3000 : 10_000;
      setTimeout(tick, delay);
    };
    tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRunning = state.status === "running";
  const currentIdx = STEP_ORDER.findIndex(([k]) => k === state.current_step);

  // Stats derived from the loaded data.
  const activeChannels = channels.filter((c) => c.enabled !== false).length;
  const totalChannels = channels.length;
  const now = Date.now() / 1000;
  const weekAgo = now - 7 * 86400;
  const recentRuns = runs.filter((r) => Number(r.finished_at || 0) >= weekAgo);
  const recentTerminal = recentRuns.filter((r) => r.status !== "storage_only");
  const succeeded = recentTerminal.filter((r) => r.ok !== false && r.status !== "failed").length;
  const successRate = recentTerminal.length > 0 ? Math.round((succeeded / recentTerminal.length) * 100) : null;
  const latestFinishedAt = runs[0]?.finished_at ? Number(runs[0].finished_at) : null;
  const queuedNow = jobs.filter((j) => j.status === "queued").length;
  const runningNow = jobs.filter((j) => j.status === "running").length;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Studio"
        title="Dashboard"
        subtitle="Overview of your channels, jobs, and recent renders."
        actions={
          <>
            <Link href="/app/create" className="btn h-9 text-xs">
              <Wand2 className="h-3.5 w-3.5" /> Advanced create
            </Link>
            <Link href="/app/create/wizard" className="btn btn-primary h-9 text-xs">
              <Sparkles className="h-3.5 w-3.5" /> New Short
            </Link>
          </>
        }
      />

      {/* Preflight — only appears when something's wrong */}
      {isAdmin && preflight && !preflight.ok && (
        <div className="card border-amber-500/30 bg-amber-500/[0.04] animate-[fadeUp_0.4s_cubic-bezier(0.16,1,0.3,1)_both]">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-amber-300">Preflight warning</div>
              <pre className="mt-1 whitespace-pre-wrap text-sm text-amber-200/80 overflow-x-auto">{preflight.error}</pre>
            </div>
          </div>
        </div>
      )}

      {ytCount === null ? (
        <SetupChecklistSkeleton />
      ) : (
        <SetupChecklist
          s={{
            hasYouTube: ytCount > 0,
            hasChannel: channels.length > 0,
            hasRun: runs.length > 0,
            brokenConnections,
            loading: false,
          }}
        />
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Layers}
          label="Channels"
          value={String(activeChannels)}
          hint={totalChannels > activeChannels ? `${totalChannels - activeChannels} disabled` : "all active"}
          href="/app/channels"
        />
        <StatCard
          icon={Video}
          label="Videos this week"
          value={String(recentTerminal.length)}
          hint={`${recentRuns.length} total incl. drafts`}
          href="/app/history"
        />
        <StatCard
          icon={TrendingUp}
          label="Success rate"
          value={successRate == null ? "—" : `${successRate}%`}
          hint={recentTerminal.length > 0 ? `${succeeded} of ${recentTerminal.length}` : "no runs yet"}
          href="/app/reports"
        />
        <StatCard
          icon={Clock}
          label="Last video"
          value={latestFinishedAt ? fmtAgeShort(now - latestFinishedAt) : "—"}
          hint={runs[0]?.channel || (runs.length ? "channel unknown" : "no runs yet")}
          href={runs[0]?.run_id ? `/app/queue/${runs[0].run_id}` : "/app/history"}
        />
      </div>

      {/* Live queue / progress strip */}
      {isRunning ? (
        <div className="card space-y-4 animate-[fadeUp_0.4s_cubic-bezier(0.16,1,0.3,1)_both]">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative h-10 w-10 rounded-xl bg-gradient-to-br from-accent/25 to-accent-glow/15 border border-accent/30 flex items-center justify-center shrink-0">
                <Loader2 className="h-5 w-5 text-accent animate-spin" />
                <span className="absolute inset-0 rounded-xl bg-accent/20 blur-lg -z-10 animate-pulse-slow" />
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold truncate">
                  {state.current_step_label || "Rendering"} …
                </div>
                <div className="text-xs text-neutral-500 truncate">
                  {state.channel} · elapsed {state.started_at ? Math.floor(now - state.started_at) : 0}s ·{" "}
                  <code className="text-neutral-400">{state.run_id?.slice(0, 20)}</code>
                </div>
              </div>
            </div>
            <button className="btn btn-danger h-9 text-xs" onClick={cancelRun}>
              <Square className="h-3.5 w-3.5" /> Cancel
            </button>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-neutral-400">Progress</span>
              <span className="font-mono text-neutral-300 tabular-nums">
                {Math.round(state.percent || 0)}%
              </span>
            </div>
            <div className="progress-track">
              <div className="progress-fill"
                   style={{ width: `${Math.max(2, state.percent || 0)}%` }} />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-y-2 gap-x-3">
            {STEP_ORDER.map(([key, label], i) => {
              const done   = i < currentIdx;
              const active = i === currentIdx;
              return (
                <div key={key} className="flex items-center gap-1.5 text-xs">
                  {done   ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" /> :
                   active ? <Loader2 className="h-3.5 w-3.5 text-amber-400 animate-spin shrink-0" /> :
                            <div className="h-3.5 w-3.5 rounded-full border border-line shrink-0" />}
                  <span className={clsx(done ? "text-neutral-400" : active ? "text-white" : "text-neutral-500", "truncate")}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (state.status === "complete" || state.status === "failed") && (
        <div className="card space-y-4 animate-[fadeUp_0.4s_cubic-bezier(0.16,1,0.3,1)_both]">
          <div className="flex items-center justify-between">
            <div className="text-base font-semibold flex items-center gap-2">
              {state.status === "complete"
                ? <><CheckCircle2 className="h-5 w-5 text-emerald-400" /> Last run complete</>
                : <><XCircle className="h-5 w-5 text-red-400" /> Last run failed</>}
            </div>
            <button className="btn btn-ghost h-8 text-xs"
                    onClick={() => { resetState(); setState({ status: "idle" }); }}>
              Dismiss
            </button>
          </div>
          {state.error && (
            <pre className="text-sm text-red-300 bg-red-500/[0.06] border border-red-500/20 rounded-lg p-3 whitespace-pre-wrap overflow-x-auto">
              {state.error}
            </pre>
          )}
          {state.video_path && state.run_id && (
            <VideoPlayer runId={state.run_id} publicUrl={state.video_url}
                         className="w-full max-w-sm rounded-lg border border-line" />
          )}
        </div>
      )}

      {/* Queue snapshot — only when there's anything to show */}
      {(queuedNow > 0 || runningNow > 0) && (
        <Link href="/app/queue"
              className="card card-hover flex items-center justify-between group">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center">
              <ListChecks className="h-5 w-5 text-accent" />
            </div>
            <div>
              <div className="font-medium">
                {runningNow > 0 && <>{runningNow} running{queuedNow > 0 && ", "}</>}
                {queuedNow  > 0 && <>{queuedNow} queued</>}
              </div>
              <div className="text-xs text-neutral-500">Open the queue for details</div>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-neutral-500 group-hover:text-white group-hover:translate-x-0.5 transition" />
        </Link>
      )}

      {/* Quick actions */}
      <section className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 px-1">
          Quick actions
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ActionTile href="/app/create/wizard" icon={Sparkles} title="New Short"     body="Guided 5-step flow" primary />
          <ActionTile href="/app/create"        icon={Wand2}    title="Write it yourself" body="Use your own script or images" />
          <ActionTile href="/app/channels"      icon={Layers}   title="Channels"      body="Manage niches + schedules" />
          <ActionTile href="/app/history"       icon={History}  title="Library"       body="Browse past renders" />
        </div>
      </section>

      {/* Recent videos */}
      {runs.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Recent videos</div>
            <Link href="/app/history" className="text-xs text-neutral-400 hover:text-white transition">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {runs.slice(0, 6).map((r) => <RunCard key={r.run_id} run={r} />)}
          </div>
        </section>
      )}

      {/* Activity — only render when there's a run to attach to */}
      {(isRunning || state.run_id || runs[0]?.run_id) && (
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Activity</div>
            {state.run_id && (
              <Link href={`/app/queue/${state.run_id}`} className="text-xs text-neutral-400 hover:text-white transition">
                Open run →
              </Link>
            )}
          </div>
          <LogsPanel active={isRunning} runId={state.run_id || runs[0]?.run_id || undefined} />
        </section>
      )}

    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   Small building blocks (kept inline for locality)
   ──────────────────────────────────────────────────────────── */

function StatCard({
  icon: Icon, label, value, hint, href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  href?: string;
}) {
  const body = (
    <div className="card card-hover h-full flex flex-col justify-between">
      <div className="flex items-start justify-between">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">
          {label}
        </div>
        <div className="h-7 w-7 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
          <Icon className="h-3.5 w-3.5 text-accent" />
        </div>
      </div>
      <div className="mt-3">
        <div className="text-2xl md:text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
        {hint && <div className="text-[11px] text-neutral-500 mt-0.5 truncate">{hint}</div>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block group">{body}</Link> : body;
}

function ActionTile({
  href, icon: Icon, title, body, primary,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  primary?: boolean;
}) {
  return (
    <Link href={href} className={clsx(
      "group relative rounded-xl border p-4 space-y-2 card-hover overflow-hidden transition",
      primary
        ? "border-accent/40 bg-gradient-to-br from-accent/[0.08] to-transparent"
        : "border-line bg-bg-1/60 backdrop-blur",
    )}>
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-accent/[0.06] via-transparent to-accent-glow/[0.04]" />
      <div className="relative">
        <div className={clsx(
          "h-9 w-9 rounded-lg flex items-center justify-center border",
          primary
            ? "bg-gradient-to-br from-accent/30 to-accent-glow/20 border-accent/40"
            : "bg-accent/10 border-accent/20"
        )}>
          <Icon className="h-4 w-4 text-accent" />
        </div>
        <div className="font-medium text-[14px] mt-3">{title}</div>
        <div className="text-xs text-neutral-500 mt-0.5">{body}</div>
      </div>
    </Link>
  );
}

function RunCard({ run }: { run: Run }) {
  const finishedAt = Number(run.finished_at || 0);
  const now = Date.now() / 1000;
  const age = finishedAt > 0 ? fmtAgeShort(now - finishedAt) : "—";
  const ok  = run.ok !== false && run.status !== "failed";
  const stateCls = run.status === "failed"        ? "border-red-500/40 bg-red-500/[0.04]" :
                   run.status === "storage_only"  ? "border-amber-500/40 bg-amber-500/[0.04]" :
                   ok                             ? "border-line" :
                                                     "border-line";
  return (
    <Link href={`/app/queue/${run.run_id}`}
          className={clsx("group rounded-xl border p-4 space-y-3 card-hover", stateCls)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">
            {run.title || run.channel || "Untitled run"}
          </div>
          <div className="text-[11px] text-neutral-500 truncate mt-0.5">
            {run.channel || "—"} · {age}
          </div>
        </div>
        <RunStatusIcon status={run.status || "complete"} ok={ok} />
      </div>
      {(run.has_video || run.video_url) && (
        <div className="aspect-video rounded-lg overflow-hidden bg-bg-2/70 border border-line/60 flex items-center justify-center">
          <Film className="h-6 w-6 text-neutral-600" />
          {/* Real VideoPlayer thumbnail could go here later — currently
              the payload includes video_url but not a poster image. */}
        </div>
      )}
    </Link>
  );
}

function RunStatusIcon({ status, ok }: { status: string; ok: boolean }) {
  if (status === "failed" || !ok) return <XCircle className="h-4 w-4 text-red-400 shrink-0" />;
  if (status === "storage_only")  return <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />;
  return <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />;
}

function fmtAgeShort(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60)    return `${Math.floor(sec)}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// Kept for future — Play + BarChart3 icons imported but only used by
// route metadata / future dashboards. Silence tree-shake warnings.
void Play; void BarChart3; void Zap;

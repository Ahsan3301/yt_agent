"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Play, Square, CheckCircle2, XCircle, Loader2, AlertTriangle,
  Film, Sparkles, Clock, Wand2,
} from "lucide-react";
import clsx from "clsx";
import {
  getSettings, getState, startRun, cancelRun, resetState, getPreflight,
  listRuns, type Settings, type RunState, type Run,
} from "@/lib/api";
import { PRESET_CHANNELS, loadCustomChannels, type ChannelPreset } from "@/lib/channels";
import VideoPlayer from "@/components/VideoPlayer";
import LogsPanel from "@/components/LogsPanel";

const STEP_ORDER = [
  ["research",  "Researching topic"],
  ["script",    "Writing script"],
  ["voiceover", "Generating voice"],
  ["footage",   "Fetching footage"],
  ["edit",      "Editing video"],
  ["upload",    "Uploading"],
] as const;

export default function Dashboard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<RunState>({ status: "idle" });
  const [latest, setLatest] = useState<Run | null>(null);
  const [preflight, setPreflight] = useState<{ ok: boolean; error?: string } | null>(null);
  const [channel, setChannel] = useState<string>("horror");
  const [savedChannels, setSavedChannels] = useState<ChannelPreset[]>([]);
  useEffect(() => {
    setSavedChannels(loadCustomChannels());
  }, []);
  const [dry, setDry] = useState(true);
  const [starting, setStarting] = useState(false);

  // Initial load
  useEffect(() => {
    (async () => {
      try {
        const s = await getSettings();
        setSettings(s);
        setChannel(s.content.channel);
      } catch {}
      try { setPreflight(await getPreflight()); } catch {}
      refreshLatest();
    })();
  }, []);

  const refreshLatest = useCallback(async () => {
    try {
      const runs = await listRuns();
      setLatest(runs[0] || null);
    } catch {}
  }, []);

  // Poll run state every 1.2s while running.
  useEffect(() => {
    let cancelled = false;
    let lastStatus: string | undefined = undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const s = await getState();
        setState(s);
        // When status transitions away from "running", refresh latest run.
        if (lastStatus === "running" && s.status !== "running") {
          refreshLatest();
        }
        lastStatus = s.status;
      } catch {}
      // Backed off from 1.2s / 4s to 3s / 10s. The server-side cache
      // on /api/jobs is 3s, so polling faster than that just returned
      // the same data and wasted Firestore reads. With the 50K/day
      // free Firestore quota, even one user with one tab open at the
      // old cadence could burn the entire daily budget in 2 hours.
      const delay = state.status === "running" ? 3000 : 10_000;
      setTimeout(tick, delay);
    };
    tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRunning = state.status === "running";
  const currentIdx = STEP_ORDER.findIndex(([k]) => k === state.current_step);

  const onRun = async () => {
    setStarting(true);
    try {
      await startRun(channel, dry);
    } catch (e) {
      alert("Failed to start: " + (e as Error).message);
    }
    setStarting(false);
  };
  const onCancel = async () => { await cancelRun(); };
  const onClear = async () => { await resetState(); setState({ status: "idle" }); };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-neutral-400">Kick off a run and watch progress live.</p>
        </div>
        <StatusPill status={state.status} />
      </div>

      {/* Preflight banner */}
      {preflight && !preflight.ok && (
        <div className="card border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5" />
            <div>
              <div className="font-medium text-amber-300">Preflight warning</div>
              <pre className="mt-1 whitespace-pre-wrap text-sm text-amber-200/80">{preflight.error}</pre>
            </div>
          </div>
        </div>
      )}

      {/* Live progress (running) */}
      {isRunning && (
        <div className="card space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-lg font-semibold">Generating video</div>
              <div className="text-xs text-neutral-500 mt-0.5">
                Run <code className="text-neutral-300">{state.run_id}</code> · channel{" "}
                <span className="text-neutral-200">{state.channel}</span> ·
                elapsed {state.started_at ? Math.floor(Date.now()/1000 - state.started_at) : 0}s
              </div>
            </div>
            <button className="btn btn-danger" onClick={onCancel}>
              <Square className="h-4 w-4" /> Cancel
            </button>
          </div>

          <div>
            <div className="flex items-center justify-between text-sm mb-1.5">
              <span className="text-neutral-300">{state.current_step_label || "Working"}</span>
              <span className="font-mono text-neutral-400">{Math.round(state.percent || 0)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.max(2, state.percent || 0)}%` }} />
            </div>
          </div>

          {/* Step checklist */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 md:grid-cols-6">
            {STEP_ORDER.map(([key, label], i) => {
              const done = i < currentIdx;
              const active = i === currentIdx;
              return (
                <div key={key} className="flex items-center gap-2 text-sm">
                  {done ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : active ? (
                    <Loader2 className="h-4 w-4 text-amber-400 animate-spin" />
                  ) : (
                    <div className="h-4 w-4 rounded-full border border-line" />
                  )}
                  <span className={clsx(done ? "text-neutral-400" : active ? "text-white" : "text-neutral-500")}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Idle / done — run controls */}
      {!isRunning && (
        <div className="card space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-accent" /> Start a new run
            </div>
            <Link
              href="/create"
              className="btn btn-ghost h-8 text-xs"
              title="Open the full creator: topic/script input, image upload, custom niches, web research toggle"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Advanced create
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div>
              <label className="label">Channel</label>
              <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {PRESET_CHANNELS.map((c) => (
                  <option key={c.name} value={c.name}>{c.label}</option>
                ))}
                {savedChannels.length > 0 && (
                  <optgroup label="Your custom niches">
                    {savedChannels.map((c) => (
                      <option key={c.name} value={c.name}>{c.label}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm pt-6">
              <input
                type="checkbox" className="h-4 w-4 accent-accent"
                checked={dry} onChange={(e) => setDry(e.target.checked)}
              />
              Dry run (skip upload)
            </label>
            <button className="btn btn-primary w-full" disabled={starting} onClick={onRun}>
              <Play className="h-4 w-4" />
              {starting ? "Starting…" : "Run pipeline now"}
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            Quick run uses the channel&apos;s defaults (auto research + auto script).
            For topic seeds, full scripts, image uploads or the web research toggle,
            use <Link href="/create" className="text-accent hover:underline">Advanced create</Link>.
          </p>
        </div>
      )}

      {/* Last-run result (when complete/failed) */}
      {!isRunning && (state.status === "complete" || state.status === "failed") && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              {state.status === "complete" ? (
                <><CheckCircle2 className="h-5 w-5 text-emerald-400" /> Run complete</>
              ) : (
                <><XCircle className="h-5 w-5 text-red-400" /> Run failed</>
              )}
            </div>
            <button className="btn btn-ghost" onClick={onClear}>Clear</button>
          </div>
          {state.error && (
            <pre className="text-sm text-red-300 bg-red-500/5 border border-red-500/20 rounded-md p-3 whitespace-pre-wrap">
              {state.error}
            </pre>
          )}
          {state.video_path && state.run_id && (
            <VideoPlayer runId={state.run_id} publicUrl={state.video_url}
                         className="w-full max-w-sm rounded-md border border-line aspect-[9/16] object-cover" />
          )}
        </div>
      )}

      {/* Live backend logs — always mounted; polls faster while a job runs */}
      <LogsPanel active={isRunning} />

      {/* Latest finished run */}
      {!isRunning && latest && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-medium flex items-center gap-2">
              <Film className="h-4 w-4 text-neutral-400" /> Latest run
            </div>
            <div className="flex items-center gap-2">
              {latest.shots && (
                <span className="pill pill-info">
                  <Sparkles className="h-3 w-3" />
                  storyboard · {latest.shots.length} shots
                </span>
              )}
              {latest.storyboard_fallback && (
                <span className="pill pill-warn">
                  <AlertTriangle className="h-3 w-3" /> fallback path
                </span>
              )}
              {latest.ok === false && <span className="pill pill-danger">failed</span>}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Metric label="Run ID" value={<code>{latest.run_id}</code>} />
            <Metric label="Channel" value={latest.channel || "—"} />
            <Metric label="Mode" value={latest.dry_run ? "dry-run" : "upload"} />
          </div>
          {latest.has_video && (
            <VideoPlayer runId={latest.run_id}
                         className="w-full max-w-sm rounded-md border border-line aspect-[9/16] object-cover" />
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    running:  "pill-warn",
    complete: "pill-success",
    failed:   "pill-danger",
    idle:     "pill-muted",
  };
  const cls = map[status] || "pill-muted";
  return (
    <span className={clsx("pill", cls)}>
      <span className={clsx("h-1.5 w-1.5 rounded-full",
        status === "running" ? "bg-amber-400 animate-pulse-slow" :
        status === "complete" ? "bg-emerald-400" :
        status === "failed" ? "bg-red-400" : "bg-neutral-400")} />
      {status.toUpperCase()}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card-tight">
      <div className="label">{label}</div>
      <div className="text-base font-medium text-white">{value}</div>
    </div>
  );
}

// Clock import kept for tree-shaking warning silence — unused intentionally
void Clock;

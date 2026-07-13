"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  ArrowLeft, CheckCircle2, AlertCircle, Clock, Activity, X,
  Loader2, RefreshCcw, Play, Film,
} from "lucide-react";
import LogsPanel from "@/components/LogsPanel";

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
  backend_url?: string | null;
  error?: string | null;
  run_id?: string | null;
  public_url?: string | null;
  video_url?: string | null;
  req_id?: string | null;
  manual_topic?: string;
  manual_script?: string;
  manual_title?: string;
  manual_images?: string[];
  manual_channel_desc?: string;
  web_research?: boolean | null;
};

const STEP_ORDER = [
  ["research",  "Research"],
  ["script",    "Script"],
  ["voiceover", "Voiceover"],
  ["footage",   "Footage"],
  ["edit",      "Edit"],
  ["upload",    "Upload"],
] as const;

const STATUS_STYLES: Record<string, string> = {
  queued:        "border-amber-500/30 bg-amber-500/10 text-amber-300",
  running:       "border-sky-500/30 bg-sky-500/10 text-sky-300",
  complete:      "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  needs_publish: "border-orange-500/30 bg-orange-500/10 text-orange-300",
  failed:        "border-red-500/30 bg-red-500/10 text-red-300",
  cancelled:     "border-neutral-500/30 bg-neutral-500/10 text-neutral-300",
};

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error || `HTTP ${r.status}`);
      } else {
        setJob(d as Job);
        setErr(null);
      }
    } catch (e) {
      setErr(String(e));
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [id]);

  const cancel = async () => {
    if (!confirm(`Cancel job ${id.slice(0, 8)}…?`)) return;
    setBusy("cancel");
    try {
      await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
  };

  const retry = async () => {
    if (!job) return;
    setBusy("retry");
    try {
      const body: Record<string, unknown> = {
        channel: job.channel,
        dry_run: job.dry_run,
      };
      if (job.manual_topic)        body.manual_topic = job.manual_topic;
      if (job.manual_script)       body.manual_script = job.manual_script;
      if (job.manual_title)        body.manual_title = job.manual_title;
      if (job.manual_images?.length) body.manual_images = job.manual_images;
      if (job.manual_channel_desc) body.manual_channel_desc = job.manual_channel_desc;
      if (job.web_research !== null && job.web_research !== undefined) {
        body.web_research = job.web_research;
      }
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.ok && d.id) {
        window.location.href = `/queue/${d.id}`;
      } else {
        setErr(d.error || `HTTP ${r.status}`);
      }
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
  };

  const stepStatus = (key: string): "done" | "current" | "pending" => {
    if (!job) return "pending";
    const currentIdx = STEP_ORDER.findIndex(([k]) => k === job.current_step);
    const thisIdx = STEP_ORDER.findIndex(([k]) => k === key);
    if (thisIdx === -1) return "pending";
    if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
      // For terminal: 'done' up to (currentIdx-1), 'current' = current_step, else pending.
      if (currentIdx === -1) return job.status === "complete" ? "done" : "pending";
      if (thisIdx < currentIdx) return "done";
      if (thisIdx === currentIdx) return job.status === "complete" ? "done" : "current";
      return "pending";
    }
    if (thisIdx < currentIdx) return "done";
    if (thisIdx === currentIdx) return "current";
    return "pending";
  };

  return (
    <div className="space-y-5">
      <div>
        <Link href="/queue" className="text-xs text-neutral-400 hover:text-accent inline-flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> Back to queue
        </Link>
      </div>

      {loading && !job ? (
        <div className="card text-center text-neutral-500 py-10">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
          Loading job…
        </div>
      ) : err && !job ? (
        <div className="card border-red-500/30 bg-red-500/5 text-sm text-red-200">
          <AlertCircle className="inline h-4 w-4 mr-1" />
          {err}
        </div>
      ) : job ? (
        <>
          {/* Header */}
          <div className="card space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="space-y-1 min-w-0">
                <div className="text-xs text-neutral-500 font-mono">job id</div>
                <div className="text-2xl font-semibold font-mono truncate">{job.id}</div>
                {job.run_id && (
                  <div className="text-xs text-neutral-500 font-mono">run {job.run_id}</div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusPill status={job.status} />
                {job.channel && (
                  <span className="pill pill-info">{job.channel}</span>
                )}
                {job.dry_run && (
                  <span className="pill pill-muted text-[10px]">dry-run</span>
                )}
                {(job.manual_topic || job.manual_script || job.manual_images?.length) && (
                  <span className="pill text-[10px] border-accent/40 bg-accent/10 text-accent">manual</span>
                )}
                {job.web_research === true && (
                  <span className="pill text-[10px] border-sky-500/30 bg-sky-500/10 text-sky-300">web research</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={refresh} className="btn btn-ghost h-7 text-xs">
                <RefreshCcw className="h-3 w-3" /> Refresh
              </button>
              {(job.status === "queued" || job.status === "running") && (
                <button
                  onClick={cancel}
                  disabled={busy === "cancel"}
                  className="btn h-7 text-xs border-amber-500/40 bg-amber-500/10 text-amber-300"
                >
                  {busy === "cancel" ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                  Cancel
                </button>
              )}
              {(job.status === "failed" || job.status === "cancelled" || job.status === "complete") && (
                <button
                  onClick={retry}
                  disabled={busy === "retry"}
                  className="btn h-7 text-xs border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                >
                  {busy === "retry" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  Retry as new job
                </button>
              )}
              {job.public_url && (
                <a
                  href={job.public_url}
                  target="_blank"
                  rel="noreferrer"
                  className="btn h-7 text-xs border-line"
                >
                  <Film className="h-3 w-3" /> View video
                </a>
              )}
            </div>
          </div>

          {/* Step timeline */}
          <div className="card space-y-3">
            <div className="font-medium text-sm">Pipeline progress</div>
            <div className="space-y-1.5">
              {STEP_ORDER.map(([key, label]) => {
                const s = stepStatus(key);
                return (
                  <div
                    key={key}
                    className={clsx(
                      "rounded-md border px-3 py-2 flex items-center gap-3 text-sm",
                      s === "done"    ? "border-emerald-500/30 bg-emerald-500/5" :
                      s === "current" ? "border-sky-500/30 bg-sky-500/5 animate-pulse" :
                                        "border-line bg-bg-2 opacity-50",
                    )}
                  >
                    {s === "done" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    ) : s === "current" ? (
                      <Loader2 className="h-4 w-4 text-sky-300 animate-spin" />
                    ) : (
                      <Clock className="h-4 w-4 text-neutral-500" />
                    )}
                    <span>{label}</span>
                    {s === "current" && job.current_step_label && (
                      <span className="text-xs text-neutral-400 ml-auto">{job.current_step_label}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {job.percent != null && job.status === "running" && (
              <div className="space-y-1">
                <div className="progress-track h-2">
                  <div className="progress-fill h-2"
                       style={{ width: `${Math.max(2, job.percent)}%` }} />
                </div>
                <div className="text-xs text-neutral-500 text-right font-mono">
                  {Math.round(job.percent)}%
                </div>
              </div>
            )}
          </div>

          {/* Error if failed */}
          {job.error && (
            <div className="card border-red-500/30 bg-red-500/5">
              <div className="font-medium text-sm text-red-200 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Failure
              </div>
              <pre className="mt-2 text-xs text-red-100 whitespace-pre-wrap font-mono">
                {job.error}
              </pre>
            </div>
          )}

          {/* Manual mode payload */}
          {(job.manual_topic || job.manual_script || job.manual_images?.length || job.manual_channel_desc) && (
            <div className="card space-y-3">
              <div className="font-medium text-sm">Manual inputs</div>
              {job.manual_topic && (
                <Field label="Topic seed" value={job.manual_topic} />
              )}
              {job.manual_script && (
                <Field label="User script" value={job.manual_script} multiline />
              )}
              {job.manual_title && (
                <Field label="Override title" value={job.manual_title} />
              )}
              {job.manual_channel_desc && (
                <Field label="Custom niche description" value={job.manual_channel_desc} multiline />
              )}
              {job.manual_images && job.manual_images.length > 0 && (
                <div>
                  <div className="text-xs text-neutral-500 mb-1">Uploaded images ({job.manual_images.length})</div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                    {job.manual_images.map((url, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={url}
                        alt=""
                        className="w-full aspect-square object-cover rounded-md border border-line"
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Live logs */}
          {job.run_id && (
            <LogsPanel
              runId={job.run_id}
              active={job.status === "running" || job.status === "queued"}
            />
          )}

          {/* Timing footer */}
          <div className="card text-xs text-neutral-500 font-mono space-y-0.5">
            {job.queued_at &&  <div>queued   {fmtTime(job.queued_at)}</div>}
            {job.started_at && <div>started  {fmtTime(job.started_at)}</div>}
            {job.finished_at && <div>finished {fmtTime(job.finished_at)}</div>}
            {job.backend_instance_id && (
              <div>worker   {job.backend_instance_id}</div>
            )}
            {job.req_id && (
              <div>req_id   {job.req_id}</div>
            )}
          </div>
        </>
      ) : null}
    </div>
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
    <span className={clsx("inline-flex items-center gap-1.5 px-3 h-8 rounded-md border text-sm", cls)}>
      <Icon className="h-4 w-4" />
      {status}
    </span>
  );
}

function Field({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div>
      <div className="text-xs text-neutral-500 mb-1">{label}</div>
      <div className={clsx(
        "rounded-md border border-line bg-bg-2 px-3 py-2 text-sm",
        multiline ? "whitespace-pre-wrap font-mono text-xs leading-relaxed max-h-60 overflow-y-auto" : "",
      )}>
        {value}
      </div>
    </div>
  );
}

function fmtTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

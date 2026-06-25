"use client";

import { useEffect, useState } from "react";
import { Trash2, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, XCircle, Sparkles } from "lucide-react";
import clsx from "clsx";
import { listRuns, deleteRun, type Run } from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer";

export default function HistoryPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try { setRuns(await listRuns()); } catch {}
    setLoading(false);
  };
  useEffect(() => { refresh(); }, []);

  const onDelete = async (id: string) => {
    if (!confirm(`Delete run ${id}?`)) return;
    await deleteRun(id);
    refresh();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Run history</h1>
        <p className="text-sm text-neutral-400">{runs.length} runs · most recent first</p>
      </div>

      {loading && <div className="text-neutral-400">Loading…</div>}
      {!loading && runs.length === 0 && (
        <div className="card text-center text-neutral-400">
          No runs yet. Head to the Dashboard to start one.
        </div>
      )}

      <div className="space-y-3">
        {runs.map((r) => {
          const open = !!expanded[r.run_id];
          return (
            <div key={r.run_id} className="card">
              <button
                onClick={() => setExpanded({ ...expanded, [r.run_id]: !open })}
                className="w-full flex items-start justify-between text-left"
              >
                <div className="flex items-start gap-3">
                  {open ? <ChevronDown className="h-4 w-4 mt-1 text-neutral-400" />
                        : <ChevronRight className="h-4 w-4 mt-1 text-neutral-400" />}
                  <div>
                    <div className="font-mono text-sm">{r.run_id}</div>
                    <div className="text-xs text-neutral-500 mt-1 flex items-center gap-3 flex-wrap">
                      <span>channel: {r.channel || "—"}</span>
                      {r.dry_run && <span>· dry-run</span>}
                      {typeof r.ok === "boolean" && (
                        <span className={r.ok ? "text-emerald-400" : "text-red-400"}>
                          {r.ok ? "ok" : "failed"}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.shots && (
                    <span className="pill pill-info">
                      <Sparkles className="h-3 w-3" />
                      {r.shots.length} shots
                    </span>
                  )}
                  {r.storyboard_fallback && (
                    <span className="pill pill-warn">
                      <AlertTriangle className="h-3 w-3" /> fallback
                    </span>
                  )}
                  {r.ok === true && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
                  {r.ok === false && <XCircle className="h-4 w-4 text-red-400" />}
                </div>
              </button>

              {open && (
                <div className="mt-4 space-y-3 border-t border-line pt-4">
                  {r.video_url && (
                    <div className="text-sm">
                      Published: <a className="text-accent underline" href={r.video_url} target="_blank">{r.video_url}</a>
                    </div>
                  )}
                  {(r.has_video || r.video_url) && (
                    <VideoPlayer runId={r.run_id} publicUrl={r.video_url}
                                 className="w-full max-w-xs rounded-md border border-line aspect-[9/16] object-cover" />
                  )}

                  {r.steps && (
                    <div>
                      <div className="label">Step timings</div>
                      <div className="space-y-1">
                        {Object.entries(r.steps).map(([k, v]) => (
                          <div key={k} className="flex items-center justify-between text-sm py-1 border-b border-line last:border-0">
                            <div className="flex items-center gap-2">
                              {v.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                   : <XCircle className="h-3.5 w-3.5 text-red-400" />}
                              <span>{k}</span>
                              {v.skipped && <span className="pill pill-muted">skipped</span>}
                            </div>
                            <span className="font-mono text-neutral-400">{v.seconds?.toFixed(1)}s</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {r.shots && (
                    <div>
                      <div className="label">Storyboard</div>
                      <div className="space-y-2">
                        {r.shots.map((sh, i) => (
                          <div key={i} className="card-tight">
                            <div className="text-xs text-neutral-500">
                              Shot {i+1} · <span className="font-mono">{sh.start?.toFixed(1)}-{sh.end?.toFixed(1)}s</span>
                            </div>
                            <div className="text-sm mt-1"><span className="text-neutral-400">narration:</span> {sh.narration_excerpt}</div>
                            <div className="text-sm"><span className="text-neutral-400">visual:</span> {sh.visual_description}</div>
                            <div className="text-xs font-mono text-accent mt-1">{sh.search_query}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="pt-2">
                    <button className="btn btn-danger" onClick={() => onDelete(r.run_id)}>
                      <Trash2 className="h-4 w-4" /> Delete run
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

void clsx; // unused-import guard

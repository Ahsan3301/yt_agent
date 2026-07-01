"use client";

import { useEffect, useState } from "react";
import { Trash2, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, XCircle, Sparkles, Upload, Copy, PlaySquare } from "lucide-react";
import clsx from "clsx";
import { listRuns, deleteRun, type Run } from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer";

type YtAccount = { id: string; title: string; youtube_channel_id: string; thumbnail?: string };
type StorageProvider = { id: string; name: string; kind: string; is_primary?: boolean; enabled?: boolean };
type BackendCard = { instance_id: string; label?: string | null; tier?: string; alive: boolean; status: string };

export default function HistoryPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [ytAccounts, setYtAccounts] = useState<YtAccount[]>([]);
  const [providers, setProviders] = useState<StorageProvider[]>([]);
  const [backends, setBackends] = useState<BackendCard[]>([]);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  // Per-row target + schedule state (keyed by run_id).
  const [target, setTarget] = useState<Record<string, string>>({});
  const [runAt, setRunAt] = useState<Record<string, string>>({});

  const refresh = async () => {
    setLoading(true);
    try { setRuns(await listRuns()); } catch {}
    setSelected(new Set());
    setLoading(false);
  };
  useEffect(() => { refresh(); }, []);

  // Load connected accounts + storage providers + live backends so
  // the per-run action dropdowns can offer them as targets.
  useEffect(() => {
    const load = async () => {
      try {
        const [yt, sp, bk] = await Promise.all([
          fetch("/api/youtube/accounts").then((r) => r.ok ? r.json() : []),
          fetch("/api/storage/providers").then((r) => r.ok ? r.json() : []),
          fetch("/api/backends").then((r) => r.ok ? r.json() : []),
        ]);
        setYtAccounts(Array.isArray(yt) ? yt : []);
        setProviders(Array.isArray(sp) ? sp.filter((p: StorageProvider) => p.enabled !== false) : []);
        setBackends(Array.isArray(bk) ? bk : []);
      } catch { /* soft; buttons just won't populate */ }
    };
    load();
    // Refresh backends every 15s so a freshly-booted worker shows up
    // in the target dropdown without a page reload.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  // Build the target dropdown options in one place so publish + copy
  // share the same UI. "" = auto. Live workers are listed by
  // instance_id. Also always show 'gpu' / 'dashboard' aliases so the
  // user can say "any GPU worker" or "Oracle side-worker" even if
  // one isn't currently alive (the wake happens automatically).
  const targetOptions = (() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: "", label: "Auto — any available worker" },
      { value: "dashboard", label: "Oracle side-worker (fast for uploads)" },
      { value: "gpu", label: "Any GPU worker (Kaggle/Colab)" },
    ];
    for (const b of backends) {
      if (!b.alive) continue;
      const suffix = b.tier === "gpu" ? " · GPU" : b.tier === "dashboard" ? " · Oracle" : "";
      opts.push({
        value: b.instance_id,
        label: `${(b.label || b.instance_id).slice(0, 42)}${suffix}${b.status === "busy" ? " (busy)" : ""}`,
      });
    }
    return opts;
  })();

  // Convert the datetime-local input's string to epoch seconds. Empty
  // input = 0 (run ASAP).
  const _dtToEpoch = (s: string): number =>
    s ? Math.floor(new Date(s).getTime() / 1000) : 0;

  const publishTo = async (run: Run, ytAccountId: string) => {
    setActionBusy(run.run_id + ":publish");
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(run.run_id)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtube_account_id: ytAccountId,
          target_worker:      target[run.run_id] || "",
          run_at:             _dtToEpoch(runAt[run.run_id] || ""),
        }),
      });
      const d = await r.json();
      if (!r.ok) alert(`Publish failed: ${d.error || r.statusText}`);
      else {
        const when = runAt[run.run_id] ? ` at ${runAt[run.run_id]}` : "";
        alert(`Publish queued${when} as job ${d.job_id}. Track it on the Job queue.`);
      }
    } catch (e) {
      alert(`Publish failed: ${String(e)}`);
    }
    setActionBusy(null);
  };

  const copyTo = async (run: Run, providerId: string, move = false) => {
    setActionBusy(run.run_id + ":copy");
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(run.run_id)}/copy-storage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id:   providerId,
          move,
          target_worker: target[run.run_id] || "",
          run_at:        _dtToEpoch(runAt[run.run_id] || ""),
        }),
      });
      const d = await r.json();
      if (!r.ok) alert(`${move ? "Move" : "Copy"} failed: ${d.error || r.statusText}`);
      else {
        const when = runAt[run.run_id] ? ` at ${runAt[run.run_id]}` : "";
        alert(`${move ? "Move" : "Copy"} queued${when} as job ${d.job_id}.`);
      }
    } catch (e) {
      alert(`${move ? "Move" : "Copy"} failed: ${String(e)}`);
    }
    setActionBusy(null);
  };

  const onDelete = async (id: string) => {
    if (!confirm(`Delete run ${id}?`)) return;
    await deleteRun(id);
    refresh();
  };

  const toggleSel = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };
  const toggleAll = () => {
    if (selected.size === runs.length) setSelected(new Set());
    else setSelected(new Set(runs.map((r) => r.run_id)));
  };

  const onBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} run(s)? This removes the video files + all logs.`)) return;
    setBulkBusy(true);
    try {
      const r = await fetch("/api/runs/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_ids: [...selected] }),
      });
      const d = await r.json();
      if (!r.ok) alert(`Bulk delete failed: ${d.error || r.statusText}`);
      else if (d.fully_deleted < d.requested) {
        alert(`${d.fully_deleted}/${d.requested} deleted cleanly. Check /health for the rest.`);
      }
    } catch (e) {
      alert(`Bulk delete failed: ${String(e)}`);
    }
    setBulkBusy(false);
    refresh();
  };

  const allChecked = runs.length > 0 && selected.size === runs.length;

  const [pruneDays, setPruneDays] = useState<number>(30);
  const [pruneBusy, setPruneBusy] = useState(false);
  const onPrune = async () => {
    if (!Number.isFinite(pruneDays) || pruneDays < 1) return;
    // Dry-run first so the user sees the count before committing.
    setPruneBusy(true);
    try {
      const dry = await fetch("/api/runs/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ older_than_days: pruneDays, dry_run: true }),
      }).then((r) => r.json());
      const n = Number(dry.would_delete || 0);
      if (n === 0) { alert(`No runs older than ${pruneDays} days.`); setPruneBusy(false); return; }
      if (!confirm(`Delete ${n} run(s) older than ${pruneDays} days? Videos + logs go too.`)) {
        setPruneBusy(false); return;
      }
      const real = await fetch("/api/runs/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ older_than_days: pruneDays }),
      }).then((r) => r.json());
      alert(`Pruned ${real.fully_deleted}/${real.requested} runs.`);
      refresh();
    } catch (e) {
      alert(`Prune failed: ${String(e)}`);
    }
    setPruneBusy(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Run history</h1>
          <p className="text-sm text-neutral-400">{runs.length} runs · most recent first</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {runs.length > 0 && (
            <button className="btn btn-ghost text-xs" onClick={toggleAll}>
              {allChecked ? "Deselect all" : "Select all"}
            </button>
          )}
          <div className="flex items-center gap-1">
            <span className="text-xs text-neutral-400">Prune older than</span>
            <input
              type="number" min={1} max={3650}
              value={pruneDays}
              onChange={(e) => setPruneDays(Number(e.target.value) || 30)}
              className="input h-8 w-16 text-xs"
              aria-label="Days"
            />
            <span className="text-xs text-neutral-400">days</span>
            <button
              className="btn btn-ghost text-xs"
              disabled={pruneBusy}
              onClick={onPrune}
              title="Delete every run finished more than N days ago. Confirms count before committing."
            >
              {pruneBusy ? "…" : "Prune"}
            </button>
          </div>
          {selected.size > 0 && (
            <button
              className="btn btn-danger"
              disabled={bulkBusy}
              onClick={onBulkDelete}
              title="Deletes the video files + Pocketbase rows + log tails for every selected run."
            >
              <Trash2 className="h-4 w-4" />
              {bulkBusy ? "Deleting…" : `Delete ${selected.size} run${selected.size > 1 ? "s" : ""}`}
            </button>
          )}
        </div>
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
          const checked = selected.has(r.run_id);
          return (
            <div key={r.run_id} className="card">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSel(r.run_id)}
                  className="mt-1.5 shrink-0"
                  aria-label={`Select run ${r.run_id}`}
                />
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
              </div>

              {open && (
                <div className="mt-4 space-y-3 border-t border-line pt-4">
                  {r.video_url && (
                    <div className="text-sm">
                      Published: <a className="text-accent underline" href={r.video_url} target="_blank">{r.video_url}</a>
                    </div>
                  )}
                  {(r.has_video || r.video_url || r.youtube_video_id || (r.mirrors && r.mirrors.length > 0)) && (
                    <VideoPlayer
                      runId={r.run_id}
                      publicUrl={r.video_url}
                      mirrors={r.mirrors}
                      youtubeVideoId={r.youtube_video_id}
                      className="w-full max-w-xs rounded-md border border-line"
                    />
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

                  {/* Target + schedule — apply to whichever action
                      button is clicked next (Publish or Copy). */}
                  <div className="pt-2 flex flex-wrap gap-2 items-end text-xs">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-neutral-500">Run on</span>
                      <select
                        className="input h-8 text-xs min-w-[240px]"
                        value={target[r.run_id] || ""}
                        onChange={(e) => setTarget({ ...target, [r.run_id]: e.target.value })}
                      >
                        {targetOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-neutral-500">Schedule (optional)</span>
                      <input
                        type="datetime-local"
                        className="input h-8 text-xs"
                        value={runAt[r.run_id] || ""}
                        onChange={(e) => setRunAt({ ...runAt, [r.run_id]: e.target.value })}
                      />
                    </label>
                    {(target[r.run_id] || runAt[r.run_id]) && (
                      <button
                        className="btn btn-ghost h-8 text-xs"
                        onClick={() => {
                          const nt = { ...target }; delete nt[r.run_id]; setTarget(nt);
                          const nr = { ...runAt };  delete nr[r.run_id]; setRunAt(nr);
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>

                  <div className="pt-2 flex flex-wrap gap-2 items-center">
                    {/* Publish to YouTube — one per connected account */}
                    {ytAccounts.length > 0 && (
                      <div className="flex items-center gap-1">
                        <select
                          className="input h-8 text-xs"
                          value=""
                          disabled={actionBusy === r.run_id + ":publish"}
                          onChange={(e) => {
                            if (e.target.value) publishTo(r, e.target.value);
                            e.target.value = "";
                          }}
                          aria-label="Publish to YouTube channel"
                        >
                          <option value="">Publish to YouTube…</option>
                          {ytAccounts.map((a) => (
                            <option key={a.id} value={a.id}>{a.title || a.youtube_channel_id}</option>
                          ))}
                        </select>
                        <PlaySquare className="h-3.5 w-3.5 text-red-400" />
                      </div>
                    )}
                    {/* Copy to a storage provider */}
                    {providers.length > 0 && (
                      <div className="flex items-center gap-1">
                        <select
                          className="input h-8 text-xs"
                          value=""
                          disabled={actionBusy === r.run_id + ":copy"}
                          onChange={(e) => {
                            if (!e.target.value) return;
                            const [pid, action] = e.target.value.split("|");
                            copyTo(r, pid, action === "move");
                            e.target.value = "";
                          }}
                          aria-label="Copy to storage provider"
                        >
                          <option value="">Copy to storage…</option>
                          {providers.map((p) => (
                            <optgroup key={p.id} label={`${p.name} (${p.kind})`}>
                              <option value={`${p.id}|copy`}>Copy to {p.name}</option>
                              <option value={`${p.id}|move`}>Move to {p.name}</option>
                            </optgroup>
                          ))}
                        </select>
                        <Copy className="h-3.5 w-3.5 text-neutral-400" />
                      </div>
                    )}
                    <div className="grow" />
                    <button className="btn btn-danger" onClick={() => onDelete(r.run_id)}>
                      <Trash2 className="h-4 w-4" /> Delete run
                    </button>
                  </div>
                  {/* Mirrors / published state — surface fields the worker
                      side-jobs write back so the UI shows progress. */}
                  {(r.youtube_video_id || (r.mirrors && r.mirrors.length > 0)) && (
                    <div className="text-xs text-neutral-400 flex flex-wrap gap-3 pt-1">
                      {r.youtube_video_id && (
                        <a
                          href={`https://youtube.com/watch?v=${r.youtube_video_id}`}
                          target="_blank" rel="noreferrer"
                          className="text-red-300 hover:underline flex items-center gap-1"
                        >
                          <Upload className="h-3 w-3" /> YouTube ✓
                        </a>
                      )}
                      {r.mirrors && r.mirrors.map((m, i) => (
                        <a key={i} href={m.url} target="_blank" rel="noreferrer"
                           className="text-sky-300 hover:underline flex items-center gap-1">
                          <Copy className="h-3 w-3" /> mirror
                        </a>
                      ))}
                    </div>
                  )}
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

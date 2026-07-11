// Thin fetch wrapper for the YT Agent backend.
//
// Backend resolution (in priority order):
//   1. process.env.NEXT_PUBLIC_BACKEND_URL — if set, always use it (dev / single-instance).
//   2. Firestore `backends` collection — primary discovery path.
//   3. Legacy NEXT_PUBLIC_REGISTRY_URL + FALLBACK_URL — only consulted if Firestore isn't configured.
//   4. Fallback: /api/* on the same origin (Next.js dev proxy).

import { getDb, isFirestoreConfigured } from "@/lib/firestore";
import { collection, getDocs, query, Timestamp, where } from "firebase/firestore";

const REGISTRY_TTL_MS = 20_000;
const FRESHNESS_SECONDS = 180;

export type RegistryEntry = {
  instance_id: string;
  url: string;
  status: "available" | "busy";
  queue_depth: number;
  last_seen: number;
  started_at?: number;
  tier?: "gpu" | "cpu" | "dashboard";
  label?: string | null;
  gpu_name?: string | null;
  version?: string;
  // Optional resource stats. Present when the worker pushes them via
  // heartbeat (outbound-poll workers do; legacy tunnel workers rely
  // on /api/stats polling instead).
  stats?: {
    cpu_percent?: number | null;
    mem_percent?: number | null;
    mem_used_gb?: number | null;
    mem_total_gb?: number | null;
    disk_used_gb?: number | null;
    disk_total_gb?: number | null;
    gpu?: {
      name?: string;
      util_percent?: number | null;
      mem_used_mb?: number | null;
      mem_total_mb?: number | null;
      mem_percent?: number | null;
      temp_c?: number | null;
    } | null;
    sampled_at?: number;
  } | null;
  shutdown_pending?: boolean;
  // Populated by /api/backends when the worker's active_job_id has a
  // matching row in the jobs collection. Lets the Monitor card render
  // step + progress for outbound-poll workers (no /api/stats to poll).
  active_job?: {
    id: string;
    run_id?: string | null;
    channel?: string;
    current_step?: string;
    current_step_label?: string;
    percent?: number;
    started_at?: number;
  } | null;
};

let _cached: { at: number; url: string } | null = null;

/**
 * Backend selection priority — lower rank wins:
 *   1. tier=gpu + available + idle (Colab, no queue)
 *   2. tier=gpu + busy            (Colab working — wait for it)
 *   3. tier=cpu + available       (HF Space — slow but free)
 *   4. tier=cpu + busy
 * Within a tier+status group, prefer the lowest queue_depth.
 *
 * Why GPU > busy GPU > CPU: on a GPU instance the render finishes in ~1 min;
 * a CPU instance takes 5-10 min. Queueing on a free GPU is faster than
 * starting fresh on a slow CPU.
 */
function rankBackend(a: RegistryEntry, b: RegistryEntry): number {
  const score = (e: RegistryEntry) => {
    const tier = e.tier === "cpu" ? 2 : 0;              // GPU = 0, CPU = 2
    const busy = e.status === "available" ? 0 : 1;
    return tier + busy;                                  // 0..3
  };
  const sa = score(a), sb = score(b);
  if (sa !== sb) return sa - sb;
  return (a.queue_depth || 0) - (b.queue_depth || 0);
}

/** Read all live backends from Firestore. Returns [] if Firestore
 * isn't configured OR the read fails. */
async function _readBackendsFromFirestore(): Promise<RegistryEntry[]> {
  const db = getDb();
  if (!db) return [];
  try {
    // Server timestamps are Firestore Timestamps. We compute the cutoff
    // client-side and let the query filter; if the index isn't built yet,
    // the where() may error — fall back to client-side filter.
    const snap = await getDocs(collection(db, "backends"));
    const cutoff = Date.now() / 1000 - FRESHNESS_SECONDS;
    const out: RegistryEntry[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const last = _toEpoch(d.last_seen_at ?? d.last_seen);
      if (last !== null && last < cutoff) return;
      out.push({
        instance_id: doc.id,
        url:         String(d.url || ""),
        status:      (d.status === "busy" ? "busy" : "available"),
        queue_depth: Number(d.queue_depth ?? 0),
        last_seen:   last ?? Date.now() / 1000,
        started_at:  _toEpoch(d.started_at) ?? undefined,
        tier:        d.tier === "cpu" ? "cpu" : d.tier === "dashboard" ? "dashboard" : "gpu",
        label:       (d.label as string) ?? null,
        gpu_name:    (d.gpu_name as string) ?? null,
        version:     (d.version as string) ?? undefined,
      });
    });
    // Return ALL entries — outbound-poll workers have no URL by
    // design; the UI shows a card without live stats.
    return out;
  } catch (e) {
    console.warn("firestore backends read failed:", e);
    return [];
  }
}

function _toEpoch(v: unknown): number | null {
  // Accepts: epoch number (sec OR ms), ISO string, Firestore Timestamp,
  // {seconds, nanoseconds} pseudo-Timestamp. Returns epoch SECONDS.
  if (v == null) return null;
  if (typeof v === "number") {
    if (!isFinite(v) || v <= 0) return null;
    return v > 1e11 ? v / 1000 : v;
  }
  if (typeof v === "string") {
    if (/^-?\d+(\.\d+)?$/.test(v)) return _toEpoch(parseFloat(v));
    const p = Date.parse(v);
    return isNaN(p) ? null : p / 1000;
  }
  const t = v as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
  if (typeof t.toMillis === "function") { try { return t.toMillis() / 1000; } catch { return null; } }
  if (typeof t.seconds === "number") return t.seconds + (t.nanoseconds ?? 0) / 1e9;
  return null;
}

async function _readBackendsFromRegistryFiles(): Promise<RegistryEntry[]> {
  // Legacy path: dual registry URLs. Kept for one release as fallback
  // for users mid-migration.
  const primary  = process.env.NEXT_PUBLIC_REGISTRY_URL;
  const fallback = process.env.NEXT_PUBLIC_REGISTRY_FALLBACK_URL;
  const urls = [primary, fallback].filter((u): u is string => !!u);
  if (urls.length === 0) return [];
  const lists = await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) return [] as RegistryEntry[];
      return (await r.json()) as RegistryEntry[];
    } catch { return [] as RegistryEntry[]; }
  }));
  const byId = new Map<string, RegistryEntry>();
  for (const list of lists) {
    for (const e of list) {
      const id = e.instance_id || e.url;
      const prev = byId.get(id);
      if (!prev || (e.last_seen || 0) > (prev.last_seen || 0)) byId.set(id, e);
    }
  }
  return Array.from(byId.values())
    .filter((e) => e && e.url && Date.now() / 1000 - (e.last_seen || 0) < FRESHNESS_SECONDS);
}

/**
 * Call the Vercel API gateway (same-origin). Replaces direct
 * worker fetches for everything except per-instance polling
 * (stats, logs, video stream) — see fetchStatsFor, runVideoUrl.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${text || r.statusText}`);
  }
  return r.json() as Promise<T>;
}

/**
 * Find the best worker URL for per-instance polling endpoints
 * (LogsPanel, runVideoUrl fallback). Most callers should hit the
 * Vercel gateway (`/api/*`) instead — only use this when you
 * specifically need direct backend access.
 */
export async function pickActiveWorkerUrl(): Promise<string> {
  const fixed = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (fixed) return fixed.replace(/\/$/, "");
  if (_cached && Date.now() - _cached.at < REGISTRY_TTL_MS) return _cached.url;
  try {
    const entries = isFirestoreConfigured()
      ? await _readBackendsFromFirestore()
      : await _readBackendsFromRegistryFiles();
    const fresh = entries.sort(rankBackend);
    if (fresh.length > 0) {
      const url = fresh[0].url.replace(/\/$/, "");
      _cached = { at: Date.now(), url };
      return url;
    }
  } catch { /* fall through */ }
  return "";
}

// ── Settings ──────────────────────────────────────────────
export type Settings = {
  content: {
    channel: "horror" | "wisdom";
    tone: string;
    target_word_min: number;
    target_word_max: number;
    manual_premise: string;
    videos_per_run: number;
  };
  voice: Record<string, any>;
  video: Record<string, any>;
  upload: Record<string, any>;
  keywords: Record<string, string[]>;
  music_keywords: Record<string, string>;
  providers: Record<string, boolean>;
  image_gen?: {
    // Left-to-right priority; unknown names skipped. Names must be
    // one of "huggingface" | "local_sdxl" | "pollinations".
    priority: string[];
    // Per-provider master switch. Keyed by provider name. Falsy → skipped.
    enabled: Record<string, boolean>;
    // Legacy alt keys the Python side wrote at various points; UI reads
    // whichever exists so a stale settings row from an older worker
    // doesn't wipe user toggles on first load.
    // Local SDXL model id (HuggingFace repo). "" = default from config.
    local_sdxl_model?: string;
    // Local Flux 2 klein-4B model id (HuggingFace repo). Kaggle T4×2 only.
    // "" = default black-forest-labs/FLUX.2-klein-4B.
    local_flux2_klein_model?: string;
    // How many shots to fetch in parallel per render. 3 = ~12-15 GB
    // VRAM on a P100/T4. Cap 6.
    shot_parallelism?: number;
    // Applied to every provider that has a native negative_prompt field.
    // For Pollinations Flux (no native field) it's appended as a
    // plain-language "avoid: …" clause.
    negative_prompt: string;
  };
};
export const getSettings = () => call<Settings>("/api/settings");
export const putSettings = (s: Settings) =>
  call<{ ok: true }>("/api/settings", { method: "PUT", body: JSON.stringify(s) });

// ── Keys ──────────────────────────────────────────────────
export type KeyStatus = { set: boolean; masked: string; managed?: boolean };
export const getKeys = () => call<Record<string, KeyStatus>>("/api/keys");
export const putKeys = (updates: Record<string, string | null>) =>
  call<{ ok: true }>("/api/keys", { method: "PUT", body: JSON.stringify({ updates }) });

// ── Jobs queue ────────────────────────────────────────────
export type Job = {
  id: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  channel: string;
  dry_run: boolean;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  percent: number;
  current_step: string | null;
  current_step_label: string | null;
  video_url: string | null;     // backend-relative download
  public_url: string | null;    // remote/Hostinger URL once uploaded
  error: string | null;
  run_id: string | null;
};
export const submitJob = (channel: string, dry_run: boolean) =>
  call<Job>("/api/jobs", { method: "POST", body: JSON.stringify({ channel, dry_run }) });
export const listJobs = () => call<Job[]>("/api/jobs");
export const getJob = (id: string) => call<Job>(`/api/jobs/${id}`);
export const cancelJob = (id: string) =>
  call<{ ok: true }>(`/api/jobs/${id}`, { method: "DELETE" });

export type QueueStatus = {
  busy: boolean;
  queue_depth: number;
  instance_id: string;
  public_url: string;
  status: "available" | "busy";
  storage_configured: boolean;
};
export const getQueueStatus = () => call<QueueStatus>("/api/queue");

// ── Past runs (raw, on-backend) ───────────────────────────
export type Run = {
  run_id: string;
  ok?: boolean;
  channel?: string;
  dry_run?: boolean;
  started_at?: string;
  finished_at?: string;
  has_video?: boolean;
  steps?: Record<string, { ok: boolean; seconds: number; skipped?: boolean; error?: string }>;
  shots?: Array<{
    start: number; end: number;
    narration_excerpt: string;
    visual_description: string;
    search_query: string;
    ai_prompt: string;
  }>;
  storyboard_fallback?: boolean;
  video_id?: string;
  video_url?: string;
  title?: string;
  // Populated by side_jobs.publish_youtube on success.
  youtube_video_id?: string;
  youtube_url?: string;
  youtube_account_id?: string;
  published_at?: number;
  // Populated by side_jobs.copy_storage: each entry a provider mirror.
  mirrors?: Array<{ provider_id: string; url: string; copied_at: number }>;
};
export const listRuns = () => call<Run[]>("/api/runs");
export const getRun = (id: string) => call<Run>(`/api/runs/${id}`);
export const deleteRun = (id: string) =>
  call<{ ok: true }>(`/api/runs/${id}`, { method: "DELETE" });

export async function runVideoUrl(id: string): Promise<string> {
  const base = await pickActiveWorkerUrl();
  return base ? `${base}/api/runs/${id}/video` : `/api/runs/${id}/video`;
}

// ── Misc ──────────────────────────────────────────────────
export const getPreflight = () => call<{ ok: boolean; error?: string }>("/api/preflight");

/** Edge voice catalogue — direct to worker (static list from the
 * backend, no orchestration value in proxying through Vercel). */
export async function getEdgeVoices(): Promise<string[]> {
  const base = await pickActiveWorkerUrl();
  if (!base) return [];
  try {
    const r = await fetch(`${base}/api/edge-voices`, { cache: "no-store" });
    if (!r.ok) return [];
    return (await r.json()) as string[];
  } catch { return []; }
}

/**
 * Inspect the registry directly. Returns the list of live backends (after
 * pruning stale ones), or an empty array if the registry is unreachable
 * or empty. Bypasses the backend resolver — used by the launch banner to
 * decide whether to show "click to start".
 */
export async function fetchLiveBackends(): Promise<RegistryEntry[]> {
  const fixed = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (fixed) {
    // Fixed backend overrides discovery — pretend it's always available.
    return [{
      instance_id: "fixed", url: fixed, status: "available",
      queue_depth: 0, last_seen: Date.now() / 1000,
    }];
  }

  // Preferred path — same-origin /api/backends. Works on every
  // deployment (Coolify / Vercel / local), returns URL-less
  // outbound-poll workers too.
  try {
    const r = await fetch("/api/backends", { cache: "no-store" });
    if (r.ok) {
      const list = (await r.json()) as RegistryEntry[];
      if (Array.isArray(list) && list.length > 0) return list;
    }
  } catch { /* fall through */ }

  // Firestore JS SDK path — only reachable when NEXT_PUBLIC_FIREBASE_
  // CONFIG is set. Kept for the legacy Vercel + Firebase deploys.
  if (isFirestoreConfigured()) {
    return _readBackendsFromFirestore();
  }
  return _readBackendsFromRegistryFiles();
}

export const COLAB_URL = process.env.NEXT_PUBLIC_COLAB_URL || "";

// Backward-compat type for older components.
export type RunState = {
  status: "idle" | "running" | "complete" | "failed";
  run_id?: string;
  channel?: string;
  dry_run?: boolean;
  started_at?: number;
  updated_at?: number;
  percent?: number;
  current_step?: string;
  current_step_label?: string;
  video_path?: string | null;
  video_url?: string | null;
  error?: string;
};

// Backward-compat aliases — old code path expected these:
export const startRun = submitJob;

/**
 * Cancel the currently running (or queued) job, whichever is most recent.
 * Returns true if a job was found and cancelled, false otherwise.
 */
export async function cancelRun(): Promise<{ ok: boolean }> {
  try {
    const jobs = await listJobs();
    const target = jobs.find(
      (j) => j.status === "running" || j.status === "queued",
    );
    if (!target) return { ok: false };
    await cancelJob(target.id);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ── Live logs ──────────────────────────────────────────────
export type LogEntry = {
  seq: number;
  time: number;       // epoch seconds
  level: string;      // "INFO" | "WARNING" | "ERROR" | "DEBUG" | ...
  name: string;       // logger name
  msg: string;
};
export type LogPage = { entries: LogEntry[]; head_seq: number };

/**
 * Logs are an in-process ring buffer on each worker. The Vercel gateway
 * doesn't proxy them (would 5×-multiply the polling cost). Direct fetch
 * to whichever worker is currently picked.
 */
export async function fetchLogs(since: number, limit = 500): Promise<LogPage> {
  const base = await pickActiveWorkerUrl();
  if (!base) return { entries: [], head_seq: 0 };
  const r = await fetch(
    `${base}/api/logs?since=${since}&limit=${limit}`,
    { cache: "no-store" },
  );
  if (!r.ok) return { entries: [], head_seq: 0 };
  return r.json() as Promise<LogPage>;
}

export async function clearLogs(): Promise<{ ok: boolean }> {
  const base = await pickActiveWorkerUrl();
  if (!base) return { ok: false };
  const r = await fetch(`${base}/api/logs`, {
    method: "DELETE",
    cache: "no-store",
  });
  return { ok: r.ok };
}

// ── Resource stats (Monitor page) ──────────────────────────
export type BackendStats = {
  uptime_seconds: number;
  instance_id?: string | null;
  instance_tier?: string | null;
  instance_label?: string | null;
  public_url?: string | null;
  now: number;
  active_job_id?: string | null;
  active_job?: {
    id: string;
    run_id?: string | null;
    channel?: string;
    percent?: number;
    current_step?: string;
    current_step_label?: string;
    started_at?: number;
  } | null;
  queue_depth?: number;
  busy?: boolean;
  cpu_percent?: number;
  cpu_count?: number;
  mem_used_mb?: number;
  mem_total_mb?: number;
  mem_percent?: number;
  disk_used_gb?: number;
  disk_total_gb?: number;
  disk_percent?: number;
  load_avg?: number[];
  gpu?: {
    name: string;
    util_percent: number;
    mem_used_mb: number;
    mem_total_mb: number;
    mem_percent: number;
    temp_c?: number | null;
  } | null;
  encoder?: {
    name: string;   // "h264_nvenc" | "libx264" | "unknown"
    kind: string;   // "gpu" | "cpu" | "unknown"
  };
  storage?: {
    primary_configured?: boolean;
    secondary_configured?: boolean;
    r2_public_url?: string;
    r2_max_gb?: number;
    r2_video_bytes?: number;
    r2_video_gb?: number;
  };
  error?: string;
};

/**
 * Fetch /api/stats from a specific backend URL (NOT through the global
 * resolveBackend, because the Monitor page polls all backends in
 * parallel — each one needs its own absolute URL).
 */
export async function fetchStatsFor(backendUrl: string): Promise<BackendStats | null> {
  try {
    const url = backendUrl.replace(/\/$/, "") + "/api/stats";
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as BackendStats;
  } catch {
    return null;
  }
}
export const getState = async () => {
  // Convert the latest job's state into the old RunState shape so existing
  // components keep working with minimal changes.
  try {
    const jobs = await listJobs();
    const active = jobs.find((j) => j.status === "running" || j.status === "queued");
    const latest = active || jobs[0];
    if (!latest) return { status: "idle" as const };
    return {
      status: latest.status as any,
      run_id: latest.run_id || latest.id,
      channel: latest.channel,
      dry_run: latest.dry_run,
      started_at: latest.started_at || undefined,
      updated_at: Date.now() / 1000,
      percent: latest.percent,
      current_step: latest.current_step || undefined,
      current_step_label: latest.current_step_label || undefined,
      video_path: latest.video_url || undefined,
      video_url: latest.public_url || undefined,
      error: latest.error || undefined,
    };
  } catch {
    return { status: "idle" as const };
  }
};
export const resetState = () => Promise.resolve({ ok: true });

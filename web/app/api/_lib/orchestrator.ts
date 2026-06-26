/**
 * Shared helpers for the Vercel API routes — backend discovery,
 * worker dispatch, idempotency, observability.
 */
import { adminDb, FieldValue, isAdminConfigured } from "@/lib/firebase-admin";

export const FRESHNESS_SECONDS = 180;

export type WorkerEntry = {
  instance_id: string;
  url: string;
  status: "available" | "busy";
  queue_depth: number;
  tier: "gpu" | "cpu";
  label?: string | null;
  last_seen_epoch: number;
};

function _toEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "_seconds" in v) {
    const t = v as { _seconds: number; _nanoseconds?: number };
    return t._seconds + (t._nanoseconds ?? 0) / 1e9;
  }
  if (typeof v === "object" && v !== null && "seconds" in v) {
    const t = v as { seconds: number; nanoseconds?: number };
    return t.seconds + (t.nanoseconds ?? 0) / 1e9;
  }
  return null;
}

/**
 * Return the list of live workers, sorted best-first.
 *
 * Ranking: GPU available → CPU available → GPU busy → CPU busy.
 * Within a tier+status group, lowest queue_depth wins.
 *
 * Empty list = no workers alive. The caller decides whether to queue
 * the job for later pickup or surface an error.
 */
export async function pickWorkers(): Promise<WorkerEntry[]> {
  if (!isAdminConfigured()) return [];
  try {
    const snap = await adminDb().collection("backends").get();
    const cutoff = Date.now() / 1000 - FRESHNESS_SECONDS;
    const live: WorkerEntry[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const last = _toEpoch(d.last_seen);
      if (last !== null && last < cutoff) return;
      const url = String(d.url || "");
      if (!url) return;
      live.push({
        instance_id: doc.id,
        url,
        status: d.status === "busy" ? "busy" : "available",
        queue_depth: Number(d.queue_depth ?? 0),
        tier: d.tier === "cpu" ? "cpu" : "gpu",
        label: (d.label as string) ?? null,
        last_seen_epoch: last ?? Date.now() / 1000,
      });
    });
    return live.sort((a, b) => {
      const score = (e: WorkerEntry) =>
        (e.tier === "cpu" ? 2 : 0) + (e.status === "busy" ? 1 : 0);
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.queue_depth - b.queue_depth;
    });
  } catch (e) {
    console.warn("pickWorkers failed:", e);
    return [];
  }
}

/**
 * Lightweight request ID for traceability. Vercel functions get a
 * req_id; the same id is forwarded as X-Request-Id to the worker and
 * stamped onto the Firestore job doc.
 */
export function newRequestId(): string {
  // 10 chars of url-safe entropy — collision-resistant for our scale
  // (single-digit jobs/day) and trivial to grep across logs.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function logRoute(reqId: string, msg: string, extra?: Record<string, unknown>) {
  // One-line JSON log per call — Vercel Logs UI parses these as structured.
  const line = { req_id: reqId, msg, ...(extra || {}) };
  console.log(JSON.stringify(line));
}

/** Stamp the job document in Firestore. Merges on top of existing fields. */
export async function upsertJob(jobId: string, patch: Record<string, unknown>) {
  await adminDb().collection("jobs").doc(jobId).set(
    { ...patch, updated_at: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

/** Resolve `Idempotency-Key` (optional). Returns the previously-stored
 * job_id if the same key was used in the last 60 seconds. */
export async function lookupIdempotent(key: string): Promise<string | null> {
  if (!key) return null;
  try {
    const ref = adminDb().collection("idempotency").doc(key);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const d = snap.data() as { job_id?: string; expires_at?: number } | undefined;
    if (!d) return null;
    if (d.expires_at && d.expires_at < Date.now() / 1000) return null;
    return d.job_id || null;
  } catch (e) {
    console.warn("lookupIdempotent failed:", e);
    return null;
  }
}

export async function storeIdempotent(key: string, jobId: string) {
  if (!key) return;
  try {
    await adminDb().collection("idempotency").doc(key).set({
      job_id: jobId,
      created_at: FieldValue.serverTimestamp(),
      expires_at: Date.now() / 1000 + 60, // 60-second TTL
    });
  } catch (e) {
    console.warn("storeIdempotent failed:", e);
  }
}

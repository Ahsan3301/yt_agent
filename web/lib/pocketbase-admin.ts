/**
 * Pocketbase-backed adapter exposing the same call shape as the
 * Firestore Admin SDK.
 *
 * Route code (32 files) keeps calling:
 *   db.collection("jobs").doc(jobId).set({...})
 *   db.collection("channels").where("enabled", "==", true).get()
 *   const batch = db.batch(); batch.update(ref, ...); await batch.commit();
 *
 * Internally that becomes PB REST calls. The shim is intentionally
 * tight in scope — it implements ONLY the operations the existing
 * routes use (mapped via grep), not the full Firestore surface. New
 * operations get added here as needed.
 *
 * Activated when DB_BACKEND=pocketbase. Firestore stays default.
 *
 * Auth: PB_SERVER_TOKEN env var — a service token that bypasses
 * Pocketbase access rules. Generate with `openssl rand -hex 32`,
 * paste into both Coolify env vars AND set the same value as a
 * Pocketbase admin under Settings → API tokens.
 */

const PB_URL = (process.env.PB_URL_INTERNAL || process.env.NEXT_PUBLIC_PB_URL || "").replace(/\/$/, "");
const PB_TOKEN = process.env.PB_SERVER_TOKEN || "";

// Sentinel for server timestamp — recognised by the upsert path which
// substitutes the current epoch seconds on the server side.
export const SERVER_TIMESTAMP = Symbol.for("pb.server_timestamp");

// FieldValue shim mirroring firebase-admin's API surface.
// Only serverTimestamp() is actively used in our routes.
export const PBFieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
  delete: () => null, // PB doesn't have a delete sentinel; null clears.
};

// ── Internal helpers ──────────────────────────────────────────────

function _headers(): HeadersInit {
  return {
    "Authorization": PB_TOKEN,
    "Content-Type": "application/json",
  };
}

/** Strip our Symbol sentinels, replacing them with concrete values
 * before the PB request. */
function _serialise(data: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === SERVER_TIMESTAMP) {
      out[k] = now;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      // Recurse into nested objects (for the `extras` / `doc` JSON columns).
      out[k] = _serialise(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Sanitize an arbitrary string into a Pocketbase-legal id. */
function _pbId(id: string): string {
  // PB ids are 15 chars, [a-z0-9]+. If the incoming id matches that
  // already, reuse it. Otherwise hash to a deterministic 15-char id.
  if (/^[a-z0-9]{15}$/.test(id)) return id;
  // Deterministic short hash via Node crypto.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto");
  const h = createHash("sha256").update(id).digest("base64")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  return h.slice(0, 15);
}

/** Translate Firestore-style filter triples to PB filter strings.
 * Examples:
 *   ["enabled", "==", true]   → "enabled = true"
 *   ["status", "in", ["a","b"]] → "(status = 'a' || status = 'b')"
 */
function _filterExpr(field: string, op: string, value: unknown): string {
  const v = _filterValue(value);
  switch (op) {
    case "==":  return `${field} = ${v}`;
    case "!=":  return `${field} != ${v}`;
    case "<":   return `${field} < ${v}`;
    case "<=":  return `${field} <= ${v}`;
    case ">":   return `${field} > ${v}`;
    case ">=":  return `${field} >= ${v}`;
    case "in":
      if (Array.isArray(value)) {
        return "(" + value.map((x) => `${field} = ${_filterValue(x)}`).join(" || ") + ")";
      }
      return `${field} = ${v}`;
    case "array-contains":
      return `${field} ~ ${v}`;
    default:
      throw new Error(`Unsupported filter op: ${op}`);
  }
}

function _filterValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "\\'")}'`;
}

// ── Doc + Collection + Query API ──────────────────────────────────

interface DocSnapshot {
  exists: boolean;
  id: string;
  data: () => Record<string, unknown> | undefined;
  ref: DocRef;
}

interface QuerySnapshot {
  empty: boolean;
  size: number;
  docs: DocSnapshot[];
  forEach: (cb: (snap: DocSnapshot) => void) => void;
}

class DocRef {
  constructor(public readonly collection: string, public readonly id: string) {}

  get path(): string {
    return `${this.collection}/${this.id}`;
  }

  async get(): Promise<DocSnapshot> {
    const pbId = _pbId(this.id);
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
      { headers: _headers(), cache: "no-store" },
    );
    if (r.status === 404) {
      return { exists: false, id: this.id, data: () => undefined, ref: this };
    }
    if (!r.ok) throw new Error(`PB get ${this.path}: HTTP ${r.status}`);
    const rec = await r.json();
    return {
      exists: true,
      id: this.id,
      data: () => _stripPBFields(rec),
      ref: this,
    };
  }

  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    const pbId = _pbId(this.id);
    const body = { ..._serialise(data), id: pbId };
    // PATCH first — succeeds for both merge and overwrite cases on PB
    // since PATCH on a record is a partial update. If record missing,
    // 404 → fall through to POST.
    if (opts?.merge !== false) {
      const r = await fetch(
        `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
        { method: "PATCH", headers: _headers(), body: JSON.stringify(body) },
      );
      if (r.ok) return;
      if (r.status !== 404) {
        throw new Error(`PB set ${this.path}: HTTP ${r.status}: ${await r.text()}`);
      }
    }
    // CREATE.
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records`,
      { method: "POST", headers: _headers(), body: JSON.stringify(body) },
    );
    if (!r.ok) {
      throw new Error(`PB create ${this.path}: HTTP ${r.status}: ${await r.text()}`);
    }
  }

  async update(data: Record<string, unknown>): Promise<void> {
    const pbId = _pbId(this.id);
    const body = _serialise(data);
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
      { method: "PATCH", headers: _headers(), body: JSON.stringify(body) },
    );
    if (!r.ok) {
      throw new Error(`PB update ${this.path}: HTTP ${r.status}: ${await r.text()}`);
    }
  }

  async delete(): Promise<void> {
    const pbId = _pbId(this.id);
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
      { method: "DELETE", headers: _headers() },
    );
    if (!r.ok && r.status !== 404) {
      throw new Error(`PB delete ${this.path}: HTTP ${r.status}`);
    }
  }
}

class Query {
  private filters: string[] = [];
  private sort: string[] = [];
  private _limit = 0;

  constructor(private readonly collection: string) {}

  where(field: string, op: string, value: unknown): Query {
    this.filters.push(_filterExpr(field, op, value));
    return this;
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): Query {
    this.sort.push((dir === "desc" ? "-" : "+") + field);
    return this;
  }

  limit(n: number): Query {
    this._limit = Math.max(1, Math.min(500, n));
    return this;
  }

  async get(): Promise<QuerySnapshot> {
    const params = new URLSearchParams();
    if (this.filters.length) params.set("filter", this.filters.join(" && "));
    if (this.sort.length)    params.set("sort", this.sort.join(","));
    params.set("perPage", String(this._limit || 200));
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records?${params.toString()}`,
      { headers: _headers(), cache: "no-store" },
    );
    if (!r.ok) throw new Error(`PB query ${this.collection}: HTTP ${r.status}`);
    const data = await r.json();
    const items: { id: string }[] = data.items || [];
    const docs: DocSnapshot[] = items.map((rec) => ({
      exists: true,
      id: rec.id,
      data: () => _stripPBFields(rec as Record<string, unknown>),
      ref: new DocRef(this.collection, rec.id),
    }));
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
      forEach: (cb) => docs.forEach(cb),
    };
  }
}

/** Strip PB-internal fields (collectionId, collectionName, created,
 * updated) so callers see the same shape as Firestore docs. */
function _stripPBFields(rec: Record<string, unknown>): Record<string, unknown> {
  const out = { ...rec };
  delete out.collectionId;
  delete out.collectionName;
  delete out.created;
  delete out.updated;
  delete out.expand;
  return out;
}

class Collection extends Query {
  constructor(public readonly name: string) {
    super(name);
  }

  doc(id: string): DocRef {
    return new DocRef(this.name, id);
  }
}

// ── Batch ─────────────────────────────────────────────────────────
// PB has no native batch endpoint. We emulate with parallel requests
// at commit() time. Atomicity is best-effort (one failure logs but
// doesn't roll back) — matches how our routes use batches today
// (mostly for the single-primary invariant flip, where the worst
// failure mode is "two primaries until next save" — not fatal).

type BatchOp =
  | { kind: "set"; ref: DocRef; data: Record<string, unknown>; merge?: boolean }
  | { kind: "update"; ref: DocRef; data: Record<string, unknown> }
  | { kind: "delete"; ref: DocRef };

class Batch {
  private ops: BatchOp[] = [];

  set(ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): Batch {
    this.ops.push({ kind: "set", ref, data, merge: opts?.merge });
    return this;
  }

  update(ref: DocRef, data: Record<string, unknown>): Batch {
    this.ops.push({ kind: "update", ref, data });
    return this;
  }

  delete(ref: DocRef): Batch {
    this.ops.push({ kind: "delete", ref });
    return this;
  }

  async commit(): Promise<void> {
    await Promise.all(this.ops.map(async (op) => {
      if (op.kind === "set")    return op.ref.set(op.data, { merge: op.merge });
      if (op.kind === "update") return op.ref.update(op.data);
      if (op.kind === "delete") return op.ref.delete();
    }));
  }
}

// ── Public client ─────────────────────────────────────────────────

export class PocketBaseAdminClient {
  collection(name: string): Collection {
    return new Collection(name);
  }
  batch(): Batch {
    return new Batch();
  }
}

let _client: PocketBaseAdminClient | null = null;

export function pbAdminDb(): PocketBaseAdminClient {
  if (!PB_URL) {
    throw new Error("PB_URL or PB_URL_INTERNAL must be set for Pocketbase backend");
  }
  if (!PB_TOKEN) {
    throw new Error("PB_SERVER_TOKEN must be set for Pocketbase backend");
  }
  if (!_client) _client = new PocketBaseAdminClient();
  return _client;
}

export function isPocketbaseConfigured(): boolean {
  return !!(PB_URL && PB_TOKEN);
}

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
const PB_ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL || "";
const PB_ADMIN_PASSWORD = process.env.POCKETBASE_ADMIN_PASSWORD || "";

// Cached superuser auth token. Pocketbase's _superusers auth-with-password
// endpoint returns a token good for ~30 days; we refresh hourly to be
// safe. PB_SERVER_TOKEN, if set, is preferred (lets you rotate a static
// long-lived superuser token without rebooting the dashboard).
let _authToken: string | null = null;
let _authExpiresAt = 0;

async function _ensureAuthToken(): Promise<string> {
  // Cached login token still good?
  if (_authToken && Date.now() < _authExpiresAt) return _authToken;
  // Pocketbase doesn't support pre-issued static service tokens — the
  // only valid auth is a fresh JWT from auth-with-password. So
  // PB_SERVER_TOKEN is currently unused; we keep the env var for
  // future-proofing in case PB adds opaque tokens.
  void PB_TOKEN;
  // Admin (superuser) login.
  if (!PB_ADMIN_EMAIL || !PB_ADMIN_PASSWORD) {
    throw new Error(
      "Pocketbase auth not configured — set PB_SERVER_TOKEN OR " +
      "POCKETBASE_ADMIN_EMAIL + POCKETBASE_ADMIN_PASSWORD",
    );
  }
  const r = await fetch(
    `${PB_URL}/api/collections/_superusers/auth-with-password`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: PB_ADMIN_EMAIL,
        password: PB_ADMIN_PASSWORD,
      }),
    },
  );
  if (!r.ok) {
    throw new Error(
      `Pocketbase superuser auth failed: HTTP ${r.status} — ${await r.text().catch(() => "")}`,
    );
  }
  const j = await r.json();
  _authToken = String(j.token || "");
  // 30-day token; refresh every hour to be safe.
  _authExpiresAt = Date.now() + 60 * 60 * 1000;
  if (!_authToken) throw new Error("Pocketbase auth response missing token");
  return _authToken;
}

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

async function _headers(): Promise<HeadersInit> {
  const token = await _ensureAuthToken();
  return {
    "Authorization": token,
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

/** Generate a fresh 15-char PB-valid id. Used when callers do
 * `.doc()` with no args (Firestore auto-id parity). */
function _autoPbId(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require("node:crypto");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(15);
  let out = "";
  for (let i = 0; i < 15; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Subcollection → flat-collection mapping. Mirrors backend/db_pocketbase.py.
// Firestore allows `db.collection("X").doc("Y").collection("Z")` for
// nested children; PB has no subcollections, so we route writes here
// to a flat top-level collection with a foreign-key field.
const _SUBCOLLECTION_MAP: Record<string, { flat: string; fk: string }> = {
  "runs_index/logs": { flat: "run_logs", fk: "run_id" },
};

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
  // Inherited from Collection._autoInject when this doc came from a
  // subcollection-mapped parent (parent.doc(x).collection("logs") →
  // every write injects run_id=x automatically).
  public autoInject: Record<string, unknown> = {};

  constructor(public readonly collection: string, public readonly id: string) {}

  get path(): string {
    return `${this.collection}/${this.id}`;
  }

  /** Subcollection access — maps to a flat collection per
   * _SUBCOLLECTION_MAP. */
  subcollection(name: string): Collection {
    const key = `${this.collection}/${name}`;
    const m = _SUBCOLLECTION_MAP[key];
    if (!m) {
      throw new Error(`No subcollection mapping for ${this.path}/${name}`);
    }
    const coll = new Collection(m.flat);
    coll.autoFilter = { field: m.fk, op: "==", value: this.id };
    coll.autoInject = { [m.fk]: this.id };
    return coll;
  }

  async get(): Promise<DocSnapshot> {
    const pbId = _pbId(this.id);
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
      { headers: await _headers(), cache: "no-store" },
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
    const body = { ...this.autoInject, ..._serialise(data), id: pbId };
    // PATCH first — succeeds for both merge and overwrite cases on PB
    // since PATCH on a record is a partial update. If record missing,
    // 404 → fall through to POST.
    if (opts?.merge !== false) {
      const r = await fetch(
        `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
        { method: "PATCH", headers: await _headers(), body: JSON.stringify(body) },
      );
      if (r.ok) return;
      if (r.status !== 404) {
        throw new Error(`PB set ${this.path}: HTTP ${r.status}: ${await r.text()}`);
      }
    }
    // CREATE.
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records`,
      { method: "POST", headers: await _headers(), body: JSON.stringify(body) },
    );
    if (!r.ok) {
      throw new Error(`PB create ${this.path}: HTTP ${r.status}: ${await r.text()}`);
    }
  }

  async update(data: Record<string, unknown>): Promise<void> {
    const pbId = _pbId(this.id);
    const body = { ...this.autoInject, ..._serialise(data) };
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
      { method: "PATCH", headers: await _headers(), body: JSON.stringify(body) },
    );
    if (!r.ok) {
      throw new Error(`PB update ${this.path}: HTTP ${r.status}: ${await r.text()}`);
    }
  }

  async delete(): Promise<void> {
    const pbId = _pbId(this.id);
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records/${pbId}`,
      { method: "DELETE", headers: await _headers() },
    );
    if (!r.ok && r.status !== 404) {
      throw new Error(`PB delete ${this.path}: HTTP ${r.status}`);
    }
  }
}

class Query {
  protected filters: string[] = [];
  protected sort: string[] = [];
  protected _limit = 0;
  // For subcollection-mapped Collections — read-side filter
  // automatically applied to every get() / count(). Writes use
  // autoInject (lives on Collection, propagates to DocRef via doc()).
  public autoFilter: { field: string; op: string; value: unknown } | null = null;

  constructor(protected readonly collection: string) {}

  where(field: string, op: string, value: unknown): Query {
    // Empty `in` array would produce malformed filter — Firestore
    // returns 0 results in that case; mirror that here.
    if (op === "in" && Array.isArray(value) && value.length === 0) {
      this.filters.push("id = '__never_matches__'");
      return this;
    }
    this.filters.push(_filterExpr(field, op, value));
    return this;
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): Query {
    // PB doesn't index fields that don't exist on every row — gracefully
    // accept ordering by the system 'created'/'updated' synonyms which
    // every PB record has.
    const f = field === "created_at" ? "created"
            : field === "updated_at" ? "updated"
            : field;
    this.sort.push((dir === "desc" ? "-" : "+") + f);
    return this;
  }

  limit(n: number): Query {
    if (n === 0) this._limit = 0;
    else this._limit = Math.max(1, Math.min(500, n));
    return this;
  }

  /** Firestore-compat: returns { get(): { data(): { count } } } */
  count(): { get(): Promise<{ data(): { count: number } }> } {
    const self = this;
    return {
      async get() {
        const params = new URLSearchParams();
        const fil = [...self.filters];
        if (self.autoFilter) {
          fil.push(_filterExpr(self.autoFilter.field, self.autoFilter.op, self.autoFilter.value));
        }
        if (fil.length) params.set("filter", fil.join(" && "));
        params.set("perPage", "1");
        const r = await fetch(
          `${PB_URL}/api/collections/${self.collection}/records?${params.toString()}`,
          { headers: await _headers(), cache: "no-store" },
        );
        if (!r.ok) return { data: () => ({ count: 0 }) };
        const data = await r.json();
        return { data: () => ({ count: Number(data.totalItems || 0) }) };
      },
    };
  }

  async get(): Promise<QuerySnapshot> {
    const params = new URLSearchParams();
    const filters = [...this.filters];
    if (this.autoFilter) {
      filters.push(_filterExpr(this.autoFilter.field, this.autoFilter.op, this.autoFilter.value));
    }
    if (filters.length) params.set("filter", filters.join(" && "));
    if (this.sort.length) params.set("sort", this.sort.join(","));
    // limit(0) → return empty without hitting the API (Firestore parity).
    if (this._limit === 0 && (this.filters.length || this.sort.length)) {
      // Explicit limit-zero still after where/orderBy chain
    }
    params.set("perPage", String(this._limit || 200));
    const r = await fetch(
      `${PB_URL}/api/collections/${this.collection}/records?${params.toString()}`,
      { headers: await _headers(), cache: "no-store" },
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
  // Inherited from a subcollection-mapped parent's .subcollection(name) —
  // every write through .doc() inherits these fields automatically.
  public autoInject: Record<string, unknown> = {};

  constructor(public readonly name: string) {
    super(name);
  }

  doc(id?: string): DocRef {
    // No id → Firestore-parity auto-generated id.
    const useId = id && id.trim().length > 0 ? id : _autoPbId();
    const ref = new DocRef(this.name, useId);
    if (Object.keys(this.autoInject).length > 0) {
      ref.autoInject = { ...this.autoInject };
    }
    return ref;
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
  if (!PB_TOKEN && !(PB_ADMIN_EMAIL && PB_ADMIN_PASSWORD)) {
    throw new Error(
      "Pocketbase auth not configured — set PB_SERVER_TOKEN OR " +
      "POCKETBASE_ADMIN_EMAIL + POCKETBASE_ADMIN_PASSWORD",
    );
  }
  if (!_client) _client = new PocketBaseAdminClient();
  return _client;
}

export function isPocketbaseConfigured(): boolean {
  return !!(PB_URL && (PB_TOKEN || (PB_ADMIN_EMAIL && PB_ADMIN_PASSWORD)));
}

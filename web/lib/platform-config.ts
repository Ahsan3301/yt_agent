import { adminDb } from "@/lib/firebase-admin";

/**
 * Dashboard-editable platform configuration.
 *
 * Reads a value from the `platform_config` collection, falling back to
 * the process environment when unset. That ordering is what makes
 * settings editable without a redeploy: whatever the operator saves in
 * /superadmin/config wins over the baked-in env var, takes effect
 * within a second, and survives the next deploy.
 *
 * Env stays the fallback rather than being removed, so:
 *   - nothing breaks during migration (an unset row behaves exactly as
 *     before),
 *   - a fresh install boots from env with no seeding step,
 *   - and the database being briefly unreachable degrades to the old
 *     behaviour instead of to "unconfigured".
 *
 * Cache: 5s TTL plus explicit invalidation on write. Short enough to
 * feel immediate, long enough that a burst of requests doesn't hammer
 * PocketBase (which is a single SQLite writer).
 */

const CACHE_TTL_MS = 5_000;

let _cache: { at: number; map: Map<string, string> } | null = null;
let _inflight: Promise<Map<string, string>> | null = null;

/**
 * Keys that must NOT be served from the database.
 *
 *   Bootstrap — these are how we reach the database in the first
 *   place, so reading them from it is circular.
 *
 *   SESSION_SECRET — authenticates the cookie that authorises reading
 *   config at all.
 *
 *   NEXT_PUBLIC_* — Next.js inlines these into the client bundle at
 *   build time. No runtime value can change a string already compiled
 *   into the JavaScript the browser downloaded. Handled separately by
 *   the /api/public-config endpoint for values that need to be
 *   runtime-editable on the client.
 */
const ENV_ONLY = new Set([
  "POCKETBASE_ADMIN_EMAIL",
  "POCKETBASE_ADMIN_PASSWORD",
  "PB_URL_INTERNAL",
  "DB_BACKEND",
  "SESSION_SECRET",
  "NODE_ENV",
]);

export function isEnvOnly(key: string): boolean {
  return ENV_ONLY.has(key) || key.startsWith("NEXT_PUBLIC_");
}

async function _load(): Promise<Map<string, string>> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.map;
  // Collapse concurrent misses into one read.
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const snap = await adminDb().collection("platform_config").limit(500).get();
      const map = new Map<string, string>();
      snap.forEach((doc) => {
        const d = (doc.data() || {}) as { key?: string; value?: string };
        const k = String(d.key || "").trim();
        const v = String(d.value ?? "");
        if (k && v !== "") map.set(k, v);
      });
      _cache = { at: Date.now(), map };
      return map;
    } catch (e) {
      // Keep serving the last good snapshot; otherwise fall through to
      // env-only for this call rather than pretending nothing is set.
      console.error("[platform-config] read failed, using", _cache ? "stale cache" : "env only", e);
      return _cache?.map ?? new Map<string, string>();
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

/** Invalidate immediately after a write so the change is live at once. */
export function bustConfigCache(): void {
  _cache = null;
}

/** DB value if present, else the environment variable, else fallback. */
export async function getConfig(key: string, fallback = ""): Promise<string> {
  if (isEnvOnly(key)) return process.env[key] ?? fallback;
  const map = await _load();
  const fromDb = map.get(key);
  if (fromDb !== undefined && fromDb !== "") return fromDb;
  return process.env[key] ?? fallback;
}

/** Batch form — one cache read for several keys. */
export async function getConfigMany(keys: string[]): Promise<Record<string, string>> {
  const map = await _load();
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (isEnvOnly(k)) { out[k] = process.env[k] ?? ""; continue; }
    const fromDb = map.get(k);
    out[k] = (fromDb !== undefined && fromDb !== "") ? fromDb : (process.env[k] ?? "");
  }
  return out;
}

/** Where a value is currently coming from — surfaced in the config UI
 *  so it's obvious whether an edit will actually take effect. */
export async function getConfigSource(key: string): Promise<"database" | "environment" | "unset"> {
  if (isEnvOnly(key)) return process.env[key] ? "environment" : "unset";
  const map = await _load();
  if (map.has(key)) return "database";
  return process.env[key] ? "environment" : "unset";
}

/**
 * The keys the config page exposes, with copy. Anything not listed
 * here can still be stored, but won't get a nice form field.
 *
 * Ordering within a category is the display order.
 */
export const CONFIG_SCHEMA: Array<{
  key: string; category: string; label: string; help: string; secret?: boolean;
}> = [
  // ── Backups ────────────────────────────────────────────────────
  { key: "BACKUP_S3_ENDPOINT",   category: "backup", label: "Backup endpoint",
    help: "S3-compatible URL, e.g. https://<account>.r2.cloudflarestorage.com" },
  { key: "BACKUP_S3_BUCKET",     category: "backup", label: "Backup bucket",
    help: "Destination bucket for nightly database + media backups." },
  { key: "BACKUP_S3_ACCESS_KEY", category: "backup", label: "Backup access key", secret: true,
    help: "Object Read & Write token scoped to the backup bucket." },
  { key: "BACKUP_S3_SECRET_KEY", category: "backup", label: "Backup secret key", secret: true,
    help: "Paired secret for the access key above." },
  { key: "BACKUP_S3_REGION",     category: "backup", label: "Backup region",
    help: "Leave as 'auto' for Cloudflare R2." },
  { key: "BACKUP_RETENTION_DAYS", category: "backup", label: "Keep backups for (days)",
    help: "Older snapshots are pruned locally and offsite. Default 14." },

  // ── OAuth / integrations ───────────────────────────────────────
  { key: "YOUTUBE_OAUTH_CLIENT_ID",     category: "oauth", label: "YouTube OAuth client ID",
    help: "From Google Cloud Console → Credentials. Needed to connect channels." },
  { key: "YOUTUBE_OAUTH_CLIENT_SECRET", category: "oauth", label: "YouTube OAuth client secret", secret: true,
    help: "Rotate here after resetting it in Google Cloud Console." },
  { key: "YOUTUBE_API_KEY",             category: "oauth", label: "YouTube Data API key", secret: true,
    help: "Enables real channel analysis in the Roast tool and competitor keyword lookup." },
  { key: "GITHUB_OAUTH_CLIENT_ID",      category: "oauth", label: "GitHub OAuth client ID", help: "" },
  { key: "GITHUB_OAUTH_CLIENT_SECRET",  category: "oauth", label: "GitHub OAuth client secret", secret: true, help: "" },

  // ── Operations ─────────────────────────────────────────────────
  { key: "RENDER_TRIGGER_KEY",   category: "ops", label: "Maintenance API key", secret: true,
    help: "Authenticates the cron sidecar's calls to /api/maintenance/*." },
  { key: "ORACLE_UNLOCK_PASSWORD", category: "ops", label: "Oracle worker password", secret: true,
    help: "Gates use of the CPU side-worker so its capacity isn't consumed accidentally." },
  { key: "DISCORD_WEBHOOK_URL",  category: "ops", label: "Operator alert webhook",
    help: "Where failures and signups are announced. Backup failures post here too." },
  { key: "PUBLIC_BASE_URL",      category: "ops", label: "Public base URL",
    help: "Used to build absolute links in notifications and OAuth callbacks." },
];

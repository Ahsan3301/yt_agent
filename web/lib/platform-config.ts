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
  { key: "BACKUP_STORAGE_PROVIDER_ID", category: "backup", label: "Use an existing storage provider",
    help: "Provider id from the Storage page. Preferred over re-entering keys below — the credential then lives in one place, so rotating it there updates backups too. Leave blank to use the explicit fields instead." },
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

  // ── Scheduling ─────────────────────────────────────────────────
  { key: "RENDER_LEAD_HOURS", category: "retention", label: "Start rendering this many hours before publish",
    help: "A channel's hour is the time the video should GO LIVE. Rendering begins this many hours earlier and the upload hands YouTube an exact publish time, so the video is released on the hour even if the render took far longer. Default 4, which covers CPU renders comfortably. Raise it if renders regularly run long; the only cost is the video sitting ready for longer." },

  // ── Retention ──────────────────────────────────────────────────
  // Blank = use the built-in default. Values below 1 are ignored
  // rather than obeyed: "0 days" would mean delete everything on the
  // next nightly sweep, which nobody means to type.
  { key: "STORAGE_MAX_GB", category: "retention", label: "Cap video storage at (GB)",
    help: "A hard ceiling on the video bucket, enforced nightly after the age rules. Blank or 0 disables it. Age alone does not bound disk: renders here average ~300 MB and ~17/day is ~5 GB/day, so a 30-day window implies ~150 GB — more than this server has, and it would fill in under two weeks. When over the cap, oldest videos are removed, PUBLISHED ones first, because those keep playing in the Library from YouTube. Unpublished files are only touched if the cap still cannot be met." },
  { key: "RETENTION_VIDEOS_DAYS", category: "retention", label: "Keep video files for (days)",
    help: "How long rendered .mp4 files stay in storage. Default 30. Deleting the file does NOT remove the video from your Library — anything already published keeps playing via its YouTube embed. Videos that were never published are gone for good, so raise this if you rely on the local copies." },
  { key: "RETENTION_RUNS_DAYS", category: "retention", label: "Keep run history for (days)",
    help: "Library rows and their summaries, including the YouTube links. Default 90. This is what preserves the record after the video file itself is deleted — keep it comfortably longer than the video window." },
  { key: "RETENTION_RUN_LOGS_DAYS", category: "retention", label: "Keep run logs for (days)",
    help: "Per-render log lines. Default 14. This is the fastest-growing table by far — it reached 112,000 rows on a single account — so shortening this is the most effective way to keep the database small." },
  { key: "RETENTION_JOBS_DAYS", category: "retention", label: "Keep finished jobs for (days)",
    help: "Completed, failed and cancelled queue entries. Default 14." },
  { key: "RETENTION_ERRORS_DAYS", category: "retention", label: "Keep error records for (days)",
    help: "Default 30." },
  { key: "RETENTION_IDEMPOTENCY_DAYS", category: "retention", label: "Keep idempotency keys for (days)",
    help: "Duplicate-submission guards. Default 7. Rarely worth changing." },

  // ── OAuth / integrations ───────────────────────────────────────
  { key: "YOUTUBE_OAUTH_CLIENT_ID",     category: "oauth", label: "YouTube OAuth client ID",
    help: "From Google Cloud Console → Credentials. Needed to connect channels." },
  { key: "YOUTUBE_OAUTH_CLIENT_SECRET", category: "oauth", label: "YouTube OAuth client secret", secret: true,
    help: "Rotate here after resetting it in Google Cloud Console." },
  { key: "YOUTUBE_API_KEY",             category: "oauth", label: "YouTube Data API key", secret: true,
    help: "Enables real channel analysis in the Roast tool and competitor keyword lookup." },
  { key: "GITHUB_OAUTH_CLIENT_ID",      category: "oauth", label: "GitHub OAuth client ID", help: "" },
  { key: "GITHUB_OAUTH_CLIENT_SECRET",  category: "oauth", label: "GitHub OAuth client secret", secret: true, help: "" },

  // ── Email (SMTP) ───────────────────────────────────────────────
  // Read at send time, never cached into a module-level transport, so
  // pasting a password here takes effect on the next email with no
  // redeploy. Until the host is set, every send is skipped — forms
  // still save to the database, they just don't notify.
  { key: "SMTP_HOST", category: "email", label: "SMTP host",
    help: "Your mail provider's outgoing server, e.g. smtp.gmail.com, smtp.resend.com, smtp-relay.brevo.com. This one field is the on/off switch: leave it blank and email is simply skipped — nothing else breaks and no form is lost." },
  { key: "SMTP_PORT", category: "email", label: "Port",
    help: "587 for STARTTLS (the usual choice), 465 for implicit TLS, 25 unencrypted. Defaults to 587 when blank. If you pick 465, also turn on 'Use TLS directly' below." },
  { key: "SMTP_SECURE", category: "email", label: "Use TLS directly",
    help: "Type 'true' only when using port 465, where the connection is encrypted from the first byte. For 587 leave this blank — the connection starts plain and upgrades via STARTTLS, which is normal and still encrypted." },
  { key: "SMTP_USER", category: "email", label: "Username",
    help: "Usually the full email address you're sending from. Some providers (Resend, Postmark) use a fixed word like 'resend' or an API-key id instead — check their SMTP page." },
  { key: "SMTP_PASSWORD", category: "email", label: "Password", secret: true,
    help: "For Gmail and most providers with 2FA this must be an app-specific password, not your account password. For API-key providers, paste the key here.", },
  { key: "SMTP_FROM", category: "email", label: "Send from",
    help: "The From address recipients see, e.g. Yven <hello@yourdomain.com>. Must be an address your provider has verified, or messages will be rejected or land in spam. Falls back to the username when blank." },
  { key: "SMTP_TO", category: "email", label: "Send notifications to",
    help: "Where contact, quote and niche-request submissions are delivered. Comma-separate for several recipients. Falls back to the From address when blank, so mail still reaches you if you forget this one." },

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

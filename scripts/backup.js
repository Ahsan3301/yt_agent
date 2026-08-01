/**
 * Offsite backup for yt-agent.
 *
 * Runs INSIDE the dashboard container (it already has Node 20 and
 * @aws-sdk/client-s3 as a dependency, so nothing extra is installed
 * on the host). It MUST live under /app/web — Node resolves modules
 * by walking up from the script's own directory, so running it from
 * /tmp fails with MODULE_NOT_FOUND even though the SDK is installed:
 *
 *   docker cp backup.js <dashboard>:/app/web/backup.js
 *   docker exec -w /app/web <dashboard> node backup.js
 *
 * What it protects
 * ----------------
 * Before this existed there were NO backups of anything. PocketBase is
 * a single SQLite file and MinIO a single bind-mount, both on one VPS
 * with no snapshots — losing that host meant losing every customer's
 * channels, credentials, job history and videos with no recovery path.
 *
 * What it does
 * ------------
 *   1. Asks PocketBase to produce a backup via its own /api/backups
 *      endpoint. This matters: PB is mid-flight writing WAL pages, so
 *      copying the .db file off disk can capture a torn snapshot. The
 *      API checkpoints properly and hands back a consistent zip.
 *   2. Uploads that zip to an external S3-compatible bucket.
 *   3. Mirrors the MinIO bucket (rendered videos) to the same place,
 *      skipping objects already present with a matching size.
 *   4. Prunes backups older than the retention window, remotely and in
 *      PB's own local backup store.
 *
 * Configuration
 * -------------
 * Set in the dashboard: Superadmin → Configuration → Backups. Values
 * are read from the platform_config collection first and the process
 * environment second, so a destination can be changed or a credential
 * rotated without a redeploy.
 *
 *   BACKUP_STORAGE_PROVIDER_ID   preferred — reuse a provider already
 *                                configured on the Storage page, so the
 *                                credential lives in exactly one place
 *   BACKUP_S3_ENDPOINT     e.g. https://<account>.r2.cloudflarestorage.com
 *   BACKUP_S3_BUCKET       destination bucket name
 *   BACKUP_S3_ACCESS_KEY
 *   BACKUP_S3_SECRET_KEY
 *   BACKUP_S3_REGION       optional, default "auto" (right for R2)
 *   BACKUP_RETENTION_DAYS  optional, default 14
 *
 * With no destination configured the script exits 0 with a notice
 * rather than failing, so it can be installed and scheduled before the
 * destination bucket exists.
 */

const {
  S3Client, PutObjectCommand, ListObjectsV2Command,
  GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const crypto = require("node:crypto");

const PB_URL      = process.env.PB_INTERNAL_URL || "http://pocketbase:8090";
const MINIO_URL   = process.env.MINIO_INTERNAL_URL || "http://minio:9000";
const SRC_BUCKET  = process.env.S3_BUCKET || "yt-agent-videos";
const RETAIN_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 14);

const log = (...a) => console.log("[backup]", ...a);

/**
 * Resolve settings the same way the dashboard does: the
 * platform_config collection first, environment second.
 *
 * This is what lets backup destinations be changed from
 * /superadmin/config without a redeploy — previously the only way to
 * point backups somewhere new was to edit Coolify env vars and
 * rebuild, which is a slow round trip for a routine operational
 * change.
 */
async function loadConfig(token) {
  const fromDb = {};
  try {
    const r = await fetch(`${PB_URL}/api/collections/platform_config/records?perPage=500`, {
      headers: { Authorization: token },
    });
    if (r.ok) {
      for (const row of (await r.json()).items || []) {
        if (row.key && row.value) fromDb[row.key] = String(row.value);
      }
    }
  } catch (e) {
    log("platform_config unreadable, falling back to environment:", e.message);
  }
  const get = (k, d = "") => fromDb[k] || process.env[k] || d;

  // A referenced storage provider wins over copied BACKUP_S3_* keys,
  // so the credential has a single home.
  const providerId = get("BACKUP_STORAGE_PROVIDER_ID");
  if (providerId) {
    try {
      const p = await loadFromStorageProvider(token, providerId);
      if (p.endpoint && p.bucket && p.accessKey && p.secretKey) {
        return {
          ...p,
          retainDays: Number(get("BACKUP_RETENTION_DAYS", "")) || RETAIN_DAYS,
          source: `storage provider "${p.label}"`,
        };
      }
      log(`storage provider ${providerId} incomplete — falling back`);
    } catch (e) {
      log(`storage provider ${providerId} unusable: ${e.message} — falling back`);
    }
  }

  return {
    endpoint:  get("BACKUP_S3_ENDPOINT"),
    bucket:    get("BACKUP_S3_BUCKET"),
    accessKey: get("BACKUP_S3_ACCESS_KEY"),
    secretKey: get("BACKUP_S3_SECRET_KEY"),
    region:    get("BACKUP_S3_REGION", "auto"),
    retainDays: Number(get("BACKUP_RETENTION_DAYS", "")) || RETAIN_DAYS,
    source: Object.keys(fromDb).some((k) => k.startsWith("BACKUP_S3_")) ? "dashboard" : "environment",
  };
}

/**
 * Decrypt a storage-provider secret.
 *
 * Mirrors web/lib/storage-crypto.ts byte-for-byte: AES-GCM, 32-byte
 * key from STORAGE_PROVIDERS_ENC_KEY (hex or base64), ciphertext
 * formatted as "v1:" + base64(nonce[12] || ct). The "b64:" and
 * unprefixed legacy forms are handled the same way it does.
 */
function decryptSecret(ciphertext) {
  if (!ciphertext) return "";
  if (ciphertext.startsWith("b64:")) {
    return Buffer.from(ciphertext.slice(4), "base64").toString("utf-8");
  }
  if (!ciphertext.startsWith("v1:")) return ciphertext;   // legacy plaintext

  const raw = (process.env.STORAGE_PROVIDERS_ENC_KEY || "").trim();
  if (!raw) throw new Error("STORAGE_PROVIDERS_ENC_KEY not set");
  const kb = /^[0-9a-fA-F]+$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (kb.length !== 32) throw new Error(`enc key must be 32 bytes, got ${kb.length}`);

  const blob  = Buffer.from(ciphertext.slice(3), "base64");
  const nonce = blob.subarray(0, 12);
  const rest  = blob.subarray(12);
  // WebCrypto appends the 16-byte GCM tag to the ciphertext; node's
  // crypto wants it supplied separately.
  const tag = rest.subarray(rest.length - 16);
  const ct  = rest.subarray(0, rest.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", kb, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf-8");
}

/**
 * Resolve backup credentials from an existing storage provider.
 *
 * Preferred over copying keys into BACKUP_S3_*: the credential then
 * lives in exactly one place, so rotating it on the Storage page
 * updates backups too, and there's no second copy to drift or leak.
 */
async function loadFromStorageProvider(token, providerId) {
  const r = await fetch(
    `${PB_URL}/api/collections/storage_providers/records/${providerId}`,
    { headers: { Authorization: token } });
  if (!r.ok) throw new Error(`storage provider ${providerId}: HTTP ${r.status}`);
  const p = await r.json();
  return {
    endpoint:  String(p.endpoint || ""),
    bucket:    String(p.bucket || ""),
    region:    String(p.region || "auto"),
    accessKey: decryptSecret(String(p.access_key_id || "")),
    secretKey: decryptSecret(String(p.secret_access_key || "")),
    label:     String(p.label || p.kind || providerId),
  };
}

function stamp() {
  // YYYY-MM-DD_HHMM in UTC — sorts lexicographically.
  return new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
}

async function pbAuth() {
  const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity: process.env.POCKETBASE_ADMIN_EMAIL,
      password: process.env.POCKETBASE_ADMIN_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`PB auth failed: HTTP ${r.status}`);
  return (await r.json()).token;
}

/** Ask PB for a consistent snapshot, then stream it back. */
async function pbBackup(token) {
  const name = `yven-${stamp()}.zip`;
  const mk = await fetch(`${PB_URL}/api/backups`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  // PB returns 204 on success; some builds 200.
  if (!mk.ok && mk.status !== 204) {
    throw new Error(`PB backup create failed: HTTP ${mk.status} ${(await mk.text()).slice(0, 200)}`);
  }

  // Downloading a backup does NOT accept the admin Authorization
  // header — PB gates protected file reads behind a separate
  // short-lived file token. Passing the admin token here returns 403,
  // which is a confusing failure to debug because create and delete
  // on the same endpoint accept it happily.
  const ft = await fetch(`${PB_URL}/api/files/token`, {
    method: "POST", headers: { Authorization: token },
  });
  if (!ft.ok) throw new Error(`PB file token failed: HTTP ${ft.status}`);
  const fileToken = (await ft.json()).token;

  const dl = await fetch(
    `${PB_URL}/api/backups/${encodeURIComponent(name)}?token=${encodeURIComponent(fileToken)}`,
  );
  if (!dl.ok) throw new Error(`PB backup download failed: HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length === 0) throw new Error("PB backup downloaded 0 bytes");
  return { name, buf };
}

/** Drop PB-side backup files older than the retention window. */
async function pbPrune(token, retainDays) {
  const r = await fetch(`${PB_URL}/api/backups`, { headers: { Authorization: token } });
  if (!r.ok) return 0;
  const list = await r.json();
  const cutoff = Date.now() - retainDays * 86400_000;
  let removed = 0;
  for (const b of Array.isArray(list) ? list : []) {
    const t = Date.parse(b.modified || "") || 0;
    if (t && t < cutoff) {
      const d = await fetch(`${PB_URL}/api/backups/${encodeURIComponent(b.key)}`, {
        method: "DELETE", headers: { Authorization: token },
      });
      if (d.ok || d.status === 204) removed++;
    }
  }
  return removed;
}

async function main() {
  // Authenticate first: config now lives in the database, so we need a
  // token before we can even find out where to write backups.
  let token;
  try {
    token = await pbAuth();
  } catch (e) {
    log("FATAL: cannot reach PocketBase —", e.message);
    process.exit(1);
  }

  const DEST = await loadConfig(token);
  const RETAIN = DEST.retainDays;

  if (!DEST.endpoint || !DEST.bucket || !DEST.accessKey || !DEST.secretKey) {
    log("Backup destination not configured — nothing to do.");
    log("Set it in the dashboard: Superadmin → Configuration → Backups.");
    log("(Takes effect immediately; no redeploy needed.)");
    process.exit(0);
  }
  log(`destination configured via ${DEST.source}, retaining ${RETAIN} days`);

  const dest = new S3Client({
    endpoint: DEST.endpoint,
    region: DEST.region,
    credentials: { accessKeyId: DEST.accessKey, secretAccessKey: DEST.secretKey },
    forcePathStyle: true,
  });
  const src = new S3Client({
    endpoint: MINIO_URL,
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.MINIO_ROOT_USER || "",
      secretAccessKey: process.env.MINIO_ROOT_PASSWORD || "",
    },
    forcePathStyle: true,
  });

  const summary = { pb_bytes: 0, videos_copied: 0, videos_skipped: 0, pruned_remote: 0, pruned_pb: 0, errors: [] };

  // ── 1. PocketBase ──────────────────────────────────────────────
  try {
    const { name, buf } = await pbBackup(token);
    summary.pb_bytes = buf.length;
    await dest.send(new PutObjectCommand({
      Bucket: DEST.bucket, Key: `pocketbase/${name}`,
      Body: buf, ContentType: "application/zip",
    }));
    log(`pocketbase → pocketbase/${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
    summary.pruned_pb = await pbPrune(token, RETAIN);
  } catch (e) {
    summary.errors.push(`pocketbase: ${e.message}`);
    log("ERROR pocketbase:", e.message);
  }

  // ── 2. MinIO objects ───────────────────────────────────────────
  // Size-compare rather than blind re-upload: videos are large and
  // immutable once written, so re-sending them nightly would burn
  // egress for nothing.
  try {
    let ContinuationToken;
    do {
      const page = await src.send(new ListObjectsV2Command({
        Bucket: SRC_BUCKET, ContinuationToken, MaxKeys: 1000,
      }));
      for (const obj of page.Contents || []) {
        const key = `media/${obj.Key}`;
        try {
          const head = await dest.send(new HeadObjectCommand({ Bucket: DEST.bucket, Key: key }));
          if (head.ContentLength === obj.Size) { summary.videos_skipped++; continue; }
        } catch { /* not present → copy it */ }
        const got = await src.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: obj.Key }));
        const body = Buffer.from(await got.Body.transformToByteArray());
        await dest.send(new PutObjectCommand({ Bucket: DEST.bucket, Key: key, Body: body }));
        summary.videos_copied++;
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    log(`media → copied ${summary.videos_copied}, already present ${summary.videos_skipped}`);
  } catch (e) {
    summary.errors.push(`media: ${e.message}`);
    log("ERROR media:", e.message);
  }

  // ── 3. Remote retention ────────────────────────────────────────
  try {
    const cutoff = Date.now() - RETAIN * 86400_000;
    let ContinuationToken;
    do {
      const page = await dest.send(new ListObjectsV2Command({
        Bucket: DEST.bucket, Prefix: "pocketbase/", ContinuationToken, MaxKeys: 1000,
      }));
      for (const obj of page.Contents || []) {
        if (obj.LastModified && obj.LastModified.getTime() < cutoff) {
          await dest.send(new DeleteObjectCommand({ Bucket: DEST.bucket, Key: obj.Key }));
          summary.pruned_remote++;
        }
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  } catch (e) {
    summary.errors.push(`prune: ${e.message}`);
  }

  log("summary", JSON.stringify(summary));
  // Non-zero exit if the database itself failed to back up — that is
  // the part with no other copy anywhere.
  process.exit(summary.pb_bytes > 0 ? 0 : 1);
}

main().catch((e) => { log("FATAL", e); process.exit(1); });

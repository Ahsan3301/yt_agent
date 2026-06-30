import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { encryptSecret, maskSecret } from "@/lib/storage-crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Storage provider CRUD.
 *
 *   GET    /api/storage/providers          → list (secrets masked)
 *   POST   /api/storage/providers          → upsert (secrets encrypted)
 *   DELETE /api/storage/providers?id=<id>  → delete (with primary check)
 *
 * The collection name (`storage_providers`) is the same on Firestore
 * during the migration window and on Pocketbase after. The wrapper
 * picks the right backend.
 *
 * Schema — see backend/storage/providers/base.py:ProviderConfig.
 */

type ProviderKind = "minio" | "r2" | "aws_s3" | "wasabi" | "b2" | "hostinger_sftp";

type ProviderDoc = {
  id?: string;
  name: string;
  kind: ProviderKind;
  // S3-like fields
  endpoint?: string;
  bucket?: string;
  region?: string;
  access_key_id?: string;
  secret_access_key?: string;
  public_base?: string;
  path_style?: boolean;
  // SFTP fields
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  base_dir?: string;
  // Bookkeeping
  is_primary?: boolean;
  is_mirror?: boolean;
  enabled?: boolean;
  // Provider-specific extras (e.g. R2's account_id)
  extras?: Record<string, unknown>;
};

const KINDS: ProviderKind[] = ["minio", "r2", "aws_s3", "wasabi", "b2", "hostinger_sftp"];

/** GET — list providers. Secrets are returned MASKED only. The
 * plaintext secret never leaves the server. */
export async function GET() {
  try {
    const snap = await adminDb()
      .collection("storage_providers")
      .orderBy("name", "asc")
      .limit(100)
      .get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      out.push({
        id: doc.id,
        name: d.name || "",
        kind: d.kind || "",
        endpoint: d.endpoint || "",
        bucket: d.bucket || "",
        region: d.region || "",
        public_base: d.public_base || "",
        path_style: d.path_style !== false,
        host: d.host || "",
        port: d.port || 22,
        user: d.user || "",
        base_dir: d.base_dir || "",
        is_primary: !!d.is_primary,
        is_mirror: !!d.is_mirror,
        enabled: d.enabled !== false,
        last_health_ok: d.last_health_ok ?? null,
        last_health_check: d.last_health_check?.toMillis?.() || null,
        // Masked previews of secret-ish fields.
        access_key_id_preview: d.access_key_id ? maskSecret(d.access_key_id, 4) : "",
        secret_set: !!d.secret_access_key,
        password_set: !!d.password,
        extras: d.extras || {},
      });
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** POST — create or update.
 *
 * Secret fields are encrypted at rest. We accept plaintext input.
 * Empty-string secrets on an update mean "leave existing value" (so
 * the user can edit non-secret fields without re-pasting credentials).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ProviderDoc;
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    if (!KINDS.includes(body.kind)) {
      return NextResponse.json(
        { error: `kind must be one of ${KINDS.join("|")}` },
        { status: 400 },
      );
    }

    const id = body.id || _slug(body.name);
    if (!id) return NextResponse.json({ error: "invalid id" }, { status: 400 });

    const ref = adminDb().collection("storage_providers").doc(id);
    const existing = await ref.get();
    const existingData = existing.exists ? (existing.data() || {}) : {};

    // Encrypt newly-supplied secrets. Empty string → keep existing.
    const access_key_id = body.access_key_id?.trim()
      ? body.access_key_id.trim()
      : (existingData.access_key_id || "");
    const secret_access_key = body.secret_access_key?.trim()
      ? await encryptSecret(body.secret_access_key.trim())
      : (existingData.secret_access_key || "");
    const password = body.password?.trim()
      ? await encryptSecret(body.password.trim())
      : (existingData.password || "");

    const payload: Record<string, unknown> = {
      id,
      name: body.name.trim().slice(0, 80),
      kind: body.kind,
      endpoint: (body.endpoint || "").trim().slice(0, 300),
      bucket: (body.bucket || "").trim().slice(0, 100),
      region: (body.region || "auto").trim().slice(0, 50),
      access_key_id,
      secret_access_key,
      public_base: (body.public_base || "").trim().slice(0, 300),
      path_style: body.path_style !== false,
      host: (body.host || "").trim().slice(0, 200),
      port: Math.max(1, Math.min(65535, Number(body.port) || 22)),
      user: (body.user || "").trim().slice(0, 100),
      password,
      base_dir: (body.base_dir || "").trim().slice(0, 200),
      is_primary: !!body.is_primary,
      is_mirror: !!body.is_mirror,
      enabled: body.enabled !== false,
      extras: body.extras || {},
      updated_at: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { created_at: FieldValue.serverTimestamp() }),
    };

    // Enforce single-primary invariant. If this provider is being set as
    // primary, demote whichever other one currently holds the flag.
    if (payload.is_primary) {
      const others = await adminDb()
        .collection("storage_providers")
        .where("is_primary", "==", true)
        .get();
      const batch = adminDb().batch();
      others.forEach((doc) => {
        if (doc.id !== id) batch.update(doc.ref, { is_primary: false });
      });
      await batch.commit();
    }
    // Same for mirror.
    if (payload.is_mirror) {
      const others = await adminDb()
        .collection("storage_providers")
        .where("is_mirror", "==", true)
        .get();
      const batch = adminDb().batch();
      others.forEach((doc) => {
        if (doc.id !== id) batch.update(doc.ref, { is_mirror: false });
      });
      await batch.commit();
    }

    await ref.set(payload, { merge: true });

    // Strip secrets from the response.
    const safe = { ...payload };
    delete (safe as { secret_access_key?: unknown }).secret_access_key;
    delete (safe as { password?: unknown }).password;
    return NextResponse.json({ ok: true, ...safe });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** DELETE — remove. Refuses if the provider is currently primary
 * (operator should promote a different one first). */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const ref = adminDb().collection("storage_providers").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return NextResponse.json({ ok: true, id, missing: true });
    const data = doc.data() || {};
    if (data.is_primary) {
      return NextResponse.json(
        { error: "cannot delete: this is the primary provider. Promote a different provider first." },
        { status: 409 },
      );
    }
    await ref.delete();
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function _slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

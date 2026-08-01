import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import {
  CONFIG_SCHEMA, bustConfigCache, isEnvOnly, getConfigSource,
} from "@/lib/platform-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Platform configuration — superadmin only.
 *
 *   GET  → every schema key with its current source and, for
 *          non-secrets, its value. Secrets return only a masked
 *          preview so the page can show "set" without re-displaying
 *          the credential.
 *   PUT  → upsert a batch of keys. Writing an empty string deletes the
 *          override, falling the key back to its environment value.
 *
 * Changes are live within a second: the write busts the read cache
 * rather than waiting for its 5s TTL.
 */

function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const snap = await adminDb().collection("platform_config").limit(500).get();
    const stored = new Map<string, string>();
    snap.forEach((d) => {
      const x = (d.data() || {}) as { key?: string; value?: string };
      if (x.key) stored.set(String(x.key), String(x.value ?? ""));
    });

    const items = await Promise.all(CONFIG_SCHEMA.map(async (f) => {
      const dbVal = stored.get(f.key) ?? "";
      const envVal = process.env[f.key] ?? "";
      const effective = dbVal !== "" ? dbVal : envVal;
      return {
        key: f.key,
        category: f.category,
        label: f.label,
        help: f.help,
        secret: !!f.secret,
        // Secrets never leave the server in full.
        value: f.secret ? "" : dbVal,
        preview: f.secret ? mask(effective) : effective,
        has_value: effective !== "",
        source: await getConfigSource(f.key),
        // An env-only key can be displayed but not overridden here.
        env_only: isEnvOnly(f.key),
      };
    }));

    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { updates?: Record<string, string> };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const updates = body.updates || {};
  const known = new Map(CONFIG_SCHEMA.map((f) => [f.key, f]));
  const applied: string[] = [];
  const cleared: string[] = [];
  const rejected: string[] = [];

  try {
    const coll = adminDb().collection("platform_config");
    const existing = await coll.limit(500).get();
    const idByKey = new Map<string, string>();
    existing.forEach((d) => {
      const x = (d.data() || {}) as { key?: string };
      if (x.key) idByKey.set(String(x.key), d.id);
    });

    const now = Math.floor(Date.now() / 1000);

    for (const [rawKey, rawVal] of Object.entries(updates)) {
      const key = String(rawKey).trim().slice(0, 100);
      const field = known.get(key);
      // Reject rather than silently ignore — an operator who edits an
      // env-only key deserves to be told it cannot take effect.
      if (!field || isEnvOnly(key)) { rejected.push(key); continue; }

      const value = String(rawVal ?? "").slice(0, 4000);
      const id = idByKey.get(key);

      if (value === "") {
        // Empty means "remove the override" — fall back to env.
        if (id) await coll.doc(id).delete();
        cleared.push(key);
        continue;
      }

      const payload = {
        key,
        value,
        category: field.category,
        label: field.label,
        help: field.help,
        secret: !!field.secret,
        updated_by: auth.tenant.userId,
        updated_at: now,
      };
      if (id) await coll.doc(id).set(payload, { merge: true });
      else await coll.doc().set(payload);
      applied.push(key);
    }

    // Live immediately rather than after the 5s TTL.
    bustConfigCache();

    await audit(auth.tenant, {
      action: "config.save",
      target_type: "platform_config",
      target_id: "*",
      // Never log values — several of these are credentials.
      meta: { applied, cleared, rejected },
    }, req);

    return NextResponse.json({ ok: true, applied, cleared, rejected });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

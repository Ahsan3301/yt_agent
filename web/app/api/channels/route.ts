import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { hashOraclePassword } from "@/lib/oracle_password";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * User-defined YouTube channels (the *destinations*, not the niches).
 *
 * One Firestore doc per channel:
 *   channels/<channel_id> {
 *     id, name, niche, daily_count, enabled, created_at, updated_at,
 *     description, web_research, last_run_at, last_run_status,
 *     allowed_workers[], oracle_password_hash
 *   }
 */

// Canonical worker labels. UI + claim filter agree on these three.
// Priority = the order in allowed_workers[]. Absence = disabled.
export const WORKER_LABELS = ["kaggle", "colab", "oracle"] as const;
export type WorkerLabel = (typeof WORKER_LABELS)[number];

type ChannelDoc = {
  id?: string;
  name: string;
  niche: string;
  daily_count: number;
  run_at_hour?: number | null;
  enabled: boolean;
  description?: string;
  web_research?: boolean | null;
  real_events?: boolean | null;
  language?: string;
  voice?: string | null;
  youtube_account_id?: string | null;
  tone?: string | null;
  privacy?: "public" | "unlisted" | "private" | null;
  discord_webhook?: string | null;
  // Ordered priority list of workers this channel is allowed to use.
  // e.g. ["kaggle","colab","oracle"] = try Kaggle first, then Colab,
  // then Oracle. [] or missing = default (kaggle+colab, no Oracle).
  allowed_workers?: string[];
  // Write-only Oracle unlock. Body may send:
  //   { oracle_password_action: "set", oracle_password: "<plain>" }  → hash + store
  //   { oracle_password_action: "clear" }                            → delete hash
  //   (neither)                                                       → leave existing hash alone
  oracle_password_action?: "set" | "clear";
  oracle_password?: string;
};

// Strip sensitive fields before returning to the client. Also
// projects a `has_oracle_password` boolean so the UI can render
// "Password set — clear/replace" without ever seeing the hash.
function _publicView(d: Record<string, unknown>): Record<string, unknown> {
  const { oracle_password_hash, ...rest } = d as { oracle_password_hash?: string };
  return { ...rest, has_oracle_password: Boolean(oracle_password_hash) };
}

function _sanitizeAllowedWorkers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim().toLowerCase();
    if (!(WORKER_LABELS as readonly string[]).includes(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** GET /api/channels — list all channels. Sensitive fields stripped. */
export async function GET() {
  try {
    const snap = await adminDb()
      .collection("channels")
      .orderBy("name", "asc")
      .limit(200)
      .get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data();
      out.push(_publicView({ id: doc.id, ...d }));
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * POST /api/channels — create OR update (upsert by id).
 * Oracle password is write-only and never returned.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChannelDoc;
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    if (!body.niche?.trim()) {
      return NextResponse.json({ error: "niche required" }, { status: 400 });
    }
    const id = (body.id || _slug(body.name)).slice(0, 60);
    if (!id) return NextResponse.json({ error: "invalid id" }, { status: 400 });

    const ref = adminDb().collection("channels").doc(id);
    const existing = await ref.get();

    // Oracle password action: set / clear / leave-alone. The client
    // NEVER receives the hash back — that's why the UI supports add
    // and replace but not view.
    let passwordPatch: Record<string, unknown> = {};
    if (body.oracle_password_action === "clear") {
      passwordPatch = { oracle_password_hash: FieldValue.delete() };
    } else if (body.oracle_password_action === "set") {
      const p = (body.oracle_password || "").trim();
      if (p.length < 4) {
        return NextResponse.json(
          { error: "oracle_password must be at least 4 characters" },
          { status: 400 }
        );
      }
      passwordPatch = { oracle_password_hash: hashOraclePassword(p) };
    }

    const payload = {
      id,
      name:        body.name.trim().slice(0, 80),
      niche:       _slug(body.niche).slice(0, 60),
      daily_count: Math.max(0, Math.min(10, Number(body.daily_count) || 0)),
      enabled:     body.enabled !== false,
      description: (body.description || "").trim().slice(0, 500),
      web_research:
        body.web_research === true ? true :
        body.web_research === false ? false : null,
      real_events:
        body.real_events === true ? true :
        body.real_events === false ? false : null,
      language: (typeof body.language === "string" && body.language.trim())
        ? body.language.trim().slice(0, 5).toLowerCase()
        : "en",
      voice: (typeof body.voice === "string" && body.voice.trim())
        ? body.voice.trim().slice(0, 80)
        : null,
      youtube_account_id: (typeof body.youtube_account_id === "string" && body.youtube_account_id.trim())
        ? body.youtube_account_id.trim().slice(0, 80)
        : null,
      run_at_hour:
        (typeof body.run_at_hour === "number" && Number.isFinite(body.run_at_hour) &&
         body.run_at_hour >= 0 && body.run_at_hour <= 23)
          ? Math.floor(body.run_at_hour)
          : null,
      tone: (typeof body.tone === "string" && body.tone.trim())
        ? body.tone.trim().slice(0, 40)
        : null,
      privacy: (body.privacy === "public" || body.privacy === "unlisted" || body.privacy === "private")
        ? body.privacy
        : null,
      discord_webhook: (typeof body.discord_webhook === "string" &&
                        body.discord_webhook.trim() &&
                        /^https?:\/\/(discord|canary\.discord|ptb\.discord)\.com\/api\/webhooks\//.test(body.discord_webhook.trim()))
        ? body.discord_webhook.trim().slice(0, 300)
        : null,
      // Ordered priority list; empty = fall back to defaults at claim time.
      allowed_workers: _sanitizeAllowedWorkers(body.allowed_workers),
      ...passwordPatch,
      updated_at: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { created_at: FieldValue.serverTimestamp() }),
    };
    await ref.set(payload, { merge: true });
    // Return the sanitized public view so the client sees
    // has_oracle_password: bool but never the hash itself.
    const { oracle_password_hash: _drop, ...cleanPayload } = payload as Record<string, unknown>;
    void _drop;
    return NextResponse.json({
      ok: true,
      ..._publicView(cleanPayload),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** DELETE /api/channels?id=<id> — remove a channel. */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    await adminDb().collection("channels").doc(id).delete();
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

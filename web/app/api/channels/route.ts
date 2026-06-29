import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * User-defined YouTube channels (the *destinations*, not the niches).
 *
 * One Firestore doc per channel:
 *   channels/<channel_id> {
 *     id, name, niche, daily_count, enabled, created_at, updated_at,
 *     description, web_research, last_run_at, last_run_status
 *   }
 *
 * niche = one of modules/channels.py preset slugs OR a free-form
 *         custom name (the worker synthesises a preset on the fly).
 *
 * daily_count = how many videos this channel publishes per day when
 *               the scheduler tick fires. 0 = paused.
 *
 * The scheduled-render workflow iterates this collection instead of
 * the old schedules/default doc — each channel queues its own jobs
 * with its niche + daily_count.
 */

type ChannelDoc = {
  id?: string;
  name: string;
  niche: string;
  daily_count: number;
  enabled: boolean;
  description?: string;
  web_research?: boolean | null;
  // Real-events research mode (per-channel default). Same tri-state
  // as web_research — null = use niche default (currently always false).
  real_events?: boolean | null;
  // ISO-2 script language. Default "en".
  language?: string;
  // Voice override — empty / null = niche default for that language.
  voice?: string | null;
};

/** GET /api/channels — list all channels. */
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
      out.push({ id: doc.id, ...d });
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * POST /api/channels — create OR update (upsert by id).
 *
 * Body: { id?, name, niche, daily_count, enabled, description?, web_research? }
 * If id is missing, generates a slug from name.
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
      updated_at: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { created_at: FieldValue.serverTimestamp() }),
    };
    await ref.set(payload, { merge: true });
    return NextResponse.json({ ok: true, ...payload });
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

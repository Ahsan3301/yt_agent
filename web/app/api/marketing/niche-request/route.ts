import { NextRequest, NextResponse } from "next/server";
import { handleInbound, clean, cleanMultiline } from "@/lib/inbound-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/marketing/niche-request — ask for a niche we don't ship.
 *
 * The engine can already synthesise a custom niche at runtime, so this
 * is a demand signal rather than a feature request: enough of these for
 * one subject and it is worth promoting to a tuned built-in preset with
 * its own voice, colour grade and SEO seeds.
 */
export async function POST(req: NextRequest) {
  let b: Record<string, unknown>;
  try { b = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const nicheName = clean(b.niche_name, 120);
  if (nicheName.length < 2) {
    return NextResponse.json(
      { error: "Please name the niche you'd like us to cover." },
      { status: 400 },
    );
  }

  return handleInbound(req, {
    collection: "niche_requests",
    kind: "Custom niche request",
    name: clean(b.name, 120),
    email: clean(b.email, 320).toLowerCase(),
    message: cleanMultiline(b.message, 4000),
    extra: {
      niche_name: nicheName,
      examples:   cleanMultiline(b.examples, 800),
      language:   clean(b.language, 80),
    },
    honeypot: clean(b.website, 200),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { handleInbound, clean, cleanMultiline } from "@/lib/inbound-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/marketing/quote — public quote request.
 *
 * Replaces the published price table. Everything except name and email
 * is optional: the point is to start a conversation, and a form that
 * demands six answers before it will accept anything loses the people
 * who were only half-decided.
 */
export async function POST(req: NextRequest) {
  let b: Record<string, unknown>;
  try { b = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  return handleInbound(req, {
    collection: "quote_requests",
    kind: "Quote request",
    name: clean(b.name, 120),
    email: clean(b.email, 320).toLowerCase(),
    message: cleanMultiline(b.message, 4000),
    extra: {
      company:       clean(b.company, 160),
      channel_url:   clean(b.channel_url, 400),
      niche:         clean(b.niche, 120),
      videos_month:  clean(b.videos_month, 40),
      channel_count: clean(b.channel_count, 40),
    },
    honeypot: clean(b.website, 200),
  });
}

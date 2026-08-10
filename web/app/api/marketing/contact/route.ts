import { NextRequest, NextResponse } from "next/server";
import { handleInbound, clean, cleanMultiline } from "@/lib/inbound-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/marketing/contact — public general enquiry form. */
export async function POST(req: NextRequest) {
  let b: Record<string, unknown>;
  try { b = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const message = cleanMultiline(b.message, 4000);
  if (message.length < 5) {
    return NextResponse.json(
      { error: "Please add a short message so we know what you need." },
      { status: 400 },
    );
  }

  return handleInbound(req, {
    collection: "contact_messages",
    kind: "Contact message",
    name: clean(b.name, 120),
    email: clean(b.email, 320).toLowerCase(),
    message,
    extra: { subject: clean(b.subject, 200) },
    honeypot: clean(b.website, 200),
  });
}

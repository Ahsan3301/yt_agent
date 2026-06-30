import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/storage/providers/<id>/promote?role=primary|mirror
 *
 * Atomically flip the role flag to this provider, demoting whichever
 * other provider holds it.
 *
 * Promoting to "primary":  exactly one provider has is_primary=true.
 * Promoting to "mirror":   zero or one provider has is_mirror=true.
 *
 * If the provider is already the holder of the requested role, returns
 * ok=true with no writes — idempotent.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const role = (req.nextUrl.searchParams.get("role") || "primary").toLowerCase();
  if (role !== "primary" && role !== "mirror") {
    return NextResponse.json(
      { error: "role must be 'primary' or 'mirror'" },
      { status: 400 },
    );
  }
  const flagField = role === "primary" ? "is_primary" : "is_mirror";

  try {
    const ref = adminDb().collection("storage_providers").doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if ((snap.data() || {}).enabled === false) {
      return NextResponse.json(
        { error: "provider is disabled — enable it before promoting" },
        { status: 409 },
      );
    }

    // Demote whichever other provider currently holds the flag.
    const holders = await adminDb()
      .collection("storage_providers")
      .where(flagField, "==", true)
      .get();

    const batch = adminDb().batch();
    holders.forEach((doc) => {
      if (doc.id !== id) batch.update(doc.ref, { [flagField]: false });
    });
    batch.update(ref, {
      [flagField]: true,
      updated_at: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return NextResponse.json({ ok: true, id, role });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * DELETE /api/storage/providers/<id>/promote?role=mirror
 *
 * Demote — clear the mirror flag (the primary slot can't be empty, so
 * DELETE on role=primary is rejected).
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const role = (req.nextUrl.searchParams.get("role") || "mirror").toLowerCase();
  if (role !== "mirror") {
    return NextResponse.json(
      { error: "primary cannot be cleared — promote a different provider first" },
      { status: 400 },
    );
  }
  try {
    await adminDb().collection("storage_providers").doc(id).update({
      is_mirror: false,
      updated_at: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, id, role });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

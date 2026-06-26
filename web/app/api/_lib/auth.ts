/**
 * Bearer-token auth for the maintenance routes hit by GitHub Actions.
 *
 * Pattern: caller sends `X-API-Key: <secret>`. Secret is stored in
 * Firestore `api_keys/RENDER_TRIGGER_KEY` (managed via dashboard) AND
 * mirrored as a GitHub Actions secret. Mismatch → 401.
 */
import { adminDb } from "@/lib/firebase-admin";

let _cached: { at: number; value: string } | null = null;
const TTL = 60_000;

async function _loadKey(): Promise<string> {
  // Env var override for local dev / preview environments.
  if (process.env.RENDER_TRIGGER_KEY) return process.env.RENDER_TRIGGER_KEY;
  if (_cached && Date.now() - _cached.at < TTL) return _cached.value;
  try {
    const snap = await adminDb()
      .collection("api_keys")
      .doc("RENDER_TRIGGER_KEY")
      .get();
    const v = snap.exists ? ((snap.data() as { value?: string }).value || "") : "";
    _cached = { at: Date.now(), value: v };
    return v;
  } catch {
    return "";
  }
}

export async function requireMaintenanceKey(req: Request): Promise<true | Response> {
  const provided = req.headers.get("x-api-key") || "";
  const expected = await _loadKey();
  if (!expected) {
    return new Response(
      JSON.stringify({ error: "RENDER_TRIGGER_KEY not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!provided || provided !== expected) {
    return new Response(
      JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return true;
}

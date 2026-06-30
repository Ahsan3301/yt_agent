import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { publicOrigin } from "@/app/api/_lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/huggingface/callback?code=...
 *
 * Exchanges the HF OAuth code for an access token and stores it as
 * api_keys/HF_TOKEN. Backends pull this from Firestore on next sync
 * so the worker's Inference API calls just work.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const origin = publicOrigin(req);

  const back = (q: string) => NextResponse.redirect(`${origin}/keys?${q}`);

  if (errorParam) return back(`huggingface=error&reason=${encodeURIComponent(errorParam)}`);
  if (!code) return back("huggingface=error&reason=no_code");

  const clientId = process.env.HUGGINGFACE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.HUGGINGFACE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return back("huggingface=error&reason=server_not_configured");
  }
  if (state && state !== origin) return back("huggingface=error&reason=state_mismatch");

  const redirectUri = `${origin}/api/huggingface/callback`;

  // Exchange code for access token.
  let tokenJson: Record<string, unknown>;
  try {
    const tokenRes = await fetch("https://huggingface.co/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("hf token exchange failed:", tokenRes.status, text);
      return back(`huggingface=error&reason=token_${tokenRes.status}`);
    }
    tokenJson = (await tokenRes.json()) as Record<string, unknown>;
  } catch (e) {
    console.error("hf token exchange threw:", e);
    return back("huggingface=error&reason=network");
  }

  const accessToken = String(tokenJson.access_token || "");
  if (!accessToken) return back("huggingface=error&reason=no_access_token");

  // Store as HF_TOKEN.
  try {
    await adminDb().collection("api_keys").doc("HF_TOKEN").set({
      value: accessToken,
      updated_at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("hf token save failed:", e);
    return back("huggingface=error&reason=firestore_write");
  }

  return back("huggingface=connected");
}

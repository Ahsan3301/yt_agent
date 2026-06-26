import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/youtube/callback?code=...&state=...
 *
 * Google's OAuth redirect target. Exchanges the auth code for a
 * refresh token, then writes the full credentials JSON to Firestore
 * api_keys/YOUTUBE_REFRESH_TOKEN in the exact shape that
 * `google.oauth2.credentials.Credentials.from_authorized_user_info`
 * expects on the worker side.
 *
 * Redirects the user back to /settings with a query flag they can
 * read to show success / error toast.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const origin = url.origin;

  if (errorParam) {
    return NextResponse.redirect(
      `${origin}/settings?youtube=error&reason=${encodeURIComponent(errorParam)}`,
    );
  }
  if (!code) {
    return NextResponse.redirect(
      `${origin}/settings?youtube=error&reason=no_code`,
    );
  }

  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      `${origin}/settings?youtube=error&reason=server_not_configured`,
    );
  }

  // CSRF check — `state` is the origin we set in /api/youtube/auth.
  if (state && state !== origin) {
    return NextResponse.redirect(
      `${origin}/settings?youtube=error&reason=state_mismatch`,
    );
  }

  // Exchange code for tokens.
  const redirectUri = `${origin}/api/youtube/callback`;
  let tokenJson: Record<string, unknown>;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("youtube token exchange failed:", tokenRes.status, text);
      return NextResponse.redirect(
        `${origin}/settings?youtube=error&reason=token_exchange_${tokenRes.status}`,
      );
    }
    tokenJson = (await tokenRes.json()) as Record<string, unknown>;
  } catch (e) {
    console.error("youtube token exchange threw:", e);
    return NextResponse.redirect(
      `${origin}/settings?youtube=error&reason=network`,
    );
  }

  if (!tokenJson.refresh_token) {
    // Google only returns a refresh_token on the FIRST consent. If the
    // user has consented before and didn't re-prompt, Google omits it.
    // Our auth route sets prompt=consent so this should never happen,
    // but guard anyway.
    return NextResponse.redirect(
      `${origin}/settings?youtube=error&reason=no_refresh_token`,
    );
  }

  // Build the credentials dict in the shape that
  // google.oauth2.credentials.Credentials.from_authorized_user_info
  // expects on the worker (modules/uploader.py).
  const credsForWorker = {
    token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: clientId,
    client_secret: clientSecret,
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube",
    ],
    expiry: tokenJson.expires_in
      ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
      : undefined,
  };

  try {
    await adminDb()
      .collection("api_keys")
      .doc("YOUTUBE_REFRESH_TOKEN")
      .set({
        value: JSON.stringify(credsForWorker),
        updated_at: FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.error("youtube creds save failed:", e);
    return NextResponse.redirect(
      `${origin}/settings?youtube=error&reason=firestore_write`,
    );
  }

  return NextResponse.redirect(`${origin}/settings?youtube=connected`);
}

import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { publicOrigin } from "@/app/api/_lib/public-origin";
import { getTenant, FOUNDER } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/youtube/callback?code=...&state=<origin>[|bind=<dashboardChannelId>]
 *
 * Google's OAuth redirect target. Now supports MULTIPLE YouTube
 * accounts:
 *
 *   1. Exchange auth code → access + refresh tokens.
 *   2. Use the access token to call channels.list?mine=true so we
 *      learn WHICH YouTube channel just authorized.
 *   3. Persist credentials at youtube_accounts/<youtube_channel_id>
 *      with channel title + thumbnail (for nice display in /channels).
 *   4. If state has `bind=<dashboardChannelId>`, also flip
 *      channels/<dashboardChannelId>.youtube_account_id to the new
 *      youtube_channel_id so future renders of THAT dashboard channel
 *      publish to THIS YouTube account.
 *
 * Backwards compat: also writes the legacy
 * api_keys/YOUTUBE_REFRESH_TOKEN doc so old workers that don't know
 * about youtube_accounts still find a credential.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  // Public origin (env-driven) — must match the redirect_uri sent in
  // the consent step, NOT the container's internal address.
  const origin = publicOrigin(req);

  // Parse state: "<origin>" or "<origin>|bind=<dashboardChannelId>"
  let stateOrigin = state || "";
  let bindChannelId: string | null = null;
  if (state) {
    const [head, ...rest] = state.split("|");
    stateOrigin = head;
    for (const kv of rest) {
      const [k, v] = kv.split("=");
      if (k === "bind" && v) bindChannelId = v.slice(0, 80);
    }
  }

  // Where to redirect once we're done — wizard / channels / settings.
  const dest = bindChannelId
    ? `${origin}/channels?youtube=connected&bind=${encodeURIComponent(bindChannelId)}`
    : `${origin}/settings?youtube=connected`;
  const errDest = (reason: string) => bindChannelId
    ? `${origin}/channels?youtube=error&reason=${encodeURIComponent(reason)}`
    : `${origin}/settings?youtube=error&reason=${encodeURIComponent(reason)}`;

  if (errorParam) {
    return NextResponse.redirect(errDest(errorParam));
  }
  if (!code) {
    return NextResponse.redirect(errDest("no_code"));
  }

  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(errDest("server_not_configured"));
  }

  // CSRF check — the state's origin must match ours.
  if (stateOrigin && stateOrigin !== origin) {
    return NextResponse.redirect(errDest("state_mismatch"));
  }

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
      return NextResponse.redirect(errDest(`token_exchange_${tokenRes.status}`));
    }
    tokenJson = (await tokenRes.json()) as Record<string, unknown>;
  } catch (e) {
    console.error("youtube token exchange threw:", e);
    return NextResponse.redirect(errDest("network"));
  }

  if (!tokenJson.refresh_token) {
    // Google only returns refresh_token on FIRST consent. Our auth route
    // sets prompt=consent so we should always get one, but guard anyway.
    return NextResponse.redirect(errDest("no_refresh_token"));
  }

  // Identify which YouTube channel just connected.
  let ytChannelId = "";
  let ytChannelTitle = "";
  let ytChannelThumb = "";
  try {
    const r = await fetch(
      "https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
    );
    if (r.ok) {
      const j = await r.json();
      const item = (j.items || [])[0];
      if (item) {
        ytChannelId = String(item.id || "");
        ytChannelTitle = String(item.snippet?.title || "");
        ytChannelThumb = String(item.snippet?.thumbnails?.default?.url || "");
      }
    } else {
      console.warn("youtube channels.list failed:", r.status);
    }
  } catch (e) {
    console.warn("youtube channels.list threw:", e);
  }

  if (!ytChannelId) {
    return NextResponse.redirect(errDest("could_not_identify_channel"));
  }

  // Credentials JSON in the shape that the Python worker's
  // `google.oauth2.credentials.Credentials.from_authorized_user_info`
  // expects.
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
  const credsJson = JSON.stringify(credsForWorker);

  // Resolve the calling tenant so we stamp user_id on the youtube
  // account row and write the OAuth token into the per-user shadow.
  // Missing session (rare — the OAuth flow always originates from an
  // authed dashboard click) falls back to the founder so we never
  // orphan a credential.
  const tenant = await getTenant(req);
  const ownerUserId = tenant?.userId || FOUNDER;

  try {
    // PRIMARY storage: per-account, keyed by YouTube channel id.
    await adminDb()
      .collection("youtube_accounts")
      .doc(ytChannelId)
      .set({
        youtube_channel_id: ytChannelId,
        title: ytChannelTitle,
        thumbnail: ytChannelThumb,
        credentials: credsJson,
        user_id: ownerUserId,
        updated_at: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
      }, { merge: true });

    // Per-user shadow of the api_keys blob — same pattern as
    // /api/keys. Workers reading the caller's shadow get the fresh
    // refresh token immediately. The legacy singleton write below
    // stays as a fallback.
    try {
      const shadowRef = adminDb().collection("settings").doc(`${ownerUserId}__api_keys`);
      const cur = await shadowRef.get();
      const blob = cur.exists ? (cur.data() as { data?: unknown }).data : {};
      const parsed: Record<string, string> =
        typeof blob === "string" ? JSON.parse(blob) :
        blob && typeof blob === "object" ? (blob as Record<string, string>) : {};
      parsed.YOUTUBE_REFRESH_TOKEN = credsJson;
      await shadowRef.set({
        data: parsed,
        user_id: ownerUserId,
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: false });
    } catch (e) {
      console.error("youtube per-user shadow write failed:", e);
    }

    // LEGACY mirror: keep the old single-doc location populated with
    // the most-recently-connected account so older workers + dry-run
    // dev paths still find a credential. Removed in Phase 7 cleanup
    // once every reader hits the per-user shadow.
    await adminDb()
      .collection("api_keys")
      .doc("YOUTUBE_REFRESH_TOKEN")
      .set({
        value: credsJson,
        youtube_channel_id: ytChannelId,
        user_id: ownerUserId,
        updated_at: FieldValue.serverTimestamp(),
      });

    // If the OAuth flow was kicked off from a dashboard-channel row,
    // bind that channel to this new YouTube account.
    if (bindChannelId) {
      await adminDb()
        .collection("channels")
        .doc(bindChannelId)
        .set({
          youtube_account_id: ytChannelId,
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
    }
  } catch (e) {
    console.error("youtube creds save failed:", e);
    return NextResponse.redirect(errDest("firestore_write"));
  }

  return NextResponse.redirect(dest);
}

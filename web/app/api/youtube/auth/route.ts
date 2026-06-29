import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube";

/**
 * GET /api/youtube/auth — return the Google consent screen URL.
 *
 * The dashboard's "Connect YouTube" button fetches this, then sets
 * `window.location.href` to the returned URL. After the user grants
 * consent, Google redirects to /api/youtube/callback with a code.
 *
 * Required Vercel env vars (server-side):
 *   YOUTUBE_OAUTH_CLIENT_ID
 *   YOUTUBE_OAUTH_CLIENT_SECRET
 * The values come from Google Cloud Console → APIs & Services →
 * Credentials → Create OAuth client ID (Web application). The
 * authorised redirect URI on the Google side must exactly match
 * `<vercel-url>/api/youtube/callback`.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      {
        error: "YOUTUBE_OAUTH_CLIENT_ID not set on Vercel",
        next_step:
          "Create OAuth credentials at Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web application). Add the callback URL to authorised redirect URIs. Set YOUTUBE_OAUTH_CLIENT_ID + YOUTUBE_OAUTH_CLIENT_SECRET on Vercel.",
      },
      { status: 503 },
    );
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/youtube/callback`;

  // Optional `bind=<dashboardChannelId>` — when present, the callback
  // will bind the newly connected YouTube account to that dashboard
  // channel. Lets the /channels page Connect button per-channel be a
  // one-click flow.
  const bind = (req.nextUrl.searchParams.get("bind") || "")
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 60);

  // CSRF state — encode origin + the optional bind hint.
  const state = bind ? `${origin}|bind=${bind}` : origin;

  const consentUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("response_type", "code");
  consentUrl.searchParams.set("scope", SCOPES);
  // offline + force consent so we always get a refresh_token (not just
  // an access_token that expires in an hour).
  consentUrl.searchParams.set("access_type", "offline");
  consentUrl.searchParams.set("prompt", "consent");
  consentUrl.searchParams.set("state", state);

  return NextResponse.json({
    url: consentUrl.toString(),
    redirect_uri_to_register: redirectUri,
  });
}

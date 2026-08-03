import { NextRequest, NextResponse } from "next/server";
import { publicOrigin } from "@/app/api/_lib/public-origin";
import { getConfig } from "@/lib/platform-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];

// Read-only access to the channel's own analytics — specifically
// "when your viewers are online", which is the only trustworthy source
// for scheduling. Everything else the scheduler uses is inferred from
// OTHER channels' top performers.
//
// Gated behind a flag rather than simply added, because Google rejects
// a consent request containing a scope that is not registered on the
// app's consent screen. Turning it on here before the Cloud Console
// side is done would break "Connect YouTube" for every channel, not
// just add a capability. So: register the scope in the console first,
// then flip YOUTUBE_ANALYTICS_SCOPE=1, then reconnect each channel.
const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/**
 * GET /api/youtube/auth — return the Google consent screen URL.
 *
 * The dashboard's "Connect YouTube" button fetches this, then sets
 * `window.location.href` to the returned URL. After the user grants
 * consent, Google redirects to /api/youtube/callback with a code.
 *
 * Required dashboard env vars (server-side):
 *   YOUTUBE_OAUTH_CLIENT_ID
 *   YOUTUBE_OAUTH_CLIENT_SECRET
 *   PUBLIC_BASE_URL (your dashboard URL — needed when behind a proxy
 *                    like Coolify's Caddy/Traefik; auto-detected on Vercel)
 *
 * The OAuth values come from Google Cloud Console → APIs & Services →
 * Credentials → Create OAuth client ID (Web application). The
 * authorised redirect URI on the Google side must exactly match
 * `${PUBLIC_BASE_URL}/api/youtube/callback`.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      {
        error: "YOUTUBE_OAUTH_CLIENT_ID not set on the dashboard",
        next_step:
          "Create OAuth credentials at Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web application). Add the callback URL to authorised redirect URIs. Set YOUTUBE_OAUTH_CLIENT_ID + YOUTUBE_OAUTH_CLIENT_SECRET on the dashboard.",
      },
      { status: 503 },
    );
  }

  const origin = publicOrigin(req);
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
  const wantAnalytics = String(
    await getConfig("YOUTUBE_ANALYTICS_SCOPE", "")
  ).trim().toLowerCase();
  const scopes = [...BASE_SCOPES];
  if (["1", "true", "yes", "on"].includes(wantAnalytics)) {
    scopes.push(ANALYTICS_SCOPE);
  }
  consentUrl.searchParams.set("scope", scopes.join(" "));
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

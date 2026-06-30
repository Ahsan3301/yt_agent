import { NextRequest, NextResponse } from "next/server";
import { publicOrigin } from "@/app/api/_lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/github/auth — return the GitHub consent URL.
 *
 * After consent, the callback exchanges the code for an access token,
 * then immediately uses that token to set repo Actions secrets:
 *   HF_TOKEN            (if a previous setup stored one)
 *   RENDER_TRIGGER_KEY  (if a previous setup stored one)
 *
 * The user never has to open GitHub Settings → Secrets manually.
 *
 * Required dashboard env vars:
 *   GITHUB_OAUTH_CLIENT_ID
 *   GITHUB_OAUTH_CLIENT_SECRET
 *   GITHUB_REPO_FULL_NAME    (e.g. "Ahsan3301/yt_agent")
 *   PUBLIC_BASE_URL          (your dashboard URL, e.g. https://yt-agent.thyker.online)
 *
 * Create the OAuth app at: https://github.com/settings/applications/new
 * Callback URL: ${PUBLIC_BASE_URL}/api/github/callback
 * (The "repo" scope is what's needed to write Actions secrets.)
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      {
        error: "GITHUB_OAUTH_CLIENT_ID not set on the dashboard",
        next_step:
          "Create a GitHub OAuth App at https://github.com/settings/applications/new — Callback URL must exactly match <your-dashboard-url>/api/github/callback. Then set GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET (+ GITHUB_REPO_FULL_NAME) on the dashboard.",
      },
      { status: 503 },
    );
  }

  const origin = publicOrigin(req);
  const redirectUri = `${origin}/api/github/callback`;

  const consentUrl = new URL("https://github.com/login/oauth/authorize");
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  // Need `repo` to write Actions secrets to private repos. For public
  // repos `public_repo` is enough — but `repo` covers both.
  consentUrl.searchParams.set("scope", "repo");
  consentUrl.searchParams.set("state", origin);
  consentUrl.searchParams.set("allow_signup", "false");

  return NextResponse.json({
    url: consentUrl.toString(),
    redirect_uri_to_register: redirectUri,
  });
}

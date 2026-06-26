import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/huggingface/auth — return the HF consent URL.
 *
 * The callback exchanges the code for an access token and stores it
 * directly as HF_TOKEN in Firestore. HF OAuth access tokens work
 * directly with the Inference API — no need for the user to also
 * generate a Read-scope token at huggingface.co/settings/tokens.
 *
 * Required Vercel env vars:
 *   HUGGINGFACE_OAUTH_CLIENT_ID
 *   HUGGINGFACE_OAUTH_CLIENT_SECRET
 *
 * Create the OAuth app at: https://huggingface.co/settings/applications/new
 * Redirect URI: https://<vercel-url>/api/huggingface/callback
 * Scopes: read-repos (sufficient for Inference API token use)
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.HUGGINGFACE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      {
        error: "HUGGINGFACE_OAUTH_CLIENT_ID not set on Vercel",
        next_step:
          "Create an OAuth app at https://huggingface.co/settings/applications/new — Redirect URL must exactly match <your-vercel-url>/api/huggingface/callback. Then set HUGGINGFACE_OAUTH_CLIENT_ID + HUGGINGFACE_OAUTH_CLIENT_SECRET on Vercel.",
      },
      { status: 503 },
    );
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/huggingface/callback`;

  const consentUrl = new URL("https://huggingface.co/oauth/authorize");
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("response_type", "code");
  consentUrl.searchParams.set("scope", "read-repos inference-api");
  consentUrl.searchParams.set("state", origin);

  return NextResponse.json({
    url: consentUrl.toString(),
    redirect_uri_to_register: redirectUri,
  });
}

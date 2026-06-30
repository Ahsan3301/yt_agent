import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import {
  setRepoSecret,
  listRepoSecrets,
  parseRepoFullName,
} from "@/app/api/_lib/github-secrets";
import { publicOrigin } from "@/app/api/_lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/github/callback?code=...&state=...
 *
 * Exchanges the OAuth code for an access token, then:
 *   1. Pushes HF_TOKEN to repo Actions secrets (if Firestore has it)
 *   2. Pushes RENDER_TRIGGER_KEY to repo Actions secrets (if Firestore has it)
 *   3. Stores the GitHub access token in Firestore for future syncs
 *
 * Redirects user back to /keys?github=connected (or =error&reason=...)
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  // Use the public origin (env-var driven) so the redirect_uri we send
  // to GitHub's token exchange matches the redirect_uri we originally
  // sent in the consent step. Internal docker hostname won't work here.
  const origin = publicOrigin(req);

  const back = (q: string) =>
    NextResponse.redirect(`${origin}/keys?${q}`);

  if (errorParam) return back(`github=error&reason=${encodeURIComponent(errorParam)}`);
  if (!code) return back("github=error&reason=no_code");

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const repoFullName = process.env.GITHUB_REPO_FULL_NAME || "Ahsan3301/yt_agent";

  if (!clientId || !clientSecret) {
    return back("github=error&reason=server_not_configured");
  }
  if (state && state !== origin) {
    return back("github=error&reason=state_mismatch");
  }

  // Exchange code for access token.
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    if (!tokenRes.ok) return back(`github=error&reason=token_${tokenRes.status}`);
    const d = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!d.access_token) {
      return back(`github=error&reason=${encodeURIComponent(d.error || "no_token")}`);
    }
    accessToken = d.access_token;
  } catch (e) {
    return back(`github=error&reason=network`);
  }

  // Look up the values we want to push from Firestore api_keys.
  const repo = parseRepoFullName(repoFullName);
  if (!repo) return back("github=error&reason=invalid_repo");

  const wantSecrets = ["HF_TOKEN", "RENDER_TRIGGER_KEY"];
  const synced: string[] = [];
  const skipped: string[] = [];

  for (const name of wantSecrets) {
    try {
      const snap = await adminDb().collection("api_keys").doc(name).get();
      const v = snap.exists ? (snap.data() as { value?: string }).value : undefined;
      if (!v) {
        skipped.push(name);
        continue;
      }
      await setRepoSecret(accessToken, repo.owner, repo.repo, name, v);
      synced.push(name);
    } catch (e) {
      console.error(`github secret push for ${name}:`, e);
    }
  }

  // Store the access token so we can re-sync later when keys change.
  try {
    await adminDb().collection("api_keys").doc("GITHUB_ACCESS_TOKEN").set({
      value: accessToken,
      updated_at: FieldValue.serverTimestamp(),
    });
  } catch {
    /* ignored */
  }

  // Confirm what's now there for the UI.
  let existing: string[] = [];
  try {
    existing = await listRepoSecrets(accessToken, repo.owner, repo.repo);
  } catch {
    /* ignored */
  }

  const params = new URLSearchParams({
    github: "connected",
    synced: synced.join(","),
    skipped: skipped.join(","),
    existing: existing.join(","),
    repo: `${repo.owner}/${repo.repo}`,
  });
  return NextResponse.redirect(`${origin}/keys?${params.toString()}`);
}

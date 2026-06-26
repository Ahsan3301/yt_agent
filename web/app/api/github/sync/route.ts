import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import {
  setRepoSecret,
  listRepoSecrets,
  parseRepoFullName,
} from "@/app/api/_lib/github-secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/github/sync — re-push current Firestore values to GitHub.
 * Used after the user updates HF_TOKEN or RENDER_TRIGGER_KEY in the
 * dashboard; one click and the GitHub Actions secret picks up the new
 * value (otherwise it'd quietly use the old value until next OAuth).
 */
export async function POST(_req: NextRequest) {
  const tokenSnap = await adminDb()
    .collection("api_keys")
    .doc("GITHUB_ACCESS_TOKEN")
    .get();
  const accessToken = tokenSnap.exists
    ? (tokenSnap.data() as { value?: string }).value
    : "";
  if (!accessToken) {
    return NextResponse.json(
      { error: "GitHub not connected", next_step: "Click 'Sign in with GitHub' on the Connections page" },
      { status: 401 },
    );
  }

  const repoFullName = process.env.GITHUB_REPO_FULL_NAME || "Ahsan3301/yt_agent";
  const repo = parseRepoFullName(repoFullName);
  if (!repo) return NextResponse.json({ error: "invalid repo" }, { status: 400 });

  const wantSecrets = ["HF_TOKEN", "RENDER_TRIGGER_KEY"];
  const synced: string[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};

  for (const name of wantSecrets) {
    try {
      const snap = await adminDb().collection("api_keys").doc(name).get();
      const v = snap.exists ? (snap.data() as { value?: string }).value : "";
      if (!v) {
        skipped.push(name);
        continue;
      }
      await setRepoSecret(accessToken, repo.owner, repo.repo, name, v);
      synced.push(name);
    } catch (e) {
      errors[name] = String(e);
    }
  }

  let existing: string[] = [];
  try {
    existing = await listRepoSecrets(accessToken, repo.owner, repo.repo);
  } catch {
    /* ignored */
  }

  return NextResponse.json({
    ok: synced.length > 0 || skipped.length === wantSecrets.length,
    synced,
    skipped,
    existing,
    errors: Object.keys(errors).length ? errors : undefined,
  });
}

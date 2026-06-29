import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/backends/wake-kaggle
 *
 * Manually fire the kaggle-dispatch.yml workflow. Mirrors the
 * `_maybeWakeKaggle` helper in /api/jobs/route.ts but is callable
 * without queueing a render — lets the user pre-warm Kaggle before
 * submitting OR test the dispatch wiring without spending GPU hours.
 *
 * Auth: reuses the OAuth-stored GITHUB_ACCESS_TOKEN from Firestore
 * api_keys (same one the auto-wake uses). Returns 401 if the user
 * hasn't connected GitHub yet.
 */
export async function POST(_req: NextRequest) {
  const repoFullName = process.env.GITHUB_REPO_FULL_NAME || "Ahsan3301/yt_agent";
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    return NextResponse.json({ error: "invalid GITHUB_REPO_FULL_NAME" }, { status: 500 });
  }

  let token = "";
  try {
    const snap = await adminDb()
      .collection("api_keys")
      .doc("GITHUB_ACCESS_TOKEN")
      .get();
    token = snap.exists ? ((snap.data() as { value?: string }).value || "") : "";
  } catch (e) {
    return NextResponse.json({ error: "firestore read failed", detail: String(e) }, { status: 500 });
  }
  if (!token) {
    return NextResponse.json(
      {
        error: "GITHUB_ACCESS_TOKEN not configured",
        next_step:
          "Connections page → One-click connect → Sign in with GitHub. " +
          "The OAuth token gives us workflow_dispatch permission.",
      },
      { status: 401 },
    );
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/kaggle-dispatch.yml/dispatches`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (r.status === 204) {
      return NextResponse.json({
        ok: true,
        message: "Kaggle worker dispatch fired. Notebook should boot within ~90 sec; the Monitor card appears when it heartbeats.",
        watch_url: `https://www.kaggle.com/code/ahsanriaz1337/yt-agent-worker`,
        workflow_url: `https://github.com/${owner}/${repo}/actions/workflows/kaggle-dispatch.yml`,
      });
    }
    const body = await r.text();
    return NextResponse.json(
      { error: `GitHub returned ${r.status}`, detail: body.slice(0, 400) },
      { status: 502 },
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

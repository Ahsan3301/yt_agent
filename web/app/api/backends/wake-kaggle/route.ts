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
// HMAC session-cookie verify — mirrors web/middleware.ts. This route
// is in the middleware's API_KEY_ROUTES bypass list (workers must reach
// it server-to-server without a cookie), so the middleware does NOT
// validate the cookie for us — we must do it here.
async function _validSession(cookie: string, secret: string): Promise<boolean> {
  try {
    const idx = cookie.lastIndexOf(".");
    if (idx <= 0) return false;
    const payload = cookie.slice(0, idx);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    const b64 = Buffer.from(new Uint8Array(sig)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (`${payload}.${b64}` !== cookie) return false;
    const parts = payload.split(":");
    if (parts.length !== 2 || parts[0] !== "v1") return false;
    const expiry = Number(parts[1]);
    return Number.isFinite(expiry) && Date.now() < expiry;
  } catch { return false; }
}

export async function POST(_req: NextRequest) {
  // Auth (2026-07-17 audit): previously NO auth at all — any
  // unauthenticated POST fired a workflow_dispatch and burned Kaggle
  // GPU quota + GH minutes. Require either the maintenance key
  // (server-to-server callers) OR a VALID signed dashboard session
  // cookie (the UI's Wake button).
  const key = _req.headers.get("x-api-key") || "";
  const expected = process.env.RENDER_TRIGGER_KEY || "";
  const hasKey = Boolean(expected) && key === expected;
  let hasSession = false;
  const dashPwd = process.env.DASHBOARD_PASSWORD || "";
  const cookie = _req.cookies.get("dash_auth")?.value || "";
  if (!hasKey && dashPwd && cookie) {
    hasSession = await _validSession(cookie, dashPwd);
  }
  if (!hasKey && !hasSession) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const repoFullName = process.env.GITHUB_REPO_FULL_NAME || "Ahsan3301/yt_agent";
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    return NextResponse.json({ error: "invalid GITHUB_REPO_FULL_NAME" }, { status: 500 });
  }

  let token = "";
  try {
    // Preferred: keys blob at settings/api_keys.
    const blobSnap = await adminDb().collection("settings").doc("api_keys").get();
    if (blobSnap.exists) {
      const blob = (blobSnap.data() as { data?: Record<string, string> }).data || {};
      token = String(blob.GITHUB_ACCESS_TOKEN || "");
    }
    if (!token) {
      // Legacy fallback for pre-blob deploys.
      const snap = await adminDb().collection("api_keys").doc("GITHUB_ACCESS_TOKEN").get();
      token = snap.exists ? ((snap.data() as { value?: string }).value || "") : "";
    }
  } catch (e) {
    return NextResponse.json({ error: "keys read failed", detail: String(e) }, { status: 500 });
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
        watch_url: `https://www.kaggle.com/code/${process.env.KAGGLE_USER || "ahsanriaz1337"}/yt-agent-worker`,
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

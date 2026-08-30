import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/backends/wake-colab
 *
 * Fire the colab-dispatch.yml workflow, which provisions a Colab
 * runtime through Google's official CLI and starts the worker on it.
 *
 * This is the twin of wake-kaggle. Until now Colab was the only worker
 * in the fleet that needed a human: Kaggle had this route, Oracle is
 * always-on, and Colab was woken by someone opening
 * NEXT_PUBLIC_COLAB_URL in a browser and running the notebook cells.
 * That asymmetry existed only because Kaggle had an API and Colab did
 * not — google-colab-cli closes it.
 *
 * Body (all optional):
 *   { gpu?: "T4"|"L4"|"G4"|"H100"|"A100", session?: string }
 * Omitting `gpu` provisions a CPU runtime, which is the default and
 * the normal case: nothing in the pipeline runs a local model any
 * more, so the worker needs ffmpeg and outbound HTTP, not a card.
 */

// HMAC session-cookie verify — mirrors web/middleware.ts. This route is
// in the middleware's API_KEY_ROUTES bypass list (workers must reach it
// server-to-server without a cookie), so the middleware does NOT
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
    return Number(parts[1]) > Date.now();
  } catch { return false; }
}

const ALLOWED_GPUS = new Set(["T4", "L4", "G4", "H100", "A100"]);

export async function POST(req: NextRequest) {
  // Same auth as wake-kaggle: maintenance key OR a valid signed
  // dashboard session. An unauthenticated POST here would provision
  // compute on the operator's Google account.
  const key = req.headers.get("x-api-key") || "";
  const expected = process.env.RENDER_TRIGGER_KEY || "";
  const hasKey = Boolean(expected) && key === expected;
  let hasSession = false;
  const dashPwd = process.env.DASHBOARD_PASSWORD || "";
  const cookie = req.cookies.get("dash_auth")?.value || "";
  if (!hasKey && dashPwd && cookie) {
    hasSession = await _validSession(cookie, dashPwd);
  }
  if (!hasKey && !hasSession) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  // A valid session is not enough — it must be an OPERATOR's. Colab
  // quota is the operator's, billed to one Google account for the whole
  // fleet, so a signed-in customer clicking this would spend someone
  // else's compute. Identical reasoning to wake-kaggle.
  if (!hasKey) {
    const { verifySession } = await import("@/lib/session");
    const sess = cookie ? await verifySession(cookie) : null;
    const role = sess?.role || "";
    if (role !== "admin" && role !== "superadmin") {
      return NextResponse.json(
        { error: "forbidden — operator access required" },
        { status: 403 },
      );
    }
  }

  let gpu = "";
  let session = "yt-agent-worker";
  try {
    const body = (await req.json()) as { gpu?: unknown; session?: unknown };
    if (typeof body?.gpu === "string" && body.gpu.trim()) gpu = body.gpu.trim().toUpperCase();
    if (typeof body?.session === "string" && body.session.trim()) session = body.session.trim();
  } catch {
    // No body is the normal case — CPU runtime, default session name.
  }
  if (gpu && !ALLOWED_GPUS.has(gpu)) {
    return NextResponse.json(
      { error: `unsupported gpu '${gpu}'`, supported: [...ALLOWED_GPUS] },
      { status: 400 },
    );
  }
  // Guard the session name rather than trusting it: it is interpolated
  // into a shell command inside the workflow.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(session)) {
    return NextResponse.json(
      { error: "invalid session name — use letters, digits, dot, dash, underscore" },
      { status: 400 },
    );
  }

  const repoFullName = process.env.GITHUB_REPO_FULL_NAME || "Ahsan3301/yt_agent";
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    return NextResponse.json({ error: "invalid GITHUB_REPO_FULL_NAME" }, { status: 500 });
  }

  let token = "";
  try {
    const blobSnap = await adminDb().collection("settings").doc("api_keys").get();
    if (blobSnap.exists) {
      const blob = (blobSnap.data() as { data?: Record<string, string> }).data || {};
      token = String(blob.GITHUB_ACCESS_TOKEN || "");
    }
    if (!token) {
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

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/colab-dispatch.yml/dispatches`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { gpu, session } }),
    });
    if (r.status === 204) {
      return NextResponse.json({
        ok: true,
        runtime: gpu ? `GPU (${gpu})` : "CPU",
        session,
        message:
          "Colab worker dispatch fired. The runtime provisions in ~30-60 sec, then " +
          "clones and installs before the worker registers — the Monitor card appears " +
          "when it heartbeats, which is the real success signal.",
        workflow_url: `https://github.com/${owner}/${repo}/actions/workflows/colab-dispatch.yml`,
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

import { NextResponse } from "next/server";
import { pickWorkers, newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/preflight — proxies to the best live worker's preflight.
 * Returns {ok: false} with a friendly error when no worker is alive
 * (rather than a 500 — preflight is non-fatal info).
 */
export async function GET() {
  const reqId = newRequestId();
  const workers = await pickWorkers();
  if (workers.length === 0) {
    logRoute(reqId, "preflight: no workers");
    return NextResponse.json({
      ok: false,
      error: "no workers online — launch Colab or the HF Space",
    });
  }
  try {
    const r = await fetch(
      `${workers[0].url.replace(/\/$/, "")}/api/preflight`,
      { headers: { "X-Request-Id": reqId, "X-Vercel-Gateway": "1" } },
    );
    // Cloudflare quick tunnels occasionally return an HTML challenge/error
    // page (1033, captcha, etc.) instead of the expected JSON. Detect by
    // content-type and don't try to JSON.parse — a worker that's actively
    // serving real traffic (jobs running) shouldn't make the dashboard
    // show a red banner just because a SINGLE preflight ping got an HTML
    // edge response.
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      logRoute(reqId, "preflight non-json response", {
        backend: workers[0].instance_id, status: r.status, ct,
      });
      // Treat the worker as "presumed ok" — actual job dispatch will
      // surface real errors. Preflight is advisory.
      return NextResponse.json({ ok: true, advisory: "worker reached but preflight endpoint returned non-JSON" });
    }
    const data = await r.json();
    logRoute(reqId, "preflight", { backend: workers[0].instance_id, ok: data?.ok });
    return NextResponse.json(data);
  } catch (e) {
    logRoute(reqId, "preflight failed", { err: String(e) });
    // Soft failure: don't block the dashboard. The Monitor card shows
    // the real-time status of the worker.
    return NextResponse.json({
      ok: true,
      advisory: `preflight ping failed (${String(e).slice(0, 100)}); see Monitor for real-time status`,
    });
  }
}

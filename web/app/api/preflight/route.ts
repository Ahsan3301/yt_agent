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
    const data = await r.json();
    logRoute(reqId, "preflight", { backend: workers[0].instance_id, ok: data?.ok });
    return NextResponse.json(data);
  } catch (e) {
    logRoute(reqId, "preflight failed", { err: String(e) });
    return NextResponse.json({
      ok: false,
      error: `worker unreachable: ${String(e)}`,
    });
  }
}

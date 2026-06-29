import { NextRequest, NextResponse } from "next/server";

/**
 * Next.js middleware — runs on every request before route handlers.
 *
 * Currently does ONE small thing: generate a req_id if the caller
 * didn't provide one, then propagate it on the request AND the
 * response. The Python worker reads X-Request-Id and stamps every
 * log line with it; the dashboard's /queue/[id] page reads it back
 * from the job doc for debugging.
 *
 * Cheap (one runtime: edge), safe to apply globally, gives us
 * end-to-end correlation for free.
 */
export function middleware(req: NextRequest) {
  const existing = req.headers.get("x-request-id");
  const reqId =
    existing && existing.length >= 6
      ? existing
      : _genId();

  const resHeaders = new Headers(req.headers);
  resHeaders.set("x-request-id", reqId);

  const res = NextResponse.next({ request: { headers: resHeaders } });
  res.headers.set("x-request-id", reqId);
  return res;
}

// Apply to API routes only — page renders don't need the middleware overhead.
export const config = {
  matcher: ["/api/:path*"],
};

function _genId(): string {
  // 10 chars, alphanumeric, lowercase. Matches the format Vercel's
  // existing newRequestId() in app/api/_lib/orchestrator uses so the
  // two are visually consistent in logs.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

import Sidebar from "@/components/Sidebar";
import LaunchBanner from "@/components/LaunchBanner";
import { getTenant } from "@/lib/tenant";
import { headers } from "next/headers";

/**
 * Layout for the authenticated user dashboard — every /app/* route.
 * Mounts the Sidebar with role-scoped NAV based on the session role
 * resolved from middleware headers.
 *
 * Since middleware already gates all /app/* routes on presence of a
 * valid session, the role fallback here defaults to "user" — we never
 * see an unauth'd request at layout render time.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Read role from middleware-injected header without re-parsing the cookie.
  const h = await headers();
  const role = (h.get("x-user-role") || "user") as "user" | "admin" | "superadmin";
  const isOperator = role === "admin" || role === "superadmin";
  void getTenant; // keep the import surface stable for future filters
  return (
    <div className="flex md:h-screen md:overflow-hidden min-h-screen">
      <Sidebar role={role} />
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
        <div className="mx-auto max-w-6xl px-4 py-6 md:p-8 space-y-6">
          {/* Worker controls are OPERATOR-only. LaunchBanner is the
              "No backend online — Wake Kaggle (GPU) / Launch Colab"
              panel, and it rendered on every /app page for every user:
              customers were being shown GPU infrastructure they do not
              own, cannot fix, and are not paying to think about. It also
              reads as broken — "No backend online" above an empty queue
              looks like the product is down.

              The API behind the button is operator-gated too, so this is
              the visual half of a boundary the server already enforces. */}
          {isOperator && <LaunchBanner />}
          {children}
        </div>
      </main>
    </div>
  );
}

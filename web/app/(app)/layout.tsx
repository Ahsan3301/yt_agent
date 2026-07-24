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
  void getTenant; // keep the import surface stable for future filters
  return (
    <div className="flex md:h-screen md:overflow-hidden min-h-screen">
      <Sidebar role={role} />
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
        <div className="mx-auto max-w-6xl px-4 py-6 md:p-8 space-y-6">
          <LaunchBanner />
          {children}
        </div>
      </main>
    </div>
  );
}

import Sidebar from "@/components/Sidebar";
import LaunchBanner from "@/components/LaunchBanner";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Layout for /admin/* routes — requires role in {admin, superadmin}.
 * Middleware handles the coarse "is there a session?" check; this
 * layout enforces the role gate.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const role = h.get("x-user-role") || "";
  if (role !== "admin" && role !== "superadmin") {
    redirect("/app");
  }
  return (
    <div className="flex md:h-screen md:overflow-hidden min-h-screen">
      <Sidebar role={role as "admin" | "superadmin"} />
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
        <div className="mx-auto max-w-6xl px-4 py-6 md:p-8 space-y-6">
          <LaunchBanner />
          {children}
        </div>
      </main>
    </div>
  );
}

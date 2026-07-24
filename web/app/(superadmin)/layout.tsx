import Sidebar from "@/components/Sidebar";
import LaunchBanner from "@/components/LaunchBanner";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Layout for /superadmin/* routes — requires role=superadmin.
 * Middleware also role-gates these paths as a first line of defense;
 * this layout is the second gate that runs even if middleware is
 * bypassed (e.g. edge-runtime failure fallback).
 */
export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const role = h.get("x-user-role") || "";
  if (role !== "superadmin") {
    redirect("/app");
  }
  return (
    <div className="flex md:h-screen md:overflow-hidden min-h-screen">
      <Sidebar role="superadmin" />
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
        <div className="mx-auto max-w-6xl px-4 py-6 md:p-8 space-y-6">
          <LaunchBanner />
          {children}
        </div>
      </main>
    </div>
  );
}

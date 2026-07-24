import "./globals.css";
import type { Metadata } from "next";
import { ToastProvider } from "@/components/Toast";

/**
 * Root layout — minimal HTML shell only.
 *
 * Sidebar + LaunchBanner used to mount here, which meant they rendered
 * on every page including the public landing + login. Phase 3 splits
 * those responsibilities into route-group layouts:
 *
 *   web/app/(marketing)/layout.tsx  → no sidebar, marketing chrome
 *   web/app/(app)/layout.tsx        → mounts Sidebar for /app/*
 *   web/app/(admin)/layout.tsx      → Sidebar + role guard (admin+)
 *   web/app/(superadmin)/layout.tsx → Sidebar + role guard (superadmin)
 *
 * ToastProvider stays at root because toasts should work on every page
 * (login errors, signup errors, etc.).
 */
export const metadata: Metadata = {
  title: "YT Agent",
  description: "Gothic-horror Shorts automation studio",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

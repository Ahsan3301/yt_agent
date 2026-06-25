import "./globals.css";
import type { Metadata } from "next";
import Sidebar from "@/components/Sidebar";
import LaunchBanner from "@/components/LaunchBanner";

export const metadata: Metadata = {
  title: "YT Agent",
  description: "Gothic-horror Shorts automation studio",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning on both elements: browser extensions
    // (Grammarly, BetterDeals, Honey, etc.) inject attributes like
    // `data-gr-ext-installed` and `bis_skin_checked` into the DOM before
    // React hydrates. The mismatch is harmless and unfixable from our
    // side; suppressing keeps the dev console clean.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <div className="flex md:h-screen md:overflow-hidden min-h-screen">
          <Sidebar />
          <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
            <div className="mx-auto max-w-6xl px-4 py-6 md:p-8 space-y-6">
              {/* Show the launch banner on EVERY page when no backend is
                  online — otherwise users on Keys/Settings just see API
                  errors with no explanation. */}
              <LaunchBanner />
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}

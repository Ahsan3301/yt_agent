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
const TITLE = "Yven — The First Complete Video Automation Engine";
const DESCRIPTION =
  "Attach your channel. Yven researches trends, writes scripts, generates visuals, edits, adds subtitles, and publishes — while you sleep. One engine replaces the entire stack.";

/**
 * Favicons come from the file conventions — app/icon.png and
 * app/apple-icon.png — which Next discovers at build time and emits
 * <link> tags for. They are not listed here; declaring `icons` as well
 * would produce a second, competing set of tags.
 *
 * `metadataBase` has to be absolute for the OG image: crawlers do not
 * resolve relative URLs, so without it the share card silently falls
 * back to no image at all.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://yven.io"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Yven",
    type: "website",
    images: [{ url: "/brand/yven-og.png", width: 1200, height: 630, alt: "Yven" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/brand/yven-og.png"],
  },
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

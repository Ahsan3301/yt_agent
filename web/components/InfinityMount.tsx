"use client";

import dynamic from "next/dynamic";

/**
 * Client-side wrapper for the Three.js infinity.
 *
 * `next/dynamic({ ssr: false })` isn't allowed in server components
 * in Next 15+ — the check must happen inside a client boundary.
 * This tiny wrapper does the lazy-load so the ~140kb WebGL bundle
 * stays out of the initial page payload, and the marketing/page.tsx
 * server component can import this file cleanly.
 */
const InfinityScene = dynamic(() => import("./InfinityScene"), {
  ssr: false,
  loading: () => <div className="w-[min(760px,92vw)] aspect-[16/10] mb-8" aria-hidden />,
});

export function InfinityMount() {
  return <InfinityScene />;
}

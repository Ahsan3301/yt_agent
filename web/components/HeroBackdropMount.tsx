"use client";

import dynamic from "next/dynamic";

/**
 * Client boundary for the WebGL hero backdrop.
 *
 * `next/dynamic({ ssr: false })` is not permitted inside a server
 * component in Next 15+, so the lazy import has to happen behind a
 * "use client" file. Keeping it in its own module means the Three.js
 * bundle stays out of the initial page payload — the hero renders
 * and is readable before any WebGL loads, and the gradient fades in
 * once it does.
 */
const HeroBackdrop = dynamic(() => import("./HeroBackdrop"), {
  ssr: false,
  loading: () => null,
});

export function HeroBackdropMount() {
  return <HeroBackdrop />;
}

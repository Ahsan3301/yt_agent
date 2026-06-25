"use client";

import { useEffect, useState } from "react";
import { runVideoUrl } from "@/lib/api";

/**
 * Wraps a <video> tag and resolves the backend URL asynchronously.
 * Use this everywhere a run's video needs to play — accepts either a
 * `runId` (resolves through the registry) or an explicit `publicUrl`
 * (Hostinger CDN, already-resolved).
 */
export default function VideoPlayer({
  runId,
  publicUrl,
  className,
}: {
  runId?: string;
  publicUrl?: string | null;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(publicUrl || null);

  useEffect(() => {
    if (publicUrl) {
      setSrc(publicUrl);
      return;
    }
    if (!runId) return;
    let cancelled = false;
    runVideoUrl(runId).then((u) => {
      if (!cancelled) setSrc(u);
    });
    return () => { cancelled = true; };
  }, [runId, publicUrl]);

  if (!src) {
    return (
      <div className={className + " bg-bg-2 animate-pulse flex items-center justify-center text-xs text-neutral-500"}>
        Loading video…
      </div>
    );
  }
  return (
    <video controls preload="none" className={className} src={src} />
  );
}

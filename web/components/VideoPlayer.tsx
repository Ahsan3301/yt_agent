"use client";

import { useEffect, useState } from "react";
import { runVideoUrl } from "@/lib/api";

/**
 * Wraps a <video> tag, resolves the source asynchronously, and falls
 * back to the local backend if the public Hostinger URL doesn't load.
 *
 * Resolution order:
 *   1. `publicUrl` — the canonical Hostinger CDN URL (best after restart)
 *   2. `<backend>/api/runs/<runId>/video` — backend-streamed local copy
 *
 * If (1) errors out (404, network), we fall through to (2). The reverse
 * isn't useful — if the local backend has the file, the public URL
 * usually also has it.
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
  const [triedFallback, setTriedFallback] = useState(false);

  useEffect(() => {
    setTriedFallback(false);
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

  const onError = async () => {
    // If the Hostinger URL failed, try the backend-served local copy
    // (which itself 302-redirects to Hostinger if the local file is
    // gone — gives us one more shot in case of CDN propagation lag).
    if (triedFallback || !runId) return;
    setTriedFallback(true);
    try {
      const u = await runVideoUrl(runId);
      setSrc(u);
    } catch {
      // give up — let the <video> show its native error UI
    }
  };

  if (!src) {
    return (
      <div className={className + " bg-bg-2 animate-pulse flex items-center justify-center text-xs text-neutral-500"}>
        Loading video…
      </div>
    );
  }
  return (
    <video controls preload="none" className={className} src={src} onError={onError} />
  );
}

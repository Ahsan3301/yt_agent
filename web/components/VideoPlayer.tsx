"use client";

import { useState, useMemo, useCallback } from "react";
import { PlayCircle, ExternalLink } from "lucide-react";
import { runVideoUrl } from "@/lib/api";

/**
 * Lightweight media player with source tabs.
 *
 * Design notes:
 * - `<video>` uses `preload="metadata"` and defers actual byte fetch
 *   until the user clicks play. HTTP range requests are browser-native,
 *   so MinIO / R2 / S3 mirrors stream progressively at zero extra cost.
 * - YouTube tab is a real `<iframe>` embed — Google handles the entire
 *   delivery, so no bandwidth or CPU on our server. Same as embedding
 *   in a blog: zero load on Coolify.
 * - Nothing is fetched until the user chooses to play. The default
 *   state is a poster + play button, so the Library page can render
 *   dozens of rows without any per-row network cost.
 * - No third-party JS libs — everything is native <video> / <iframe>.
 *
 * Sources accepted (in dropdown order — first is default):
 *   - publicUrl        : primary storage URL (MinIO etc.)
 *   - mirrors[]        : { provider_id, url } — R2, AWS S3, ...
 *   - youtubeVideoId   : embed via youtube-nocookie.com
 *   - runId            : falls back to /api/runs/<id>/video (worker-local)
 */
type Source = { kind: "mp4" | "youtube"; label: string; url: string };

export default function VideoPlayer({
  runId,
  publicUrl,
  mirrors,
  youtubeVideoId,
  poster,
  className,
}: {
  runId?: string;
  publicUrl?: string | null;
  mirrors?: Array<{ provider_id: string; url: string }>;
  youtubeVideoId?: string | null;
  poster?: string | null;
  className?: string;
}) {
  const sources: Source[] = useMemo(() => {
    const out: Source[] = [];
    if (publicUrl) {
      out.push({ kind: "mp4", label: _labelForUrl(publicUrl), url: publicUrl });
    }
    for (const m of mirrors || []) {
      if (m.url && m.url !== publicUrl) {
        out.push({
          kind: "mp4",
          label: m.provider_id ? m.provider_id.slice(0, 12) : _labelForUrl(m.url),
          url: m.url,
        });
      }
    }
    if (youtubeVideoId) {
      out.push({
        kind: "youtube",
        label: "YouTube",
        url: `https://www.youtube-nocookie.com/embed/${youtubeVideoId}?autoplay=0&modestbranding=1&rel=0`,
      });
    }
    return out;
  }, [publicUrl, mirrors, youtubeVideoId]);

  const [selected, setSelected] = useState<number>(0);
  const [playing, setPlaying] = useState(false);
  const [fallbackTried, setFallbackTried] = useState(false);
  const [resolvedFallback, setResolvedFallback] = useState<string | null>(null);

  const cur = sources[selected] || null;
  const activeUrl = fallbackTried && resolvedFallback ? resolvedFallback : cur?.url || null;

  // On <video> error, one-shot fallback to the worker's /api/runs/<id>/video.
  const onError = useCallback(async () => {
    if (fallbackTried || !runId) return;
    setFallbackTried(true);
    try {
      const u = await runVideoUrl(runId);
      setResolvedFallback(u);
    } catch { /* give up — <video> shows native error */ }
  }, [fallbackTried, runId]);

  // Nothing to play at all.
  if (sources.length === 0 && !runId) {
    return (
      <div className={`${className || ""} bg-bg-2 flex items-center justify-center text-xs text-neutral-500`}>
        No video available yet
      </div>
    );
  }
  // If no publicUrl / mirror / youtube but we have runId, resolve on
  // first play (avoids the async fetch during initial paint).
  if (sources.length === 0 && runId) {
    return (
      <RunIdLazyPlayer runId={runId} poster={poster} className={className} onError={onError} />
    );
  }

  return (
    <div className={`space-y-1 ${className || ""}`}>
      {/* Source tabs. Only show when 2+ sources — one source doesn't
          need chrome. */}
      {sources.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          {sources.map((s, i) => (
            <button
              key={i}
              onClick={() => { setSelected(i); setPlaying(false); setFallbackTried(false); }}
              className={`px-2 h-6 rounded border ${
                i === selected
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line bg-bg-2 text-neutral-400 hover:text-neutral-200"
              }`}
              title={s.url}
            >
              {s.label}
            </button>
          ))}
          {cur && (
            <a
              href={cur.url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-neutral-500 hover:text-neutral-300 inline-flex items-center gap-1"
              title="Open in new tab"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      {/* Player body */}
      <div className={`${className || ""} bg-black rounded overflow-hidden relative aspect-[9/16]`}>
        {cur?.kind === "youtube" ? (
          // YouTube embed — Google handles delivery, zero server load.
          // `preconnect` on hover would be nicer, but the iframe won't
          // fetch until visible so it's fine to mount immediately.
          <iframe
            src={cur.url}
            title="YouTube video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="w-full h-full border-0"
          />
        ) : playing && activeUrl ? (
          <video
            controls
            autoPlay
            preload="metadata"
            playsInline
            poster={poster || undefined}
            src={activeUrl}
            onError={onError}
            className="w-full h-full object-contain"
          />
        ) : (
          <button
            onClick={() => setPlaying(true)}
            className="absolute inset-0 flex items-center justify-center bg-black hover:bg-neutral-900 transition text-neutral-300"
            style={poster ? { backgroundImage: `url(${poster})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
            aria-label="Play video"
          >
            <PlayCircle className="h-14 w-14 opacity-90 drop-shadow-lg" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Runners for the edge cases ────────────────────────────────

function RunIdLazyPlayer({
  runId, poster, className, onError,
}: {
  runId: string; poster?: string | null; className?: string; onError: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const start = async () => {
    if (!src) {
      try {
        const u = await runVideoUrl(runId);
        setSrc(u);
      } catch { return; }
    }
    setPlaying(true);
  };
  return (
    <div className={`${className || ""} bg-black rounded overflow-hidden relative aspect-[9/16]`}>
      {playing && src ? (
        <video
          controls
          autoPlay
          preload="metadata"
          playsInline
          poster={poster || undefined}
          src={src}
          onError={onError}
          className="w-full h-full object-contain"
        />
      ) : (
        <button
          onClick={start}
          className="absolute inset-0 flex items-center justify-center bg-black hover:bg-neutral-900 text-neutral-300"
          style={poster ? { backgroundImage: `url(${poster})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
          aria-label="Play video"
        >
          <PlayCircle className="h-14 w-14 opacity-90 drop-shadow-lg" />
        </button>
      )}
    </div>
  );
}

// ── URL label heuristics ────────────────────────────────

function _labelForUrl(u: string): string {
  try {
    const host = new URL(u).host;
    if (host.includes("thyker.online")) return "MinIO";
    if (host.endsWith(".r2.dev") || host.includes("cloudflare")) return "R2";
    if (host.endsWith(".amazonaws.com")) return "S3";
    if (host.endsWith(".hostinger")) return "Hostinger";
    return host;
  } catch {
    return "primary";
  }
}

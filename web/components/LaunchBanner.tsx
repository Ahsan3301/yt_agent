"use client";

import { useEffect, useState } from "react";
import { Rocket, ExternalLink, Loader2, CheckCircle2 } from "lucide-react";
import { fetchLiveBackends, COLAB_URL, type RegistryEntry } from "@/lib/api";
import { getDb, isFirestoreConfigured } from "@/lib/firestore";
import { collection, onSnapshot, Timestamp } from "firebase/firestore";

/**
 * Shows a prominent "Launch backend" CTA whenever no Colab instance is
 * registered. As soon as a backend boots and starts heartbeating into the
 * registry, the banner disappears automatically.
 *
 * Set NEXT_PUBLIC_COLAB_URL in Vercel to the Colab notebook URL you want
 * the button to open — e.g. `https://colab.research.google.com/github/
 * <you>/yt_agent/blob/main/colab/yt_agent_colab.ipynb`.
 */
export default function LaunchBanner() {
  const [backends, setBackends] = useState<RegistryEntry[] | null>(null);
  const [waitingForBoot, setWaitingForBoot] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Preferred path: Firestore realtime subscription. Instantly reflects
    // backend add/remove without polling.
    if (isFirestoreConfigured()) {
      const db = getDb();
      if (db) {
        const unsub = onSnapshot(
          collection(db, "backends"),
          (snap) => {
            if (cancelled) return;
            const cutoff = Date.now() / 1000 - 180;
            const list: RegistryEntry[] = [];
            snap.forEach((doc) => {
              const d = doc.data() as Record<string, unknown>;
              const last = _firestoreEpoch(d.last_seen);
              if (last !== null && last < cutoff) return;
              const url = String(d.url || "");
              if (!url) return;
              list.push({
                instance_id: doc.id, url,
                status:      d.status === "busy" ? "busy" : "available",
                queue_depth: Number(d.queue_depth ?? 0),
                last_seen:   last ?? Date.now() / 1000,
                tier:        d.tier === "cpu" ? "cpu" : "gpu",
                label:       (d.label as string) ?? null,
              });
            });
            setBackends(list);
            if (waitingForBoot && list.length > 0) setWaitingForBoot(false);
          },
          (err) => console.warn("LaunchBanner snapshot error:", err),
        );
        return () => { cancelled = true; unsub(); };
      }
    }

    // Legacy fallback: poll the registry file(s).
    const tick = async () => {
      if (cancelled) return;
      try {
        const list = await fetchLiveBackends();
        if (cancelled) return;
        setBackends(list);
        if (waitingForBoot && list.length > 0) setWaitingForBoot(false);
      } catch { /* noop */ }
      const delay = waitingForBoot ? 5_000 : 20_000;
      setTimeout(tick, delay);
    };
    tick();
    return () => { cancelled = true; };
  }, [waitingForBoot]);

  // Still loading: show nothing (avoid flash)
  if (backends === null) return null;

  const gpuOnline = backends.some((b) => b.tier !== "cpu");
  const cpuOnline = backends.some((b) => b.tier === "cpu");

  // GPU backend is up → no banner needed.
  if (gpuOnline) return null;

  // Only CPU is up → small advisory banner (not full takeover)
  if (cpuOnline) {
    return (
      <div className="card border-amber-500/20 bg-amber-500/5 flex items-start gap-3">
        <Rocket className="h-4 w-4 text-amber-300 mt-1 shrink-0" />
        <div className="flex-1 text-sm">
          <div className="font-medium text-amber-200">CPU fallback running</div>
          <div className="text-neutral-400 text-xs mt-0.5">
            Only the HuggingFace Space (slow CPU) is online — renders take ~5-10 min.
            {COLAB_URL && (
              <>
                {" "}
                <a href={COLAB_URL} target="_blank" rel="noreferrer"
                   className="text-accent underline">
                  Launch a Colab GPU
                </a>{" "}
                for ~10× faster renders.
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // No backend at all
  const colabReady = !!COLAB_URL;

  return (
    <div className="card border-accent/40 bg-gradient-to-br from-accent/10 to-bg-1
                    shadow-glow">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-accent/15 p-3">
          <Rocket className="h-6 w-6 text-accent" />
        </div>
        <div className="flex-1 space-y-3">
          <div>
            <div className="text-lg font-semibold">No backend online</div>
            <div className="text-sm text-neutral-400 mt-0.5">
              {waitingForBoot
                ? "Waiting for your Colab to boot and register…"
                : "Spin up a Colab GPU session to start rendering videos."}
            </div>
          </div>

          {waitingForBoot ? (
            <div className="flex items-center gap-2 text-sm text-amber-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Polling registry every 5s. The Colab boot takes ~90s.</span>
            </div>
          ) : (
            <ol className="text-sm text-neutral-300 space-y-1 list-decimal list-inside">
              <li>Click <b>Launch backend</b> below — opens the Colab notebook in a new tab.</li>
              <li>Hit <b>Runtime → Run all</b>. Confirm "Run anyway" if prompted.</li>
              <li>Wait ~90 seconds for the tunnel + registry heartbeat.</li>
              <li>This page detects it automatically — no refresh needed.</li>
            </ol>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {colabReady ? (
              <a
                href={COLAB_URL} target="_blank" rel="noreferrer"
                onClick={() => setWaitingForBoot(true)}
                className="btn btn-primary"
              >
                <Rocket className="h-4 w-4" />
                Launch backend (Colab)
                <ExternalLink className="h-3.5 w-3.5 opacity-70" />
              </a>
            ) : (
              <div className="text-xs text-amber-300">
                Set <code className="font-mono">NEXT_PUBLIC_COLAB_URL</code> in your Vercel
                environment variables to enable the launch button.
              </div>
            )}
            {waitingForBoot && (
              <button onClick={() => setWaitingForBoot(false)} className="btn btn-ghost">
                Stop polling
              </button>
            )}
          </div>

          {/* Quick-status of past registrations (purely informational) */}
          {waitingForBoot && (
            <div className="text-xs text-neutral-500 pt-1 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" />
              Idle watchdog will auto-terminate the Colab after ~10 min of inactivity to
              preserve your free-tier hours.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function _firestoreEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "seconds" in v) {
    const t = v as { seconds: number; nanoseconds?: number };
    return t.seconds + (t.nanoseconds ?? 0) / 1e9;
  }
  if (v instanceof Timestamp) return v.toMillis() / 1000;
  return null;
}

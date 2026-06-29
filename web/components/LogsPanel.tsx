"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal, Pause, Play, Trash2, ArrowDown, Radio } from "lucide-react";
import clsx from "clsx";
import { fetchLogs, clearLogs, type LogEntry } from "@/lib/api";
import { getDb, isFirestoreConfigured } from "@/lib/firestore";
import {
  collection, query, orderBy, onSnapshot, Timestamp,
} from "firebase/firestore";

/**
 * Live backend logs.
 *
 * Two streaming modes, picked at mount time:
 *
 *   • Firestore subcollection (PREFERRED when `runId` is provided AND
 *     Firestore is configured). Subscribes to runs_index/<id>/logs via
 *     onSnapshot — true realtime, survives worker tunnel hiccups, and
 *     the trail persists even after the worker dies.
 *
 *   • Polling fallback — the original behaviour. Polls /api/logs on the
 *     worker URL. Slower; depends on tunnel + worker liveness. Used
 *     when no runId is available (legacy dashboard live-tail) or when
 *     Firestore isn't reachable from the browser.
 *
 * Either way the UI is identical: filter, level chips, follow-tail
 * with auto-scroll, pause, clear.
 */
export default function LogsPanel({
  active,
  className,
  runId,
}: {
  active: boolean;
  className?: string;
  /** When provided, switch to Firestore realtime subscription on this run. */
  runId?: string;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [headSeq, setHeadSeq] = useState(0);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<"ALL" | "INFO" | "WARN" | "ERROR">("ALL");

  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);

  // Pick streaming mode at mount:
  // Firestore realtime if we have a runId AND Firestore is configured;
  // otherwise the polling fallback path.
  const firestoreMode = !!(runId && isFirestoreConfigured());
  const [streamingFrom, setStreamingFrom] = useState<"firestore" | "poll" | null>(null);

  // Firestore branch — onSnapshot on runs_index/<runId>/logs.
  useEffect(() => {
    if (!firestoreMode || paused || !runId) return;
    const db = getDb();
    if (!db) return;
    const q = query(
      collection(db, "runs_index", runId, "logs"),
      orderBy("ts", "asc"),
    );
    let cancelled = false;
    const unsub = onSnapshot(
      q,
      (snap) => {
        if (cancelled) return;
        // Build the full list from Firestore — sink ships in batches
        // (~50 lines each) so this is bounded.
        const all: LogEntry[] = [];
        snap.forEach((doc) => {
          const d = doc.data() as Record<string, unknown>;
          const ts = d.ts;
          let epoch = 0;
          if (typeof ts === "number") epoch = ts;
          else if (ts instanceof Timestamp) epoch = ts.toMillis() / 1000;
          else if (ts && typeof ts === "object" && "seconds" in (ts as object)) {
            const t = ts as { seconds: number; nanoseconds?: number };
            epoch = t.seconds + (t.nanoseconds ?? 0) / 1e9;
          } else {
            epoch = Date.now() / 1000;
          }
          all.push({
            seq:   Number(d.seq ?? doc.id) || 0,
            time:  epoch,
            level: String(d.level || "INFO"),
            name:  String(d.name || ""),
            msg:   String(d.msg || ""),
          });
        });
        setEntries(all.slice(-2000));
        if (all.length > 0) setHeadSeq(all[all.length - 1].seq);
        setStreamingFrom("firestore");
      },
      (err) => {
        console.warn("LogsPanel firestore subscription error:", err);
      },
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [firestoreMode, runId, paused]);

  // Polling fallback — runs only when NOT in firestoreMode.
  useEffect(() => {
    if (firestoreMode) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const delay = active ? 1200 : 4000;
      if (!paused) {
        try {
          const page = await fetchLogs(lastSeqRef.current, 500);
          if (!cancelled && page.entries.length > 0) {
            lastSeqRef.current = page.head_seq || lastSeqRef.current;
            setHeadSeq(page.head_seq);
            setEntries((prev) => {
              // Keep last 2000 entries.
              const merged = [...prev, ...page.entries];
              return merged.length > 2000
                ? merged.slice(merged.length - 2000)
                : merged;
            });
            setStreamingFrom("poll");
          }
        } catch {
          // backend hiccup — try again next tick
        }
      }
      setTimeout(tick, delay);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [firestoreMode, active, paused]);

  // Auto-scroll to bottom when new entries arrive AND user wants to follow.
  useEffect(() => {
    if (!follow) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, follow]);

  // Detect when the user scrolls up — turn follow off until they
  // press the "jump to latest" button.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(nearBottom);
  }, []);

  const onClear = async () => {
    try {
      await clearLogs();
    } catch {}
    setEntries([]);
    lastSeqRef.current = 0;
    setHeadSeq(0);
  };

  const visible = entries.filter((e) => {
    if (level !== "ALL") {
      const l = e.level.toUpperCase();
      if (level === "WARN" && !l.startsWith("WARN")) return false;
      if (level === "INFO" && l !== "INFO") return false;
      if (level === "ERROR" && l !== "ERROR" && l !== "CRITICAL") return false;
    }
    if (filter) {
      const q = filter.toLowerCase();
      if (
        !e.msg.toLowerCase().includes(q) &&
        !e.name.toLowerCase().includes(q) &&
        !e.level.toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  return (
    <div className={clsx("card space-y-3", className)}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-accent" />
          <span className="font-semibold">Live logs</span>
          {streamingFrom === "firestore" && (
            <span className="pill pill-success text-[10px]" title="Realtime via Firestore subscription">
              <Radio className="h-3 w-3" /> live
            </span>
          )}
          {streamingFrom === "poll" && (
            <span className="pill pill-muted text-[10px]" title="Polling worker /api/logs">
              poll
            </span>
          )}
          <span className="text-xs text-neutral-500">
            {entries.length} entries · seq {headSeq}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <LevelChip cur={level} v="ALL" set={setLevel}>All</LevelChip>
          <LevelChip cur={level} v="INFO" set={setLevel}>Info</LevelChip>
          <LevelChip cur={level} v="WARN" set={setLevel}>Warn</LevelChip>
          <LevelChip cur={level} v="ERROR" set={setLevel}>Error</LevelChip>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="input h-7 text-xs w-28 ml-1"
          />
          <button
            className="btn btn-ghost h-7 px-2"
            title={paused ? "Resume" : "Pause"}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          <button
            className="btn btn-ghost h-7 px-2"
            title="Clear"
            onClick={onClear}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="h-72 overflow-y-auto rounded-md border border-line bg-bg-2 font-mono text-[12px] leading-relaxed"
        >
          {visible.length === 0 ? (
            <div className="p-4 text-neutral-500">
              {active ? "Waiting for backend output…" : "No logs yet. Run a pipeline to see live output."}
            </div>
          ) : (
            <div className="px-3 py-2 space-y-0.5">
              {visible.map((e) => (
                <LogRow key={e.seq} entry={e} />
              ))}
            </div>
          )}
        </div>
        {!follow && (
          <button
            onClick={() => {
              setFollow(true);
              const el = scrollerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="absolute bottom-3 right-3 btn btn-primary h-7 px-2 text-xs shadow-lg"
          >
            <ArrowDown className="h-3 w-3" /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const lvl = entry.level.toUpperCase();
  const color =
    lvl === "ERROR" || lvl === "CRITICAL"
      ? "text-red-300"
      : lvl.startsWith("WARN")
      ? "text-amber-300"
      : lvl === "DEBUG"
      ? "text-neutral-500"
      : "text-neutral-200";
  const t = new Date(entry.time * 1000);
  const ts =
    t.toLocaleTimeString("en-GB", { hour12: false }) +
    "." +
    String(t.getMilliseconds()).padStart(3, "0");
  const shortName = entry.name.replace(/^modules\./, "").replace(/^backend\./, "");
  return (
    <div className={clsx("whitespace-pre-wrap", color)}>
      <span className="text-neutral-500">{ts} </span>
      <span className={clsx(
        "inline-block min-w-[3.5rem]",
        lvl === "ERROR" || lvl === "CRITICAL" ? "text-red-400" :
        lvl.startsWith("WARN") ? "text-amber-400" :
        lvl === "DEBUG" ? "text-neutral-500" :
        "text-emerald-400",
      )}>{lvl}</span>
      <span className="text-accent"> {shortName}</span>
      <span className="text-neutral-400">: </span>
      <span>{entry.msg}</span>
    </div>
  );
}

function LevelChip({
  cur, v, set, children,
}: {
  cur: string;
  v: "ALL" | "INFO" | "WARN" | "ERROR";
  set: (v: any) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={() => set(v)}
      className={clsx(
        "h-7 px-2 rounded-md text-xs border transition-colors",
        cur === v
          ? "border-accent bg-accent/15 text-accent"
          : "border-line text-neutral-400 hover:border-neutral-600",
      )}
    >
      {children}
    </button>
  );
}

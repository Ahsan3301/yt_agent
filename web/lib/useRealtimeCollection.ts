"use client";

import { useEffect, useRef, useState } from "react";
import {
  collection, onSnapshot, query, type Query, type CollectionReference,
  type Firestore, type FirestoreError,
} from "firebase/firestore";

import { getDb, isFirestoreConfigured } from "@/lib/firestore";

/**
 * Resilient realtime collection subscription.
 *
 * Works with BOTH backends. The decision is made at module load:
 *   - NEXT_PUBLIC_PB_URL set → use Pocketbase SSE subscriptions
 *     (https://pocketbase.io/docs/api-realtime/) via EventSource.
 *   - Otherwise → use Firestore onSnapshot.
 *
 * Public API stays the same — `useRealtimeCollection("backends")` returns
 * `{ snapshot, error, reconnectCount }` where `snapshot` has the
 * Firestore-shaped `.forEach()` and `.docs[]`.
 *
 * Resilience: error callback re-subscribes after a short backoff +
 * 2-min silence watchdog tears down + resubs anyway. Same hardening as
 * before — battle-tested against tunnel hiccups + laptop-sleep gaps.
 */

const SILENCE_MS = 2 * 60 * 1000;
const RETRY_BACKOFF_MS = 3000;
const PB_URL = (
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_PB_URL) || ""
).replace(/\/$/, "");

// A Firestore-shape snapshot wrapper used in PB mode so callers don't
// have to know which backend is live.
type DocLike = {
  id: string;
  data: () => Record<string, unknown> | undefined;
};
type RealtimeSnapshot = {
  size: number;
  empty: boolean;
  docs: DocLike[];
  forEach: (cb: (doc: DocLike) => void) => void;
};

function _wrapPocketbaseRecords(records: Record<string, unknown>[]): RealtimeSnapshot {
  const docs: DocLike[] = records.map((r) => ({
    id: String(r.id ?? ""),
    data: () => {
      const out: Record<string, unknown> = { ...r };
      delete out.collectionId;
      delete out.collectionName;
      delete out.created;
      delete out.updated;
      delete out.expand;
      return out;
    },
  }));
  return {
    size: docs.length,
    empty: docs.length === 0,
    docs,
    forEach: (cb) => docs.forEach(cb),
  };
}

export function useRealtimeCollection(
  pathOrQuery: string | ((db: Firestore) => Query | CollectionReference),
) {
  // Firestore-typed snapshot for back-compat. PB-mode returns a shape-
  // compatible plain object cast through unknown.
  const [snapshot, setSnapshot] = useState<RealtimeSnapshot | null>(null);
  const [error, setError] = useState<FirestoreError | Error | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  const lastEventAt = useRef<number>(Date.now());

  useEffect(() => {
    // Pocketbase branch.
    if (PB_URL && typeof pathOrQuery === "string") {
      const collectionName = pathOrQuery;
      let es: EventSource | null = null;
      let cancelled = false;
      let watchdog: ReturnType<typeof setInterval> | null = null;
      let backoffTimer: ReturnType<typeof setTimeout> | null = null;
      let records: Record<string, unknown>[] = [];

      const subscribe = async () => {
        if (cancelled) return;
        // Initial snapshot via REST.
        try {
          const r = await fetch(
            `${PB_URL}/api/collections/${collectionName}/records?perPage=200`,
            { cache: "no-store" },
          );
          if (r.ok) {
            const j = await r.json();
            records = (j.items || []) as Record<string, unknown>[];
            lastEventAt.current = Date.now();
            setSnapshot(_wrapPocketbaseRecords(records));
            setError(null);
          }
        } catch (e) {
          console.warn("useRealtimeCollection: initial fetch failed", e);
        }

        // PB realtime — clients first connect, get a clientId, then POST
        // a subscription. Native EventSource handles the SSE side.
        es = new EventSource(`${PB_URL}/api/realtime`);
        let clientId = "";

        es.addEventListener("PB_CONNECT", async (ev: MessageEvent) => {
          if (cancelled) return;
          try {
            clientId = String(JSON.parse(ev.data).clientId || "");
            // Subscribe to the collection's wildcard topic.
            await fetch(`${PB_URL}/api/realtime`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                clientId,
                subscriptions: [`${collectionName}/*`],
              }),
            });
          } catch (e) {
            console.warn("useRealtimeCollection: subscribe POST failed", e);
          }
        });

        // PB sends events under the topic name as the event type.
        es.addEventListener(`${collectionName}/*`, (ev: MessageEvent) => {
          if (cancelled) return;
          try {
            const { action, record } = JSON.parse(ev.data);
            const rec = record as Record<string, unknown>;
            const id = String(rec.id || "");
            if (action === "create") {
              records = [...records, rec];
            } else if (action === "update") {
              records = records.map((r) => (r.id === id ? rec : r));
            } else if (action === "delete") {
              records = records.filter((r) => r.id !== id);
            }
            lastEventAt.current = Date.now();
            setSnapshot(_wrapPocketbaseRecords(records));
          } catch (e) {
            console.warn("useRealtimeCollection: event parse failed", e);
          }
        });

        es.onerror = (e) => {
          if (cancelled) return;
          console.warn("useRealtimeCollection: PB SSE error, reconnecting", e);
          setError(new Error("PB SSE connection lost"));
          if (es) {
            try { es.close(); } catch { /* noop */ }
            es = null;
          }
          backoffTimer = setTimeout(() => {
            setReconnectCount((n) => n + 1);
            subscribe();
          }, RETRY_BACKOFF_MS);
        };
      };

      lastEventAt.current = Date.now();
      subscribe();

      watchdog = setInterval(() => {
        if (cancelled) return;
        if (Date.now() - lastEventAt.current > SILENCE_MS) {
          console.warn(
            `useRealtimeCollection (PB): silent for >${SILENCE_MS}ms, forcing resub`,
          );
          if (es) {
            try { es.close(); } catch { /* noop */ }
            es = null;
          }
          lastEventAt.current = Date.now();
          setReconnectCount((n) => n + 1);
          subscribe();
        }
      }, 30_000);

      return () => {
        cancelled = true;
        if (es) try { es.close(); } catch { /* noop */ }
        if (watchdog) clearInterval(watchdog);
        if (backoffTimer) clearTimeout(backoffTimer);
      };
    }

    // Firestore branch (unchanged).
    if (!isFirestoreConfigured()) return;
    const db = getDb();
    if (!db) return;

    let unsub: (() => void) | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;

    const subscribe = () => {
      if (cancelled) return;
      try {
        const ref =
          typeof pathOrQuery === "string"
            ? collection(db, pathOrQuery)
            : pathOrQuery(db);
        const q = "type" in (ref as object) && (ref as Query).type === "query"
          ? (ref as Query)
          : query(ref as CollectionReference);
        unsub = onSnapshot(
          q,
          (snap) => {
            lastEventAt.current = Date.now();
            if (!cancelled) {
              // The Firestore QuerySnapshot already matches our DocLike
              // shape via the `.forEach` and `.docs[]` it ships.
              setSnapshot(snap as unknown as RealtimeSnapshot);
              setError(null);
            }
          },
          (err) => {
            if (cancelled) return;
            console.warn("useRealtimeCollection: subscription error, reconnecting", err);
            setError(err);
            if (unsub) {
              try { unsub(); } catch { /* noop */ }
              unsub = null;
            }
            backoffTimer = setTimeout(() => {
              setReconnectCount((n) => n + 1);
              subscribe();
            }, RETRY_BACKOFF_MS);
          },
        );
      } catch (e) {
        console.warn("useRealtimeCollection: subscribe threw", e);
        if (!cancelled) {
          backoffTimer = setTimeout(() => {
            setReconnectCount((n) => n + 1);
            subscribe();
          }, RETRY_BACKOFF_MS);
        }
      }
    };

    lastEventAt.current = Date.now();
    subscribe();

    watchdog = setInterval(() => {
      if (cancelled) return;
      if (Date.now() - lastEventAt.current > SILENCE_MS) {
        console.warn(
          `useRealtimeCollection: silent for >${SILENCE_MS}ms, forcing resubscribe`,
        );
        if (unsub) {
          try { unsub(); } catch { /* noop */ }
          unsub = null;
        }
        lastEventAt.current = Date.now();
        setReconnectCount((n) => n + 1);
        subscribe();
      }
    }, 30_000);

    return () => {
      cancelled = true;
      if (unsub) try { unsub(); } catch { /* noop */ }
      if (watchdog) clearInterval(watchdog);
      if (backoffTimer) clearTimeout(backoffTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeof pathOrQuery === "string" ? pathOrQuery : pathOrQuery]);

  return { snapshot, error, reconnectCount };
}

// Back-compat alias — existing imports keep working.
export const useFirestoreCollection = useRealtimeCollection;

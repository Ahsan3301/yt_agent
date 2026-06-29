"use client";

import { useEffect, useRef, useState } from "react";
import {
  collection, onSnapshot, query, type Query, type CollectionReference,
  type Firestore, type FirestoreError, type QuerySnapshot,
} from "firebase/firestore";

import { getDb, isFirestoreConfigured } from "@/lib/firestore";

/**
 * Resilient onSnapshot wrapper.
 *
 * Why: bare onSnapshot subscriptions can silently drop after tunnel
 * switches, browser sleep, or extended network blips. The dashboard
 * used to manifest this as "Monitor card disappears after laptop
 * resumes from sleep" — no errors logged, no events delivered, until
 * the user reloads.
 *
 * This hook wraps the subscription in two layers of defense:
 *
 *   1. Error callback re-subscribes after a short backoff. Picks up
 *      transient Firebase errors that would otherwise terminate the
 *      stream.
 *
 *   2. Silence watchdog — if no snapshot event arrives for SILENCE_MS
 *      (default 2 min), assume the subscription is hung and tear
 *      down + re-subscribe. The Firestore SDK's heartbeat is supposed
 *      to keep us informed, but in practice we've seen long-silent
 *      sockets that never recover on their own.
 *
 * Returns {snapshot, error, reconnectCount} so the caller can render
 * a "reconnecting…" indicator if it likes.
 *
 * Usage:
 *   const { snapshot } = useFirestoreCollection("backends");
 *   snapshot?.forEach(doc => ...)
 */
const SILENCE_MS = 2 * 60 * 1000;
const RETRY_BACKOFF_MS = 3000;

export function useFirestoreCollection(
  pathOrQuery: string | ((db: Firestore) => Query | CollectionReference),
) {
  const [snapshot, setSnapshot] = useState<QuerySnapshot | null>(null);
  const [error, setError] = useState<FirestoreError | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  const lastEventAt = useRef<number>(Date.now());

  useEffect(() => {
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
              setSnapshot(snap);
              setError(null);
            }
          },
          (err) => {
            if (cancelled) return;
            console.warn("useFirestoreCollection: subscription error, reconnecting", err);
            setError(err);
            if (unsub) {
              try { unsub(); } catch { /* noop */ }
              unsub = null;
            }
            // Backoff + reconnect.
            backoffTimer = setTimeout(() => {
              setReconnectCount((n) => n + 1);
              subscribe();
            }, RETRY_BACKOFF_MS);
          },
        );
      } catch (e) {
        console.warn("useFirestoreCollection: subscribe threw", e);
        if (!cancelled) {
          backoffTimer = setTimeout(() => {
            setReconnectCount((n) => n + 1);
            subscribe();
          }, RETRY_BACKOFF_MS);
        }
      }
    };

    // Initial subscribe.
    lastEventAt.current = Date.now();
    subscribe();

    // Silence watchdog — re-subscribe if we go quiet for too long.
    watchdog = setInterval(() => {
      if (cancelled) return;
      if (Date.now() - lastEventAt.current > SILENCE_MS) {
        console.warn(
          `useFirestoreCollection: silent for >${SILENCE_MS}ms, forcing resubscribe`,
        );
        if (unsub) {
          try { unsub(); } catch { /* noop */ }
          unsub = null;
        }
        lastEventAt.current = Date.now(); // reset so we don't immediately retry
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
    // The query function should be stable across renders, but if it
    // changes (e.g. caller passes a fresh closure each time) we'll
    // tear down and re-subscribe — that's correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeof pathOrQuery === "string" ? pathOrQuery : pathOrQuery]);

  return { snapshot, error, reconnectCount };
}

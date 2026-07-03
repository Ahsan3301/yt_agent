/**
 * Timestamp normalization for cross-backend data shapes.
 *
 * Firestore Admin SDK returns Timestamp objects (`.toMillis()`,
 * `.toDate()`, `.seconds`, `.nanoseconds`). Pocketbase returns plain
 * numbers (epoch seconds since our wrapper writes via time.time() in
 * Python) OR ISO date strings (when the PB collection field type is
 * `date` — system `created`/`updated` fields work that way).
 *
 * The whole codebase calls `.toMillis()` on these values — which
 * crashes ("…toMillis is not a function") for every PB-shape value.
 * Use these helpers everywhere instead.
 */

/** Best-effort: convert any timestamp shape to epoch ms. */
export function toEpochMs(v: unknown): number | null {
  if (v == null) return null;

  if (typeof v === "number") {
    if (!isFinite(v) || v <= 0) return null;
    // Heuristic: numbers below 10^11 are seconds, above are ms.
    // (10^11 ms = year 5138; 10^11 sec = year 5138 too — same boundary.)
    return v > 1e11 ? v : v * 1000;
  }

  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    // Pure-digit string → epoch seconds or ms
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return toEpochMs(parseFloat(trimmed));
    }
    // ISO 8601 / date string
    const parsed = Date.parse(trimmed);
    return isNaN(parsed) ? null : parsed;
  }

  // Firestore Timestamp object
  const ts = v as { toMillis?: () => number; seconds?: number };
  if (typeof ts.toMillis === "function") {
    try { return ts.toMillis(); } catch { return null; }
  }
  if (typeof ts.seconds === "number") {
    return ts.seconds * 1000;
  }

  return null;
}


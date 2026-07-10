/**
 * Boot-grace windows for per-channel worker priority handover.
 * MUST stay in sync with the same table in web/app/api/jobs/claim/route.ts.
 *
 * Interpretation for a job with allowed_workers=[A, B, C]:
 *   - A can claim from t=0
 *   - B can claim from t = BOOT_GRACE_SEC[A]
 *   - C can claim from t = BOOT_GRACE_SEC[A] + BOOT_GRACE_SEC[B]
 * At any moment, the highest-priority worker whose window has opened
 * AND that is currently heartbeating wins the claim.
 */
export const BOOT_GRACE_SEC: Record<string, number> = {
  kaggle: 8 * 60,
  colab:  15 * 60,
  oracle: 0,
};

/** Which worker's window is currently open, given the job age and priority. */
export function currentPrimary(allowedWorkers: string[], jobAgeSec: number): {
  primary: string;
  index: number;
  secondsUntilNextHandover: number | null;   // null when we're on the last worker
  nextWorker: string | null;
} {
  if (!allowedWorkers.length) {
    return { primary: "kaggle", index: 0, secondsUntilNextHandover: null, nextWorker: null };
  }
  let cum = 0;
  for (let i = 0; i < allowedWorkers.length; i++) {
    const grace = BOOT_GRACE_SEC[allowedWorkers[i]] ?? 0;
    const nextCum = cum + grace;
    // The i-th worker owns from `cum` to `nextCum` (inclusive lower).
    // For i=0, cum=0 → owns from t=0 up to BOOT_GRACE_SEC[allowedWorkers[0]].
    if (i === allowedWorkers.length - 1 || jobAgeSec < nextCum) {
      return {
        primary: allowedWorkers[i],
        index: i,
        secondsUntilNextHandover: i === allowedWorkers.length - 1 ? null : Math.max(0, nextCum - jobAgeSec),
        nextWorker: i === allowedWorkers.length - 1 ? null : allowedWorkers[i + 1],
      };
    }
    cum = nextCum;
  }
  // Unreachable — the loop always returns.
  return { primary: allowedWorkers[allowedWorkers.length - 1], index: allowedWorkers.length - 1, secondsUntilNextHandover: null, nextWorker: null };
}

export function fmtGraceRemaining(sec: number | null): string {
  if (sec == null) return "";
  if (sec <= 0) return "handover due";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

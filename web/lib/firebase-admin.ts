/**
 * Server-side Firebase Admin SDK wrapper.
 *
 * Reads FIREBASE_SERVICE_ACCOUNT_JSON (server-only env var — DO NOT
 * expose with NEXT_PUBLIC_) and instantiates the Admin SDK once. The
 * Admin SDK bypasses Firestore security rules, so the Vercel API
 * routes can read/write any collection (jobs, settings, keys, etc.)
 * even though the client-side rules block writes from anonymous
 * browsers.
 *
 * Lazy-singleton pattern — initialize on first call so the import
 * doesn't fail at build time when the env var isn't set (dev mode,
 * preview builds without secrets, etc.).
 */
import { cert, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore, FieldValue } from "firebase-admin/firestore";

let _app: App | null = null;
let _db: Firestore | null = null;

function _parseServiceAccount(): Record<string, unknown> | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Heal escaped newlines in private_key — happens when the JSON
    // gets re-serialised by some UI before storage.
    if (
      parsed &&
      typeof parsed.private_key === "string" &&
      parsed.private_key.includes("\\n") &&
      !parsed.private_key.includes("\n")
    ) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch (e) {
    console.error("FIREBASE_SERVICE_ACCOUNT_JSON parse failed:", e);
    return null;
  }
}

export function isAdminConfigured(): boolean {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
}

export function adminDb(): Firestore {
  if (_db) return _db;
  const sa = _parseServiceAccount();
  if (!sa) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON not set — Vercel API routes cannot reach Firestore",
    );
  }
  _app =
    getApps().length === 0
      ? initializeApp({
          credential: cert(sa as Parameters<typeof cert>[0]),
          projectId: String(sa.project_id || ""),
        })
      : getApp();
  _db = getFirestore(_app);
  return _db;
}

export { FieldValue };

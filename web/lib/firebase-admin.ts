/**
 * Server-side database client — Firestore Admin SDK OR Pocketbase,
 * chosen by the DB_BACKEND env var.
 *
 *   DB_BACKEND=firestore (default) → behaves exactly as before.
 *   DB_BACKEND=pocketbase            → routes the SAME call shape
 *                                       (db.collection(...).doc(...).set(...))
 *                                       through web/lib/pocketbase-admin.ts.
 *
 * Route code does NOT change between backends — both adapters expose
 * the same shape and FieldValue surface.
 *
 * Reads FIREBASE_SERVICE_ACCOUNT_JSON (server-only env var — DO NOT
 * expose with NEXT_PUBLIC_) for the Firestore path. The Pocketbase
 * path reads PB_URL_INTERNAL / NEXT_PUBLIC_PB_URL + PB_SERVER_TOKEN.
 *
 * Lazy-singleton — initialise on first call so the import doesn't fail
 * at build time when neither backend's env vars are set yet.
 */
import {
  cert, getApp, getApps, initializeApp, type App,
} from "firebase-admin/app";
import {
  getFirestore, type Firestore, FieldValue as _FsFieldValue,
} from "firebase-admin/firestore";

import {
  pbAdminDb,
  isPocketbaseConfigured,
  PBFieldValue,
} from "./pocketbase-admin";

const BACKEND = (process.env.DB_BACKEND || "firestore").toLowerCase().trim();

let _app: App | null = null;
let _fsDb: Firestore | null = null;

function _parseServiceAccount(): Record<string, unknown> | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Heal escaped newlines in private_key.
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
  if (BACKEND === "pocketbase") return isPocketbaseConfigured();
  return !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
}

/**
 * Return the active DB client. Shape is identical regardless of
 * backend at RUNTIME (see pocketbase-admin.ts for the parity surface).
 *
 * We TYPE the return as Firestore so route code (32 files) doesn't
 * need any `if backend === "pocketbase"` branches — at runtime the
 * Pocketbase adapter answers the same `.collection(name).doc(id).set(...)`
 * calls the Firestore SDK does. The cast is safe because every Firestore
 * method our routes actually call is also implemented by pbAdminDb().
 *
 * Routes that need FieldValue / batch should import via `FieldValue`
 * from this module — also re-exported, backend-aware.
 */
export function adminDb(): Firestore {
  if (BACKEND === "pocketbase") {
    // Structural-type cast — the PB client matches Firestore's surface
    // for the operations we use.
    return pbAdminDb() as unknown as Firestore;
  }

  if (_fsDb) return _fsDb;
  const sa = _parseServiceAccount();
  if (!sa) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON not set — Vercel API routes cannot reach Firestore. " +
      "(If you intended to use Pocketbase, set DB_BACKEND=pocketbase + PB_URL + PB_SERVER_TOKEN.)",
    );
  }
  _app =
    getApps().length === 0
      ? initializeApp({
          credential: cert(sa as Parameters<typeof cert>[0]),
          projectId: String(sa.project_id || ""),
        })
      : getApp();
  _fsDb = getFirestore(_app);
  return _fsDb;
}

/**
 * Backend-aware FieldValue. Use this in route code instead of
 * importing FieldValue from firebase-admin directly so the same calls
 * work on both backends.
 *
 *   import { FieldValue } from "@/lib/firebase-admin";
 *   await db.doc(...).set({ updated_at: FieldValue.serverTimestamp() });
 */
export const FieldValue = BACKEND === "pocketbase" ? PBFieldValue : _FsFieldValue;

"use client";

/**
 * Lazy Firebase / Firestore client for the dashboard.
 *
 * Config comes from one env var — NEXT_PUBLIC_FIREBASE_CONFIG — that's
 * the entire `firebaseConfig` JSON from the Firebase web app setup page
 * (apiKey, authDomain, projectId, etc.). Keeping it as one var avoids
 * the "did you set seven things separately?" failure mode.
 *
 * Returns `null` when the config is missing so callers can gracefully
 * fall back to the legacy registry-file path. No top-level error.
 */
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;
let _init_attempted = false;

function _parseConfig(): Record<string, string> | null {
  const raw = process.env.NEXT_PUBLIC_FIREBASE_CONFIG;
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw);
    // Minimum viable check — Firestore needs projectId + apiKey.
    if (!cfg || typeof cfg !== "object" || !cfg.projectId || !cfg.apiKey) {
      return null;
    }
    return cfg;
  } catch {
    return null;
  }
}

export function isFirestoreConfigured(): boolean {
  return _parseConfig() !== null;
}

export function getDb(): Firestore | null {
  if (_db) return _db;
  if (_init_attempted && !_app) return null;
  _init_attempted = true;
  const cfg = _parseConfig();
  if (!cfg) return null;
  try {
    _app = getApps().length === 0 ? initializeApp(cfg) : getApp();
    _db = getFirestore(_app);
    return _db;
  } catch (e) {
    console.warn("firestore init failed:", e);
    return null;
  }
}

"use client";

/**
 * Manual backend registry, persisted in localStorage.
 *
 * Polls each saved backend's /api/queue directly — no R2 / Hostinger
 * registry needed for discovery. Robust against:
 *   - R2 going down or hitting rate limits
 *   - Stale CDN-cached registry.json
 *   - CORS misconfigurations on the registry host
 *
 * The user pastes a backend URL (e.g. the trycloudflare.com URL from
 * Colab cell 6, or the stable hf.space URL) and it stays in the list
 * until removed. The Monitor page renders one card per saved entry
 * just like it does for auto-discovered registry entries.
 */
const STORAGE_KEY = "yt-agent-backends-v1";

export type ManualBackend = {
  url: string;
  label?: string;
  added_at: number;
};

function _readStore(): ManualBackend[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function _writeStore(list: ManualBackend[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function getManualBackends(): ManualBackend[] {
  return _readStore();
}

export function addManualBackend(url: string, label?: string): ManualBackend[] {
  let clean = url.trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(clean)) clean = "https://" + clean;
  const list = _readStore().filter((b) => b.url !== clean);
  list.push({ url: clean, label: label?.trim() || undefined, added_at: Date.now() });
  _writeStore(list);
  return list;
}

export function removeManualBackend(url: string): ManualBackend[] {
  const list = _readStore().filter((b) => b.url !== url);
  _writeStore(list);
  return list;
}

export function clearManualBackends(): void {
  _writeStore([]);
}

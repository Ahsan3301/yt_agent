/**
 * Single source of truth for channel presets on the frontend.
 *
 * Mirrors modules/channels.CHANNEL_PRESETS (Python). When you add a
 * channel, edit BOTH this file and modules/channels.py — they must
 * stay in lock-step or the dashboard will offer channels the backend
 * doesn't recognise (or vice versa).
 *
 * Why not fetch from the backend? The dashboard renders before any
 * worker is alive (LaunchBanner shows the "no backend" state) so we
 * can't depend on Vercel routes that proxy to a worker. Cheap to keep
 * in sync — only ~10 entries.
 *
 * Custom user-defined channels are layered on top via local storage —
 * see addCustomChannel() / listAllChannels().
 */

export type ChannelPreset = {
  name: string;            // slug
  label: string;           // human-facing
  webDefault: boolean;     // NIM browser research default ON?
  isCustom?: boolean;      // user-defined, not in modules/channels.py
  description?: string;    // free-text description, for custom ones
};

export const PRESET_CHANNELS: ChannelPreset[] = [
  { name: "horror",   label: "Horror stories",         webDefault: false },
  { name: "wisdom",   label: "Wisdom + motivation",    webDefault: false },
  { name: "finance",  label: "Finance + business",     webDefault: true  },
  { name: "fitness",  label: "Fitness + discipline",   webDefault: true  },
  { name: "science",  label: "Science + tech",         webDefault: true  },
  { name: "history",  label: "History + mythology",    webDefault: true  },
  { name: "comedy",   label: "Comedy + observational", webDefault: false },
  { name: "food",     label: "Food + cooking",         webDefault: false },
  { name: "travel",   label: "Travel + culture",       webDefault: false },
  { name: "gaming",   label: "Gaming + lore",          webDefault: false },
];

const _STORAGE_KEY = "yt_agent_custom_channels_v1";

/** Read user-defined custom channels from localStorage. SSR-safe. */
export function loadCustomChannels(): ChannelPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChannelPreset[];
    return Array.isArray(parsed) ? parsed.filter((c) => c?.name) : [];
  } catch {
    return [];
  }
}

/** Persist a new custom channel so it appears on every channel picker. */
export function addCustomChannel(c: { name: string; description?: string }): void {
  if (typeof window === "undefined") return;
  const norm = _normaliseName(c.name);
  if (!norm) return;
  const list = loadCustomChannels();
  // Replace if same name; preserve insertion order otherwise.
  const filtered = list.filter((x) => _normaliseName(x.name) !== norm);
  filtered.push({
    name: norm,
    label: c.name.trim() || norm,
    webDefault: true,
    isCustom: true,
    description: c.description?.trim() || "",
  });
  try {
    window.localStorage.setItem(_STORAGE_KEY, JSON.stringify(filtered.slice(-30)));
  } catch {
    /* localStorage may be disabled (Safari private mode); soft fail */
  }
}

/** Remove a user-defined custom channel (presets can't be removed). */
export function removeCustomChannel(name: string): void {
  if (typeof window === "undefined") return;
  const norm = _normaliseName(name);
  const list = loadCustomChannels().filter((x) => _normaliseName(x.name) !== norm);
  try {
    window.localStorage.setItem(_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* soft fail */
  }
}

/** Built-in presets + saved custom channels. Used by every picker UI. */
export function listAllChannels(): ChannelPreset[] {
  return [...PRESET_CHANNELS, ...loadCustomChannels()];
}

/** Look up a channel by name. Falls back to a synthetic record for
 *  unknown ones so callers can still render something. */
export function getChannel(name: string): ChannelPreset {
  const norm = _normaliseName(name);
  const found = listAllChannels().find((c) => c.name === norm);
  return (
    found || {
      name: norm,
      label: name || norm,
      webDefault: true,
      isCustom: true,
    }
  );
}

/** Default value for the web-research toggle, given a channel name. */
export function webResearchDefault(name: string): boolean {
  return getChannel(name).webDefault;
}

/** lowercase, alphanum + underscore. Matches modules/channels._normalise. */
function _normaliseName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

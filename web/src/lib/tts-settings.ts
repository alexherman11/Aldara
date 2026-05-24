/**
 * TTS preference plumbing for the web app. The actual catalog of providers
 * and voices is fetched from the backend on demand (/api/debug/config) — the
 * server owns the source of truth (src/tts-catalog.ts) so we don't have to
 * keep two lists in sync.
 *
 * Persisted to localStorage under TTS_PREF_STORAGE_KEY. Reads are sync and
 * never throw (the picker is a settings UI, not a critical path — if storage
 * is denied we just fall back to the server's default).
 */

import { getDebugConfig } from './api';

export interface TtsVoice {
  id: string;
  label: string;
}

export type TtsCatalog = Record<string, ReadonlyArray<TtsVoice>>;

export interface TtsPreference {
  provider: string;
  voice: string;
}

const STORAGE_KEY = 'habla_tts_preference';

let cachedCatalog: TtsCatalog | null = null;
let inflight: Promise<TtsCatalog> | null = null;

/**
 * Read the saved TTS preference from localStorage. Returns null when nothing
 * has been saved — the caller should fall back to the catalog's first entry.
 *
 * We intentionally don't validate the saved pair against the catalog here
 * (the catalog may not yet be loaded). The picker validates on render; the
 * backend validates on dispatch (and 400s if the pair is bogus).
 */
export function getTtsPreference(): TtsPreference | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.provider === 'string' &&
      typeof parsed.voice === 'string'
    ) {
      return { provider: parsed.provider, voice: parsed.voice };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the picker selection. Silently ignored when storage is denied. */
export function setTtsPreference(pref: TtsPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    /* ignore */
  }
}

/** Clear the saved preference (sign-out + tests). */
export function clearTtsPreference(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Fetch the TTS catalog from /api/debug/config and memoize it for the
 * lifetime of the tab. Concurrent calls share the same in-flight fetch so
 * we never fan out duplicate requests when, say, the drawer and Session
 * page both mount at once.
 */
export async function fetchTtsCatalog(): Promise<TtsCatalog> {
  if (cachedCatalog) return cachedCatalog;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const cfg = await getDebugConfig();
      // The catalog lives under cfg.tts.catalog (added in the matching backend
      // change). Older servers won't have it — fall back to an empty object so
      // the picker can still render a "couldn't load" state without crashing.
      const cat = (cfg as unknown as { tts?: { catalog?: TtsCatalog } })?.tts
        ?.catalog;
      cachedCatalog = cat ?? {};
      return cachedCatalog;
    } catch {
      cachedCatalog = {};
      return cachedCatalog;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Synchronous accessor — returns the cached catalog or null if not yet loaded. */
export function getCachedTtsCatalog(): TtsCatalog | null {
  return cachedCatalog;
}

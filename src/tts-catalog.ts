/**
 * Canonical list of TTS providers and the voices we expose to the web app's
 * voice picker. Single source of truth shared by:
 *   - the agent's createTts() factory (validates voice ids per provider)
 *   - the token-server (validates the ttsProvider/ttsVoice query params and
 *     returns the catalog on /api/debug/config)
 *   - the React Settings drawer (renders the paired provider/voice dropdowns
 *     after fetching it from /api/debug/config)
 *
 * Voice ids are the values that get stamped into LiveKit dispatch metadata
 * and ultimately handed to each plugin. Don't ship a voice in this catalog
 * unless the agent's TTS factory actually accepts it.
 */

export interface TtsVoice {
  /** Provider-specific voice id passed to the plugin. */
  id: string;
  /** Human-readable label shown in the picker. */
  label: string;
}

export const TTS_CATALOG = {
  cartesia: [
    // Default Sofía voice — warm bilingual ES-MX speaker on Cartesia sonic-3.
    // Matches CARTESIA_VOICE_ID in agent.ts; keep them in sync.
    {
      id: '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c',
      label: 'Sofía — Sonic 3 (default)',
    },
  ],
  openai: [
    { id: 'alloy', label: 'Alloy' },
    { id: 'nova', label: 'Nova' },
    { id: 'shimmer', label: 'Shimmer' },
    { id: 'echo', label: 'Echo' },
  ],
  // Google voices come from @livekit/agents-plugin-google's Gemini TTS
  // (the only Google TTS surface the LiveKit plugin exposes in 1.2.6 —
  // Cloud TTS / Chirp 3 HD requires a separate SDK, not shipped here).
  // The voice *names* below match the Chirp 3 HD identifier suffixes the
  // user requested (Achernar, Aoede) and the existing GEMINI_TTS_VOICE
  // default (Aoede). If/when the plugin exposes Cloud TTS, swap these
  // ids for the full es-US-Chirp3-HD-* form.
  // TODO: once @livekit/agents-plugin-google exposes Cloud TTS (Chirp 3 HD),
  // replace these ids with `es-US-Chirp3-HD-Achernar` / `es-US-Chirp3-HD-Aoede`
  // and add `es-US-Studio-B` as a Studio fallback. For now we drive Gemini TTS.
  google: [
    { id: 'Achernar', label: 'Achernar (Gemini, ES-friendly)' },
    { id: 'Aoede', label: 'Aoede (Gemini, ES-friendly)' },
    { id: 'Leda', label: 'Leda (Gemini)' },
    { id: 'Kore', label: 'Kore (Gemini)' },
  ],
  // Google Cloud TTS — Chirp 3 HD voices. The @livekit/agents-plugin-google
  // package doesn't expose Cloud TTS in 1.2.6, so the agent ships its own
  // ChirpTTS adapter (src/chirp-tts.ts) that calls texttospeech.googleapis.com
  // directly with the same GOOGLE_API_KEY used for Gemini. Voice ids are the
  // exact Cloud TTS voice names — keep them in sync with what Google publishes
  // at https://cloud.google.com/text-to-speech/docs/list-voices-and-types.
  chirp: [
    {
      id: 'es-US-Chirp3-HD-Aoede',
      label: 'Aoede (Chirp 3 HD, ES-US)',
    },
    {
      id: 'es-US-Chirp3-HD-Achernar',
      label: 'Achernar (Chirp 3 HD, ES-US)',
    },
    {
      id: 'es-US-Chirp3-HD-Charon',
      label: 'Charon (Chirp 3 HD, ES-US, deeper voice)',
    },
    {
      id: 'es-US-Chirp3-HD-Kore',
      label: 'Kore (Chirp 3 HD, ES-US)',
    },
  ],
} as const satisfies Record<string, ReadonlyArray<TtsVoice>>;

export type TtsProvider = keyof typeof TTS_CATALOG;

export const TTS_PROVIDERS: TtsProvider[] = Object.keys(TTS_CATALOG) as TtsProvider[];

/**
 * Validate a provider/voice pair against the catalog. Returns the canonical
 * pair (lowercased provider, exact-cased voice) or null when either side is
 * unknown. Caller decides whether to fall back or 400.
 */
export function resolveCatalogEntry(
  provider: string | undefined,
  voice: string | undefined,
): { provider: TtsProvider; voice: string } | null {
  if (!provider) return null;
  const p = provider.toLowerCase();
  if (!(p in TTS_CATALOG)) return null;
  const voices = TTS_CATALOG[p as TtsProvider];
  // No voice supplied → first voice for that provider is the default.
  if (!voice) {
    return { provider: p as TtsProvider, voice: voices[0]!.id };
  }
  const hit = voices.find((v) => v.id === voice);
  if (!hit) return null;
  return { provider: p as TtsProvider, voice: hit.id };
}

/** Default voice id for a provider (first voice in its catalog list). */
export function defaultVoiceFor(provider: TtsProvider): string {
  return TTS_CATALOG[provider][0]!.id;
}

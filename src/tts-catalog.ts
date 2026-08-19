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
  /**
   * Languages the voice handles well, expressed as a short human-readable
   * string for the UI (e.g. "Spanish + English (accented)"). The picker
   * renders it as a separate column so learners can pick a voice that
   * actually fits a Spanish-first, code-switching tutor.
   */
  languages: string;
}

export const TTS_CATALOG = {
  cartesia: [
    // Default Sofía voice — warm bilingual ES-MX speaker on Cartesia sonic-3.
    // The agent passes language: 'es' so this voice is locked to Spanish in
    // practice; ES-only here is accurate, not an under-claim.
    {
      id: '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c',
      label: 'Sofía — Sonic 3 (default)',
      languages: 'Spanish (ES-MX, native)',
    },
  ],
  // OpenAI gpt-4o-mini-tts voices are strongly English-first but speak
  // Spanish with a recognizable English accent. Useful when the learner
  // wants accented English / mixed-language practice rather than native ES.
  openai: [
    { id: 'alloy', label: 'Alloy', languages: 'English (native), Spanish (accented)' },
    { id: 'nova', label: 'Nova', languages: 'English (native), Spanish (accented)' },
    { id: 'shimmer', label: 'Shimmer', languages: 'English (native), Spanish (accented)' },
    { id: 'echo', label: 'Echo', languages: 'English (native), Spanish (accented)' },
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
    { id: 'Achernar', label: 'Achernar (Gemini)', languages: 'Spanish + English' },
    { id: 'Aoede', label: 'Aoede (Gemini)', languages: 'Spanish + English' },
    { id: 'Leda', label: 'Leda (Gemini)', languages: 'English (native), Spanish (accented)' },
    { id: 'Kore', label: 'Kore (Gemini)', languages: 'English (native), Spanish (accented)' },
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
      label: 'Aoede (Chirp 3 HD)',
      languages: 'Spanish (ES-US, native)',
    },
    {
      id: 'es-US-Chirp3-HD-Achernar',
      label: 'Achernar (Chirp 3 HD)',
      languages: 'Spanish (ES-US, native)',
    },
    {
      id: 'es-US-Chirp3-HD-Charon',
      label: 'Charon (Chirp 3 HD, deeper voice)',
      languages: 'Spanish (ES-US, native)',
    },
    {
      id: 'es-US-Chirp3-HD-Kore',
      label: 'Kore (Chirp 3 HD)',
      languages: 'Spanish (ES-US, native)',
    },
  ],
  // Inworld Realtime TTS-2 — multilingual model with a single voice identity
  // preserved across every language, including mid-utterance switches. Both
  // Spanish and English are in Inworld's top "production" tier, so every
  // voice here handles ES + EN natively. Voice names match Inworld's
  // published TTS-2 catalog; INWORLD_VOICE in .env defaults to Ashley.
  inworld: [
    { id: 'Ashley', label: 'Ashley (warm female)', languages: 'Spanish + English (native both)' },
    { id: 'Olivia', label: 'Olivia (female)', languages: 'Spanish + English (native both)' },
    { id: 'Mark', label: 'Mark (male)', languages: 'Spanish + English (native both)' },
    { id: 'Edward', label: 'Edward (male)', languages: 'Spanish + English (native both)' },
    { id: 'Sarah', label: 'Sarah (curious young female)', languages: 'Spanish + English (native both)' },
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

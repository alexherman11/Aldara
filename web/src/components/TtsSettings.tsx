import React, { useEffect, useState } from 'react';
import {
  fetchTtsCatalog,
  getCachedTtsCatalog,
  getTtsPreference,
  setTtsPreference,
  type TtsCatalog,
} from '@/lib/tts-settings';

/**
 * Paired provider + voice picker for the TTS engine that renders Sofía.
 *
 * Mount inside the Settings drawer. The user picks a provider; the voice
 * dropdown filters to that provider's catalog. Changes are saved to
 * localStorage immediately — they don't take effect mid-session because TTS
 * is bound at AgentSession start, so we surface a small "Applies on next
 * session" hint to set expectations.
 *
 * The catalog itself is fetched from /api/debug/config so we don't keep two
 * copies in sync. While the fetch is in-flight we render a placeholder so
 * the UI doesn't flash an empty <select>.
 */
export function TtsSettings() {
  const [catalog, setCatalog] = useState<TtsCatalog | null>(() =>
    getCachedTtsCatalog(),
  );
  const initialPref = getTtsPreference();
  const [provider, setProvider] = useState<string>(initialPref?.provider ?? '');
  const [voice, setVoice] = useState<string>(initialPref?.voice ?? '');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Fetch the catalog on mount and seed sane defaults if no preference exists
  // yet. We don't validate the saved preference against the freshly-loaded
  // catalog here — the backend will 400 on dispatch if the pair is invalid,
  // which is the more reliable enforcement point.
  useEffect(() => {
    let cancelled = false;
    void fetchTtsCatalog().then((cat) => {
      if (cancelled) return;
      setCatalog(cat);
      const providers = Object.keys(cat);
      if (providers.length === 0) return;
      // First-time render: drop the user into the first provider/voice combo
      // so the dropdowns aren't empty even before they touch them.
      if (!provider || !providers.includes(provider)) {
        const fallbackProvider = providers[0]!;
        const fallbackVoice = cat[fallbackProvider]?.[0]?.id ?? '';
        setProvider(fallbackProvider);
        setVoice(fallbackVoice);
      } else if (!voice || !cat[provider]?.some((v) => v.id === voice)) {
        // Provider valid but voice id isn't in the catalog any more — pick the
        // first available voice for that provider.
        setVoice(cat[provider]?.[0]?.id ?? '');
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providers = catalog ? Object.keys(catalog) : [];
  const voices = catalog && provider ? (catalog[provider] ?? []) : [];
  const selectedVoice = voices.find((v) => v.id === voice);

  const handleProviderChange = (next: string) => {
    setProvider(next);
    // When switching provider, default to that provider's first voice so the
    // voice dropdown can't briefly hold a stale id from the previous provider.
    const firstVoice = catalog?.[next]?.[0]?.id ?? '';
    setVoice(firstVoice);
    setTtsPreference({ provider: next, voice: firstVoice });
    setSavedAt(Date.now());
  };

  const handleVoiceChange = (next: string) => {
    setVoice(next);
    setTtsPreference({ provider, voice: next });
    setSavedAt(Date.now());
  };

  if (!catalog) {
    return (
      <div className="bg-card border border-border rounded-2xl p-3 text-xs text-muted-foreground">
        Loading voices…
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <div className="bg-card border border-border rounded-2xl p-3 text-xs text-muted-foreground">
        No TTS catalog from the backend. Is the server running an old build?
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-2xl p-3 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Provider
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full h-9 rounded-lg border border-border bg-background px-2 text-xs font-mono text-foreground"
          data-testid="select-tts-provider"
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Voice
        <select
          value={voice}
          onChange={(e) => handleVoiceChange(e.target.value)}
          disabled={voices.length === 0}
          className="w-full h-9 rounded-lg border border-border bg-background px-2 text-xs font-mono text-foreground disabled:opacity-50"
          data-testid="select-tts-voice"
        >
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.languages ? `${v.label} · ${v.languages}` : v.label}
            </option>
          ))}
        </select>
      </label>

      {selectedVoice?.languages ? (
        <p
          className="text-[11px] text-foreground/80"
          data-testid="tts-voice-languages"
        >
          Languages: {selectedVoice.languages}
        </p>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        {savedAt !== null
          ? 'Saved. Applies on next session.'
          : 'Applies on next session — start a new conversation to hear it.'}
      </p>
    </div>
  );
}

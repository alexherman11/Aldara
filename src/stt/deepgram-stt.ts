import type {
  Transcriber,
  TranscriptionRequest,
  TranscriptionResult,
  TranscribedWord,
} from './types.js';

/**
 * Deepgram nova-3 transcription via the REST API.
 *
 * Why Deepgram for the offline pipeline: empirically (live session 2026-05-12)
 * Deepgram's `language: 'multi'` mode correctly transcribed mixed Spanish +
 * English audio without translating between them — it kept "but I'm trying
 * to learn how to use those words" as English while transcribing surrounding
 * Spanish accurately. Whisper-1 in the same scenario back-translates the
 * English portion to Spanish, defeating the whole code-switching architecture.
 *
 * Deepgram also returns per-word timestamps + per-word confidence in the same
 * call, which is what the segmenter needs.
 */
export class DeepgramSTT implements Transcriber {
  readonly name = 'deepgram-nova-3';

  private readonly apiKey: string;

  constructor(opts?: { apiKey?: string }) {
    const key = opts?.apiKey ?? process.env.DEEPGRAM_API_KEY;
    if (!key) {
      throw new Error('DeepgramSTT: DEEPGRAM_API_KEY must be set');
    }
    this.apiKey = key;
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const startedAt = Date.now();

    const params = new URLSearchParams({
      model: 'nova-3',
      // 'multi' = code-switching mode. Documented as supporting Spanish + English.
      language: req.language_hint ?? 'multi',
      punctuate: 'true',
      smart_format: 'true',
      // Need per-word timestamps for the segmenter
      utterances: 'false',
    });

    const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: req.audio as unknown as BodyInit,
    });

    if (!resp.ok) {
      throw new Error(`Deepgram HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }

    const json = (await resp.json()) as DeepgramResponse;
    const latency_ms = Date.now() - startedAt;

    const alt = json.results?.channels?.[0]?.alternatives?.[0];
    if (!alt) {
      return {
        text: '',
        words: [],
        dominant_language: 'unknown',
        duration_sec: json.metadata?.duration ?? 0,
        provider: this.name,
        latency_ms,
      };
    }

    const words: TranscribedWord[] = (alt.words ?? []).map((w) => ({
      word: w.punctuated_word ?? w.word,
      start_sec: w.start,
      end_sec: w.end,
      confidence: w.confidence,
      // Deepgram nova-3 multi-mode tags some words with a `language` field on
      // the word itself when code-switching is detected. Use it when present.
      language:
        w.language === 'es' || w.language?.startsWith('es')
          ? 'es'
          : w.language === 'en' || w.language?.startsWith('en')
            ? 'en'
            : undefined,
    }));

    return {
      text: alt.transcript ?? '',
      words,
      dominant_language: json.results?.channels?.[0]?.detected_language ?? 'unknown',
      duration_sec: json.metadata?.duration ?? 0,
      provider: this.name,
      latency_ms,
    };
  }
}

interface DeepgramResponse {
  metadata?: {
    duration?: number;
  };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        words?: Array<{
          word: string;
          punctuated_word?: string;
          start: number;
          end: number;
          confidence: number;
          language?: string;
        }>;
      }>;
    }>;
  };
}

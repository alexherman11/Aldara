import type {
  Transcriber,
  TranscriptionRequest,
  TranscriptionResult,
  TranscribedWord,
} from './types.js';

/**
 * OpenAI Whisper-1 transcription with word-level timestamps.
 *
 * Why whisper-1 over gpt-4o-transcribe: the gpt-4o-transcribe family is
 * better at clean text accuracy but does NOT return timestamps. The segmenter
 * needs per-word timestamps to slice audio for per-phrase Azure scoring, so
 * whisper-1 is the only OpenAI option that fits the architecture.
 *
 * If gpt-4o-transcribe ever ships timestamps, swap the model name here —
 * everything downstream is timestamp-shape-agnostic.
 *
 * Cost: ~$0.006/min as of early 2026.
 */
export class OpenAIWhisperSTT implements Transcriber {
  readonly name = 'whisper-1';

  private readonly apiKey: string;

  constructor(opts?: { apiKey?: string }) {
    const key = opts?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OpenAIWhisperSTT: OPENAI_API_KEY must be set');
    }
    this.apiKey = key;
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const startedAt = Date.now();

    // OpenAI accepts WAV directly. Wrap the buffer as a Blob for multipart form.
    const form = new FormData();
    const audioBlob = new Blob([new Uint8Array(req.audio)], { type: 'audio/wav' });
    form.append('file', audioBlob, 'turn.wav');
    form.append('model', this.name);
    form.append('response_format', 'verbose_json');
    // Both word + segment granularities — words drive the segmenter, segments
    // are useful for sanity-checking phrase boundaries.
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    if (req.language_hint) {
      form.append('language', req.language_hint);
    }

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      throw new Error(`Whisper HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }

    const json = (await resp.json()) as WhisperVerboseResponse;
    const latency_ms = Date.now() - startedAt;

    const words: TranscribedWord[] = (json.words ?? []).map((w) => ({
      word: w.word,
      start_sec: w.start,
      end_sec: w.end,
      // Whisper doesn't expose per-word confidence in this response — leave undefined.
      // Per-word language gets filled in by the segmenter's lexicon classifier.
    }));

    return {
      text: json.text,
      words,
      dominant_language: json.language || 'unknown',
      duration_sec: json.duration ?? words[words.length - 1]?.end_sec ?? 0,
      provider: this.name,
      latency_ms,
    };
  }
}

interface WhisperVerboseResponse {
  task?: string;
  language?: string;
  duration?: number;
  text: string;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
}

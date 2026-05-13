/**
 * Speech-to-text types — vendor-agnostic.
 *
 * The pronunciation pipeline needs per-word timestamps and confidence (or at
 * minimum, language tags) so the segmenter can split a multilingual utterance
 * into language-tagged phrases. Every STT provider implementation normalizes
 * to these shapes.
 */

export type LanguageTag = 'es' | 'en' | 'unknown';

export interface TranscribedWord {
  /** The word as recognized */
  word: string;
  /** Start time in seconds within the audio buffer */
  start_sec: number;
  /** End time in seconds */
  end_sec: number;
  /** Provider-reported per-word confidence, 0–1. Undefined when not available. */
  confidence?: number;
  /** Provider-tagged language (if available) or our post-hoc detection */
  language?: LanguageTag;
}

export interface TranscriptionResult {
  /** Plain text — concatenation of all words */
  text: string;
  /** Per-word breakdown with timestamps */
  words: TranscribedWord[];
  /** Dominant language detected by the provider (whole-utterance) */
  dominant_language: string;
  /** Audio duration in seconds */
  duration_sec: number;
  /** Provider name for telemetry */
  provider: string;
  /** Time spent in the transcription call, ms */
  latency_ms: number;
}

export interface TranscriptionRequest {
  /** WAV audio buffer (includes 44-byte header). 16 kHz mono recommended. */
  audio: Buffer;
  /** Optional language hint, e.g. 'es' or 'en'. Omit for auto-detect. */
  language_hint?: string;
}

export interface Transcriber {
  /** Short identifier for logging, e.g. 'whisper-1', 'gpt-4o-transcribe' */
  readonly name: string;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

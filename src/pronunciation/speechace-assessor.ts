import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssessmentRequest,
  ErrorType,
  PronunciationAssessment,
  PronunciationAssessor,
  WordAssessment,
} from './types.js';

/**
 * SpeechAce-backed pronunciation assessor.
 *
 * Endpoint: https://api2.speechace.com/api/scoring/text/v9/json
 * Docs:     https://docs.speechace.com/
 *
 * Why SpeechAce for v2: the user already has SPEECHACE_API_KEY in .env, so
 * there's zero signup friction. Architecture stays vendor-agnostic via the
 * PronunciationAssessor interface — swapping to Azure later means writing
 * one new file, not changing any callers.
 *
 * Audio: SpeechAce accepts most common formats (wav, mp3, flac, ogg, m4a).
 * For LiveKit-captured audio we'll typically pass 16kHz mono PCM wrapped in
 * a WAV header.
 */
export class SpeechAceAssessor implements PronunciationAssessor {
  readonly name = 'speechace';

  private readonly apiKey: string;
  private readonly endpoint =
    'https://api2.speechace.com/api/scoring/text/v9/json';

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.SPEECHACE_API_KEY;
    if (!key) {
      throw new Error(
        'SpeechAceAssessor: SPEECHACE_API_KEY is not set. Either pass it to the constructor or set the env var.',
      );
    }
    this.apiKey = key;
  }

  async assess(req: AssessmentRequest): Promise<PronunciationAssessment> {
    const startedAt = Date.now();

    // SpeechAce expects multipart/form-data with the audio as a file upload.
    // We write the audio to a temp file then attach it to a FormData blob.
    const tmpDir = await mkdtemp(join(tmpdir(), 'habla-pron-'));
    const audioPath = join(tmpDir, 'turn.wav');

    try {
      await writeFile(audioPath, req.audio);

      const form = new FormData();
      form.append('text', req.reference_text);
      // Cast to BlobPart — Buffer/Uint8Array work at runtime; the strict TS Blob
      // signature only accepts ArrayBuffer-backed views.
      form.append(
        'user_audio_file',
        new Blob([req.audio as unknown as BlobPart]),
        'turn.wav',
      );
      form.append('dialect', req.language ?? 'es-mx');
      // Phoneme-level breakdown
      form.append('include_intonation', '1');
      form.append('include_fluency', '1');

      const url = `${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        body: form,
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`SpeechAce ${resp.status}: ${body.slice(0, 200)}`);
      }

      const json = (await resp.json()) as SpeechAceResponse;

      return this.normalize(json, req, Date.now() - startedAt);
    } catch (err) {
      // Per the interface contract — never throw to a fire-and-forget caller.
      // Return a degraded assessment that the annotation logic will treat as no-op.
      console.warn('[speechace] assess failed:', err);
      return {
        reference_text: req.reference_text,
        overall: { accuracy: 0, fluency: 0, completeness: 0, pronunciation: 0 },
        words: [],
        provider: this.name,
        latency_ms: Date.now() - startedAt,
      };
    } finally {
      // Best-effort temp file cleanup; ignore errors.
      await unlink(audioPath).catch(() => undefined);
    }
  }

  /**
   * Normalize SpeechAce's response shape into our vendor-agnostic types.
   * SpeechAce v9 response shape: text_score.{quality_score, fluency, word_score_list[]}
   * with each word having phone_score_list[] and syllable_score_list[].
   */
  private normalize(
    raw: SpeechAceResponse,
    req: AssessmentRequest,
    latencyMs: number,
  ): PronunciationAssessment {
    const ts = raw.text_score;
    if (!ts) {
      return {
        reference_text: req.reference_text,
        overall: { accuracy: 0, fluency: 0, completeness: 0, pronunciation: 0 },
        words: [],
        provider: this.name,
        latency_ms: latencyMs,
      };
    }

    const words: WordAssessment[] = (ts.word_score_list ?? []).map((w) => ({
      word: w.word,
      accuracy_score: w.quality_score ?? 0,
      error_type: classifyError(w.quality_score),
      syllables: (w.syllable_score_list ?? []).map((s) => ({
        syllable: s.letters ?? '',
        accuracy_score: s.quality_score ?? 0,
      })),
      phonemes: (w.phone_score_list ?? []).map((p) => ({
        phoneme: p.phone ?? '',
        accuracy_score: p.quality_score ?? 0,
        // SpeechAce doesn't expose alternative-phoneme N-best in the public API;
        // we leave alternatives undefined. Azure will populate this field.
      })),
    }));

    return {
      reference_text: req.reference_text,
      recognized_text: ts.recognized_text,
      overall: {
        accuracy: ts.quality_score ?? 0,
        fluency: ts.fluency?.overall_metrics?.fluency_score ?? 0,
        completeness: ts.completeness ?? 100,
        pronunciation: ts.pronunciation ?? ts.quality_score ?? 0,
      },
      prosody: ts.intonation
        ? {
            score: ts.intonation.overall_score,
            errors:
              ts.intonation.overall_score && ts.intonation.overall_score < 50
                ? [{ type: 'Monotone' }]
                : [],
          }
        : undefined,
      words,
      provider: this.name,
      latency_ms: latencyMs,
    };
  }
}

function classifyError(score: number | undefined): ErrorType {
  if (score === undefined) return 'None';
  if (score < 50) return 'Mispronunciation';
  return 'None';
}

// ── SpeechAce raw response shape (subset we use) ─────────────────────
interface SpeechAceResponse {
  status?: string;
  text_score?: {
    quality_score?: number;
    pronunciation?: number;
    completeness?: number;
    recognized_text?: string;
    fluency?: { overall_metrics?: { fluency_score?: number } };
    intonation?: { overall_score?: number };
    word_score_list?: Array<{
      word: string;
      quality_score?: number;
      syllable_score_list?: Array<{ letters?: string; quality_score?: number }>;
      phone_score_list?: Array<{ phone?: string; quality_score?: number }>;
    }>;
  };
}

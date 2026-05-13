import { segment, type Phrase } from '../segmenter.js';
import type { Transcriber } from '../stt/types.js';
import type { PronunciationAssessor, PronunciationAssessment, WordAssessment } from './types.js';

/**
 * Per-segment pronunciation scoring for code-switching learner speech.
 *
 * Architecture (Phase 13):
 *   raw WAV
 *     → Transcriber (gives words + timestamps)
 *     → segmenter (phrases tagged by language)
 *     → for each Spanish phrase: slice WAV, hand to PronunciationAssessor
 *     → aggregate per-phrase results into a single PronunciationAssessment
 *
 * The aggregated shape matches the existing single-utterance assessment so
 * downstream consumers (prompt-builder, web UI) need no API changes. English
 * phrases are reflected in the recognized_text but not pronunciation-scored.
 */

export interface SegmentedAssessmentResult extends PronunciationAssessment {
  /** Phrase-level breakdown — needed by per-segment UI rendering */
  phrases: Array<{
    text: string;
    language: 'es' | 'en' | 'unknown';
    start_sec: number;
    end_sec: number;
    /** Defined for Spanish phrases that were scored; undefined for English */
    assessment?: {
      accuracy: number;
      pronunciation: number;
      fluency: number;
      completeness: number;
      words: WordAssessment[];
    };
  }>;
  /** STT-level details that don't fit the per-segment view */
  stt: {
    provider: string;
    latency_ms: number;
    dominant_language: string;
  };
}

export interface SegmentedScorerOptions {
  transcriber: Transcriber;
  assessor: PronunciationAssessor;
  /** Sample rate of the input WAV. Defaults to 16000. */
  sampleRate?: number;
  /** Language tag passed to Azure for Spanish phrases. Defaults to 'es-MX'. */
  scoringLanguage?: string;
}

/**
 * Slice a WAV file (header + PCM) to a [start, end] second range and return
 * a new WAV buffer. Used to hand Azure only the audio for a given phrase.
 */
function sliceWav(
  wav: Buffer,
  startSec: number,
  endSec: number,
  sampleRate: number,
): Buffer {
  const headerSize = 44;
  const bytesPerSample = 2;

  const startByte = headerSize + Math.floor(startSec * sampleRate) * bytesPerSample;
  const endByte = headerSize + Math.floor(endSec * sampleRate) * bytesPerSample;
  const sliceLen = Math.max(0, endByte - startByte);

  // Build new header for the sliced audio
  const header = Buffer.alloc(headerSize);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + sliceLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(sliceLen, 40);

  return Buffer.concat([header, wav.subarray(startByte, endByte)]);
}

export class SegmentedScorer {
  constructor(private readonly opts: SegmentedScorerOptions) {}

  /**
   * Run the full segmented-scoring pipeline on a WAV buffer. Returns an
   * aggregated assessment with both the legacy single-utterance shape and
   * per-phrase breakdown.
   */
  async score(wav: Buffer): Promise<SegmentedAssessmentResult> {
    const sampleRate = this.opts.sampleRate ?? 16000;
    const scoringLanguage = this.opts.scoringLanguage ?? 'es-MX';

    // 1. Transcribe with timestamps
    const stt = await this.opts.transcriber.transcribe({ audio: wav });

    // 2. Segment into language-tagged phrases
    const phrases = segment(stt.words);

    // 3. Score each Spanish phrase against its audio slice
    const phraseResults: SegmentedAssessmentResult['phrases'] = [];
    const allScoredWords: WordAssessment[] = [];

    for (const p of phrases) {
      const base = {
        text: p.text,
        language: p.language,
        start_sec: p.start_sec,
        end_sec: p.end_sec,
      };

      if (p.language !== 'es' || p.words.length === 0) {
        phraseResults.push(base);
        continue;
      }

      // Slice + assess
      const slice = sliceWav(wav, p.start_sec, p.end_sec, sampleRate);
      const sliceDuration = p.end_sec - p.start_sec;

      if (sliceDuration < 0.3) {
        // Too short for Azure — keep the phrase in the breakdown but don't score
        phraseResults.push(base);
        continue;
      }

      try {
        const a = await this.opts.assessor.assess({
          audio: slice,
          reference_text: p.text,
          sample_rate: sampleRate,
          language: scoringLanguage,
        });
        phraseResults.push({
          ...base,
          assessment: {
            accuracy: a.overall.accuracy,
            pronunciation: a.overall.pronunciation,
            fluency: a.overall.fluency,
            completeness: a.overall.completeness,
            words: a.words,
          },
        });
        allScoredWords.push(...a.words);
      } catch (err) {
        console.warn(`[segmented-scorer] phrase "${p.text}" failed:`, err);
        phraseResults.push(base);
      }
    }

    // 4. Aggregate per-phrase scores into the legacy single-utterance shape.
    // Weight by phrase duration so a long Spanish phrase counts more than a
    // tiny one. English phrases don't contribute to the aggregate score.
    const scored = phraseResults.filter((p) => p.assessment);
    let totalWeight = 0;
    let weightedAcc = 0;
    let weightedPron = 0;
    let weightedFlu = 0;
    let weightedComp = 0;
    for (const p of scored) {
      const w = Math.max(0.1, p.end_sec - p.start_sec);
      totalWeight += w;
      weightedAcc += p.assessment!.accuracy * w;
      weightedPron += p.assessment!.pronunciation * w;
      weightedFlu += p.assessment!.fluency * w;
      weightedComp += p.assessment!.completeness * w;
    }
    const overall =
      totalWeight > 0
        ? {
            accuracy: weightedAcc / totalWeight,
            pronunciation: weightedPron / totalWeight,
            fluency: weightedFlu / totalWeight,
            completeness: weightedComp / totalWeight,
          }
        : { accuracy: 0, pronunciation: 0, fluency: 0, completeness: 0 };

    return {
      reference_text: stt.text,
      recognized_text: stt.text,
      overall,
      words: allScoredWords,
      provider: `segmented(${this.opts.transcriber.name}+${this.opts.assessor.name})`,
      latency_ms: stt.latency_ms,
      phrases: phraseResults,
      stt: {
        provider: stt.provider,
        latency_ms: stt.latency_ms,
        dominant_language: stt.dominant_language,
      },
    };
  }
}

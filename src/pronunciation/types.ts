/**
 * Pronunciation assessment types — vendor-agnostic.
 *
 * These shapes capture what Azure, SpeechAce, SpeechSuper, and future
 * wav2vec2-based pipelines can all produce. Each provider implementation
 * normalizes its raw output into these types so the rest of Habla
 * (transcript annotation, FSRS feedback, learner-facing UI) doesn't care
 * which engine produced the score.
 */

export type ErrorType =
  | 'None'
  | 'Mispronunciation'
  | 'Omission'
  | 'Insertion'
  | 'UnexpectedBreak'
  | 'MissingBreak'
  | 'Monotone';

export interface PhonemeAssessment {
  /** IPA or provider-specific phoneme symbol */
  phoneme: string;
  /** 0–100 accuracy of the actual production vs the expected phoneme */
  accuracy_score: number;
  /**
   * What the engine thinks the learner ACTUALLY produced, when different
   * from the expected phoneme. Empty when the phoneme was correct.
   * Format: { phoneme: 'ɾ', confidence: 0.81 } — they tapped instead of trilled.
   */
  alternatives?: Array<{ phoneme: string; confidence: number }>;
}

export interface SyllableAssessment {
  syllable: string;
  accuracy_score: number;
  /** Offset into the audio buffer in milliseconds */
  offset_ms?: number;
  duration_ms?: number;
}

export interface WordAssessment {
  word: string;
  accuracy_score: number;
  error_type: ErrorType;
  syllables?: SyllableAssessment[];
  phonemes?: PhonemeAssessment[];
}

export interface ProsodyAssessment {
  /** 0–100 overall prosody score. Undefined if engine doesn't support prosody. */
  score?: number;
  /** Specific prosody errors detected at the utterance level */
  errors: Array<{
    type: 'Monotone' | 'UnexpectedBreak' | 'MissingBreak';
    /** Optional word-index where the error occurs */
    at_word_index?: number;
  }>;
}

export interface PronunciationAssessment {
  /** What text the engine was scoring against. Usually the STT transcript. */
  reference_text: string;
  /** Engine-recovered actual production. Often identical to reference but not always. */
  recognized_text?: string;

  overall: {
    accuracy: number;
    fluency: number;
    completeness: number;
    /** Composite "pronunciation score" — provider-defined weighting */
    pronunciation: number;
  };

  prosody?: ProsodyAssessment;
  words: WordAssessment[];

  /** Provider name for telemetry / diff debugging */
  provider: string;
  /** Time spent in the assessment call, ms */
  latency_ms: number;
}

export interface AssessmentRequest {
  /** Raw PCM audio, typically 16kHz mono — the format depends on the provider */
  audio: Buffer | Uint8Array;
  /** What the learner was trying to say. From STT. */
  reference_text: string;
  /** Audio sample rate in Hz */
  sample_rate?: number;
  /** Language tag (e.g., 'es-MX', 'es-ES'). Defaults vary per provider. */
  language?: string;
}

/**
 * Provider-agnostic interface. All engines (Azure, SpeechAce, wav2vec2,
 * NoOp default) implement this. The agent only ever talks to this interface.
 */
export interface PronunciationAssessor {
  /** Short identifier for logging/telemetry, e.g. 'azure', 'speechace', 'noop' */
  readonly name: string;

  /**
   * Score a single recorded turn. Designed to run AFTER end-of-turn,
   * concurrent with TTS playback — never on the critical path.
   *
   * Implementations should:
   *   - Return quickly (target <2s) or surface their own timeout
   *   - Catch their own errors and return a degraded assessment, not throw
   *   - Be safe to call from a fire-and-forget context
   */
  assess(req: AssessmentRequest): Promise<PronunciationAssessment>;
}

/**
 * Builds the annotation string injected into the LLM transcript when a word
 * was mispronounced. Format intentionally compact and readable:
 *
 *   [learner] Tengo un perro grande
 *     [pronunciation] perro: 62 (Mispronunciation, /r/ → /ɾ/, /e/ → /ɛ/)
 *     [pronunciation] STT/assessor mismatch: heard "pero" not "perro"
 *
 * The Sofía system prompt teaches her how to respond to these annotations.
 *
 * Up to MAX_PHONEME_HINTS phoneme substitutions are surfaced per word — multi-
 * phoneme L1 patterns (e.g., simultaneous flat /r/ and English /e/→/eɪ/) are
 * the rule for L2 speech, not the exception. Capping to one would hide the
 * actual L1-transfer pattern from Sofía.
 */
const MAX_PHONEME_HINTS_PER_WORD = 3;

function normalizeText(s: string | undefined): string {
  return (s || '').replace(/[.,!?;:¿¡]/g, '').trim().toLowerCase();
}

export function formatAnnotation(
  assessment: PronunciationAssessment,
  scoreThreshold = 70,
): string | null {
  const flagged = assessment.words.filter(
    (w) => w.accuracy_score < scoreThreshold || w.error_type !== 'None',
  );

  // Engine/STT divergence is its own signal — Deepgram heard X, the assessor
  // expected Y. When this happens for a turn that wasn't otherwise flagged it
  // strongly suggests the learner pronounced something differently than what
  // STT auto-corrected to. Surface even when no individual word was below
  // threshold so Sofía can probe.
  const recognized = normalizeText(assessment.recognized_text);
  const reference = normalizeText(assessment.reference_text);
  const divergence =
    recognized.length > 0 && recognized !== reference;

  const monotone =
    assessment.prosody?.errors.some((e) => e.type === 'Monotone') ?? false;

  if (flagged.length === 0 && !divergence && !monotone) return null;

  const lines: string[] = [];

  for (const w of flagged) {
    const phonemeHints =
      w.phonemes
        ?.filter(
          (p) =>
            p.accuracy_score < scoreThreshold && (p.alternatives?.length ?? 0) > 0,
        )
        .slice(0, MAX_PHONEME_HINTS_PER_WORD)
        .map((p) => {
          const alt = p.alternatives?.[0];
          return alt ? `/${p.phoneme}/ → /${alt.phoneme}/` : '';
        })
        .filter((s) => s.length > 0) ?? [];

    const phonemeStr = phonemeHints.length ? `, ${phonemeHints.join(', ')}` : '';
    const errorLabel = w.error_type === 'None' ? 'LowScore' : w.error_type;
    lines.push(
      `  [pronunciation] ${w.word}: ${Math.round(w.accuracy_score)} (${errorLabel}${phonemeStr})`,
    );
  }

  if (divergence) {
    lines.push(
      `  [pronunciation] STT/assessor mismatch: heard "${assessment.recognized_text?.trim()}" not "${assessment.reference_text}"`,
    );
  }

  if (monotone) {
    lines.push(`  [pronunciation] prosody: monotone`);
  }

  return lines.join('\n');
}

/**
 * Aggregate signal across the last N assessments. Surfaces phonemes and words
 * that have been weak repeatedly — the L1-transfer pattern starting to emerge.
 *
 * Returns null when nothing crosses the persistence threshold (≥2 occurrences).
 *
 * Output format:
 *   ## Pronunciation patterns over recent turns
 *   Recurring phoneme weakness:
 *     - /r/ flagged in 3 of last 5 turns (perro, corre, rápido)
 *     - /e/ flagged in 2 of last 5 turns (leche, café)
 *   Recurring word: "casa" flagged 2× in last 5 turns
 */
export function summarizePronunciationTrends(
  assessments: PronunciationAssessment[],
  scoreThreshold = 70,
  windowSize = 5,
): string | null {
  if (!assessments || assessments.length < 2) return null;

  const recent = assessments.slice(-windowSize);

  // phoneme symbol → set of words it appeared weak in across the window
  const phonemeWeakness = new Map<string, Set<string>>();
  // word → count of turns it was flagged in
  const wordRecurrence = new Map<string, number>();

  for (const a of recent) {
    const wordsFlaggedThisTurn = new Set<string>();
    for (const w of a.words) {
      const isFlagged =
        w.accuracy_score < scoreThreshold || w.error_type !== 'None';
      if (!isFlagged) continue;

      wordsFlaggedThisTurn.add(w.word.toLowerCase());

      for (const p of w.phonemes ?? []) {
        if (p.accuracy_score < scoreThreshold && p.phoneme) {
          if (!phonemeWeakness.has(p.phoneme)) {
            phonemeWeakness.set(p.phoneme, new Set());
          }
          phonemeWeakness.get(p.phoneme)!.add(w.word);
        }
      }
    }
    for (const w of wordsFlaggedThisTurn) {
      wordRecurrence.set(w, (wordRecurrence.get(w) ?? 0) + 1);
    }
  }

  const recurringPhonemes = Array.from(phonemeWeakness.entries())
    .filter(([_, words]) => words.size >= 2)
    .sort((a, b) => b[1].size - a[1].size);

  const recurringWords = Array.from(wordRecurrence.entries())
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (recurringPhonemes.length === 0 && recurringWords.length === 0) {
    return null;
  }

  const lines: string[] = ['## Pronunciation patterns over recent turns'];

  if (recurringPhonemes.length > 0) {
    lines.push('Recurring phoneme weakness (probable L1 transfer):');
    for (const [phoneme, words] of recurringPhonemes.slice(0, 4)) {
      const wordList = Array.from(words).slice(0, 4).join(', ');
      lines.push(
        `  - /${phoneme}/ flagged in ${words.size} of last ${recent.length} turns (${wordList})`,
      );
    }
  }

  if (recurringWords.length > 0) {
    const top = recurringWords
      .slice(0, 3)
      .map(([w, c]) => `"${w}" (${c}×)`)
      .join(', ');
    lines.push(`Recurring word-level flags: ${top}`);
  }

  return lines.join('\n');
}

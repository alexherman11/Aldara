import type {
  AssessmentRequest,
  PronunciationAssessment,
  PronunciationAssessor,
} from './types.js';

/**
 * Default assessor — returns a "perfect score" with no flags.
 *
 * Used when no real provider is configured (or as the fallback path during
 * provider outages). The dual-pipeline architecture must always return SOME
 * assessment so the agent code never has to special-case "no pronunciation
 * data available" — it just gets back a clean assessment with no annotations.
 */
export class NoOpAssessor implements PronunciationAssessor {
  readonly name = 'noop';

  async assess(req: AssessmentRequest): Promise<PronunciationAssessment> {
    const words = req.reference_text
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({
        word,
        accuracy_score: 100,
        error_type: 'None' as const,
      }));

    return {
      reference_text: req.reference_text,
      recognized_text: req.reference_text,
      overall: {
        accuracy: 100,
        fluency: 100,
        completeness: 100,
        pronunciation: 100,
      },
      words,
      provider: this.name,
      latency_ms: 0,
    };
  }
}

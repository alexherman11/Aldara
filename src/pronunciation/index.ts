/**
 * Pronunciation assessment factory.
 *
 * Single entry point for the rest of Habla. Reads PRONUNCIATION_PROVIDER
 * from the environment and returns the matching assessor. Defaults to noop
 * when no provider is configured, so the feature can be turned on/off via
 * env without code changes.
 */

import { NoOpAssessor } from './noop-assessor.js';
import { SpeechAceAssessor } from './speechace-assessor.js';
import { AzureAssessor } from './azure-assessor.js';
import { SegmentedAssessor } from './segmented-assessor.js';
import type { PronunciationAssessor } from './types.js';

export type ProviderName = 'noop' | 'speechace' | 'azure' | 'segmented';

export function createAssessor(
  provider?: ProviderName,
): PronunciationAssessor {
  const name =
    provider ??
    (process.env.PRONUNCIATION_PROVIDER as ProviderName | undefined) ??
    'noop';

  switch (name) {
    case 'segmented':
      return new SegmentedAssessor();
    case 'speechace':
      return new SpeechAceAssessor();
    case 'azure':
      return new AzureAssessor();
    case 'noop':
    default:
      return new NoOpAssessor();
  }
}

export type {
  AssessmentRequest,
  PhonemeAssessment,
  PronunciationAssessment,
  PronunciationAssessor,
  ProsodyAssessment,
  SyllableAssessment,
  WordAssessment,
  ErrorType,
} from './types.js';

export { formatAnnotation, summarizePronunciationTrends } from './types.js';
export { NoOpAssessor } from './noop-assessor.js';
export { SpeechAceAssessor } from './speechace-assessor.js';
export { AzureAssessor } from './azure-assessor.js';
export { SegmentedAssessor } from './segmented-assessor.js';
export { SegmentedScorer } from './segmented-scorer.js';
export type { SegmentedAssessmentResult } from './segmented-scorer.js';

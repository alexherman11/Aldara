import { DeepgramSTT } from '../stt/deepgram-stt.js';
import { OpenAIWhisperSTT } from '../stt/openai-stt.js';
import type { Transcriber } from '../stt/types.js';
import { AzureAssessor } from './azure-assessor.js';
import { SegmentedScorer } from './segmented-scorer.js';
import type {
  AssessmentRequest,
  PronunciationAssessment,
  PronunciationAssessor,
} from './types.js';

/**
 * Adapter that exposes the SegmentedScorer behind the existing
 * PronunciationAssessor interface, so the live agent can swap from
 * single-utterance Azure scoring to segmented Deepgram+Azure scoring
 * via PRONUNCIATION_PROVIDER=segmented — no agent code changes.
 *
 * Ignores req.reference_text (the live STT's transcript) and instead
 * re-transcribes the audio with Deepgram REST. This is intentional: the
 * live transcript may have language-locked, but Deepgram's REST API with
 * `language: multi` keeps English and Spanish properly separated, which
 * is what the segmenter needs.
 *
 * The returned PronunciationAssessment carries an extra `phrases` field
 * that downstream code (UI, prompt builder) can opt into for per-segment
 * rendering. Code that doesn't know about phrases still gets a well-shaped
 * legacy assessment with the same `overall`/`words` fields.
 */
export class SegmentedAssessor implements PronunciationAssessor {
  readonly name = 'segmented';

  private readonly scorer: SegmentedScorer;

  constructor(opts?: {
    transcriber?: Transcriber;
    azureKey?: string;
    azureRegion?: string;
  }) {
    const transcriber =
      opts?.transcriber ??
      (process.env.SEGMENTED_STT === 'whisper'
        ? new OpenAIWhisperSTT()
        : new DeepgramSTT());
    const assessor = new AzureAssessor({
      key: opts?.azureKey,
      region: opts?.azureRegion,
    });
    this.scorer = new SegmentedScorer({
      transcriber,
      assessor,
    });
  }

  async assess(req: AssessmentRequest): Promise<PronunciationAssessment> {
    const audioBuf = Buffer.isBuffer(req.audio)
      ? req.audio
      : Buffer.from(req.audio);
    const result = await this.scorer.score(audioBuf);
    // The segmented scorer uses Deepgram REST as the per-phrase Azure reference,
    // so it sets reference_text = REST transcript. The web client, however,
    // indexes the published pronunciation payload by normalizeText(reference_text)
    // and looks it up by normalizeText(bubbleText) — where bubbleText comes from
    // the *live* STT. When those texts diverge (frequent for noisy/code-switched
    // turns) the lookup misses and the bubble stays unannotated even though the
    // per-word data is correct. Restore the caller's reference here; recognized_text
    // already carries the REST transcript for the divergence-aware UI/prompt.
    return { ...result, reference_text: req.reference_text };
  }
}

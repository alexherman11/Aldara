import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type {
  AssessmentRequest,
  ErrorType,
  PhonemeAssessment,
  PronunciationAssessment,
  PronunciationAssessor,
  ProsodyAssessment,
  SyllableAssessment,
  WordAssessment,
} from './types.js';

/**
 * Azure Speech Pronunciation Assessment.
 *
 * Why Azure: per-phoneme N-best alternatives. When the learner mispronounces
 * the trilled /r/ in "perro" as a tap /ɾ/, Azure tells us exactly that — which
 * is the actionable signal for Sofía to model back the correct form. SpeechAce
 * gives accuracy scores but doesn't expose what the learner actually produced.
 *
 * Free tier (F0 SKU): 5 hours/month of pronunciation assessment. Plenty for
 * prototyping a single learner. Beyond that: $1/hr standard, $0.50/hr short-audio.
 *
 * Environment:
 *   AZURE_SPEECH_KEY     — subscription key from your Azure Speech resource
 *   AZURE_SPEECH_REGION  — region of the resource, e.g. "eastus"
 *
 * Note on prosody: Azure's prosody scoring is en-US only as of this writing.
 * For Spanish output we get accuracy/fluency/completeness but not a prosody
 * score. The interface still returns ProsodyAssessment with errors:[] so
 * downstream code is uniform.
 */
export class AzureAssessor implements PronunciationAssessor {
  readonly name = 'azure';

  private readonly speechKey: string;
  private readonly speechRegion: string;

  constructor(opts?: { key?: string; region?: string }) {
    const key = opts?.key ?? process.env.AZURE_SPEECH_KEY;
    const region = opts?.region ?? process.env.AZURE_SPEECH_REGION;
    if (!key || !region) {
      throw new Error(
        'AzureAssessor: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must both be set ' +
          '(either in the env or passed to the constructor).',
      );
    }
    this.speechKey = key;
    this.speechRegion = region;
  }

  async assess(req: AssessmentRequest): Promise<PronunciationAssessment> {
    const startedAt = Date.now();

    try {
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        this.speechKey,
        this.speechRegion,
      );
      speechConfig.speechRecognitionLanguage = req.language ?? 'es-MX';

      const pushStream = sdk.AudioInputStream.createPushStream(
        sdk.AudioStreamFormat.getWaveFormatPCM(req.sample_rate ?? 16000, 16, 1),
      );
      // Strip the WAV header (44 bytes) and push raw PCM. Azure expects raw
      // PCM in the push stream when the format is set explicitly.
      const audio = req.audio as Buffer;
      const pcm = audio.length > 44 ? audio.subarray(44) : audio;
      pushStream.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
      pushStream.close();

      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      // Configure pronunciation assessment with phoneme-level granularity and
      // N-best phoneme alternatives — the killer feature.
      const pronConfig = new sdk.PronunciationAssessmentConfig(
        req.reference_text,
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Phoneme,
        true, // enable miscue (Omission/Insertion detection)
      );
      pronConfig.nbestPhonemeCount = 5;
      // Prosody is en-US only — toggle on regardless; Azure ignores when unsupported
      pronConfig.enableProsodyAssessment = true;
      pronConfig.applyTo(recognizer);

      const raw = await new Promise<sdk.SpeechRecognitionResult>(
        (resolve, reject) => {
          recognizer.recognizeOnceAsync(
            (result) => resolve(result),
            (err) => reject(new Error(String(err))),
          );
        },
      );

      try {
        recognizer.close();
      } catch {
        // ignore close errors — they don't affect the result we already have
      }

      return this.normalize(raw, req, Date.now() - startedAt);
    } catch (err) {
      // Per the interface contract — never throw to a fire-and-forget caller.
      console.warn('[azure] assess failed:', err);
      return {
        reference_text: req.reference_text,
        overall: { accuracy: 0, fluency: 0, completeness: 0, pronunciation: 0 },
        words: [],
        provider: this.name,
        latency_ms: Date.now() - startedAt,
      };
    }
  }

  /**
   * Normalize Azure's PronunciationAssessmentResult into our vendor-agnostic
   * shape. The raw JSON lives in result.properties under the
   * "SpeechServiceResponse_JsonResult" property — we parse it directly because
   * the SDK's typed accessors don't expose nbest phoneme alternatives.
   */
  private normalize(
    raw: sdk.SpeechRecognitionResult,
    req: AssessmentRequest,
    latencyMs: number,
  ): PronunciationAssessment {
    const jsonStr = raw.properties.getProperty(
      sdk.PropertyId.SpeechServiceResponse_JsonResult,
    );
    if (!jsonStr) {
      return {
        reference_text: req.reference_text,
        recognized_text: raw.text,
        overall: { accuracy: 0, fluency: 0, completeness: 0, pronunciation: 0 },
        words: [],
        provider: this.name,
        latency_ms: latencyMs,
      };
    }

    const json = JSON.parse(jsonStr) as AzureRecognitionJson;
    const nbest = json.NBest?.[0];
    const pronAssessment = nbest?.PronunciationAssessment;

    if (!nbest || !pronAssessment) {
      return {
        reference_text: req.reference_text,
        recognized_text: raw.text,
        overall: { accuracy: 0, fluency: 0, completeness: 0, pronunciation: 0 },
        words: [],
        provider: this.name,
        latency_ms: latencyMs,
      };
    }

    const words: WordAssessment[] = (nbest.Words ?? []).map((w) => {
      const wp = w.PronunciationAssessment;
      const phonemes: PhonemeAssessment[] = (w.Phonemes ?? []).map((p) => ({
        phoneme: p.Phoneme,
        accuracy_score: p.PronunciationAssessment?.AccuracyScore ?? 0,
        alternatives:
          p.PronunciationAssessment?.NBestPhonemes?.filter(
            (alt) => alt.Phoneme !== p.Phoneme,
          )
            .slice(0, 3)
            .map((alt) => ({
              phoneme: alt.Phoneme,
              confidence: (alt.Score ?? 0) / 100,
            })) || undefined,
      }));

      const syllables: SyllableAssessment[] = (w.Syllables ?? []).map((s) => ({
        syllable: s.Syllable,
        accuracy_score: s.PronunciationAssessment?.AccuracyScore ?? 0,
        offset_ms: s.Offset !== undefined ? s.Offset / 10000 : undefined, // 100ns ticks → ms
        duration_ms: s.Duration !== undefined ? s.Duration / 10000 : undefined,
      }));

      return {
        word: w.Word,
        accuracy_score: wp?.AccuracyScore ?? 0,
        error_type: mapErrorType(wp?.ErrorType),
        syllables: syllables.length ? syllables : undefined,
        phonemes: phonemes.length ? phonemes : undefined,
      };
    });

    const prosodyErrors: ProsodyAssessment['errors'] = [];
    if (pronAssessment.ProsodyScore !== undefined && pronAssessment.ProsodyScore < 50) {
      prosodyErrors.push({ type: 'Monotone' });
    }
    // Per-word UnexpectedBreak / MissingBreak surface as word error_type already

    return {
      reference_text: req.reference_text,
      recognized_text: raw.text,
      overall: {
        accuracy: pronAssessment.AccuracyScore ?? 0,
        fluency: pronAssessment.FluencyScore ?? 0,
        completeness: pronAssessment.CompletenessScore ?? 0,
        pronunciation: pronAssessment.PronScore ?? pronAssessment.AccuracyScore ?? 0,
      },
      prosody:
        pronAssessment.ProsodyScore !== undefined
          ? { score: pronAssessment.ProsodyScore, errors: prosodyErrors }
          : undefined,
      words,
      provider: this.name,
      latency_ms: latencyMs,
    };
  }
}

function mapErrorType(azureType?: string): ErrorType {
  switch (azureType) {
    case 'Mispronunciation':
    case 'Omission':
    case 'Insertion':
    case 'UnexpectedBreak':
    case 'MissingBreak':
    case 'Monotone':
      return azureType;
    case 'None':
    default:
      return 'None';
  }
}

// ── Azure raw response shape (subset we consume) ─────────────────────
interface AzureRecognitionJson {
  RecognitionStatus?: string;
  DisplayText?: string;
  NBest?: Array<{
    Confidence?: number;
    Display?: string;
    PronunciationAssessment?: {
      AccuracyScore?: number;
      FluencyScore?: number;
      CompletenessScore?: number;
      PronScore?: number;
      ProsodyScore?: number;
    };
    Words?: Array<{
      Word: string;
      PronunciationAssessment?: {
        AccuracyScore?: number;
        ErrorType?: string;
      };
      Syllables?: Array<{
        Syllable: string;
        Offset?: number;
        Duration?: number;
        PronunciationAssessment?: { AccuracyScore?: number };
      }>;
      Phonemes?: Array<{
        Phoneme: string;
        Offset?: number;
        Duration?: number;
        PronunciationAssessment?: {
          AccuracyScore?: number;
          NBestPhonemes?: Array<{ Phoneme: string; Score?: number }>;
        };
      }>;
    }>;
  }>;
}

/**
 * Regression test for the SegmentedScorer's sample-rate handling.
 *
 * Live LiveKit deployments capture mic audio at 48 kHz. The scorer used to
 * default to 16 kHz when its optional `sampleRate` constructor arg wasn't
 * supplied, which meant every per-phrase slice handed to Azure was a third
 * of the intended length — Azure then scored the wrong audio against the
 * Spanish phrase text. This script verifies the scorer reads the rate out
 * of the WAV header on a 48 kHz buffer and produces correctly-sized slices.
 *
 * Runs entirely offline with stub STT + assessor — no API calls.
 */

import { chunksToWav, type PcmChunk } from '../src/pronunciation/wav.js';
import { SegmentedScorer } from '../src/pronunciation/segmented-scorer.js';
import type { Transcriber, TranscriptionResult } from '../src/stt/types.js';
import type {
  AssessmentRequest,
  PronunciationAssessment,
  PronunciationAssessor,
} from '../src/pronunciation/types.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info?: string) {
  if (ok) {
    console.log(`  PASS  ${label}${info ? ` — ${info}` : ''}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${info ? ` — ${info}` : ''}`);
    failed++;
  }
}

/** Build a silent 16-bit PCM WAV at the given rate and duration. */
function silentWav(sampleRate: number, durationSec: number): Buffer {
  const sampleCount = Math.floor(sampleRate * durationSec);
  const samples = new Int16Array(sampleCount); // all zeros
  const chunk: PcmChunk = { samples, sampleRate, channels: 1 };
  return chunksToWav([chunk]);
}

/** Stub transcriber that returns one Spanish phrase spanning [0.5, 1.5] sec. */
class StubTranscriber implements Transcriber {
  readonly name = 'stub-stt';
  async transcribe(): Promise<TranscriptionResult> {
    return {
      text: 'hola mundo',
      words: [
        { word: 'hola', start_sec: 0.5, end_sec: 1.0, language: 'es' },
        { word: 'mundo', start_sec: 1.05, end_sec: 1.5, language: 'es' },
      ],
      dominant_language: 'es',
      duration_sec: 2.0,
      provider: 'stub',
      latency_ms: 0,
    };
  }
}

/** Stub assessor that captures the request it received so we can inspect it. */
class CapturingAssessor implements PronunciationAssessor {
  readonly name = 'capturing';
  public lastRequest: AssessmentRequest | null = null;
  async assess(req: AssessmentRequest): Promise<PronunciationAssessment> {
    this.lastRequest = req;
    return {
      reference_text: req.reference_text,
      recognized_text: req.reference_text,
      overall: { accuracy: 95, fluency: 95, completeness: 100, pronunciation: 95 },
      words: req.reference_text.split(/\s+/).map((w) => ({
        word: w,
        accuracy_score: 95,
        error_type: 'None' as const,
      })),
      provider: this.name,
      latency_ms: 0,
    };
  }
}

function readSliceHeader(buf: Buffer) {
  return {
    riff: buf.toString('ascii', 0, 4),
    wave: buf.toString('ascii', 8, 12),
    sampleRate: buf.readUInt32LE(24),
    channels: buf.readUInt16LE(22),
    bitsPerSample: buf.readUInt16LE(34),
    dataLen: buf.readUInt32LE(40),
  };
}

async function main() {
  console.log('── Segmented scorer · sample-rate regression ──\n');

  // Build a 2-second silent WAV at 48 kHz. The stub STT places a phrase from
  // 0.5s to 1.5s, so the expected slice is 1.0s of audio = 48,000 samples =
  // 96,000 bytes of PCM data.
  const wav = silentWav(48000, 2.0);
  const wavHeader = readSliceHeader(wav);
  check('Source WAV sample rate is 48000', wavHeader.sampleRate === 48000,
    `header.sampleRate=${wavHeader.sampleRate}`);
  check('Source WAV is mono 16-bit', wavHeader.channels === 1 && wavHeader.bitsPerSample === 16);

  const transcriber = new StubTranscriber();
  const assessor = new CapturingAssessor();
  // NOTE: deliberately not passing sampleRate to the scorer — that's the
  // path the live agent hits today. The fix is to derive it from the header.
  const scorer = new SegmentedScorer({ transcriber, assessor });

  const result = await scorer.score(wav);

  check('Scorer produced one phrase', result.phrases.length === 1,
    `got ${result.phrases.length}`);
  check('Phrase is Spanish', result.phrases[0]?.language === 'es');
  check('Phrase has an assessment', !!result.phrases[0]?.assessment);

  // Inspect the slice the scorer handed to the assessor.
  const req = assessor.lastRequest;
  check('Assessor received a slice', !!req);
  if (!req) {
    console.log('\n════════════════════════════════════════════════');
    console.log(`RESULT: ${passed} passed, ${failed} failed`);
    console.log('════════════════════════════════════════════════');
    process.exit(1);
  }

  const sliceBuf = req.audio as Buffer;
  const sliceHeader = readSliceHeader(sliceBuf);

  check('Slice has RIFF/WAVE header', sliceHeader.riff === 'RIFF' && sliceHeader.wave === 'WAVE');
  check(
    'Slice sample rate matches source (48000)',
    sliceHeader.sampleRate === 48000,
    `got ${sliceHeader.sampleRate}`,
  );
  // 1.0 second of 48 kHz mono 16-bit = 96000 bytes ± a couple sample rounding.
  check(
    'Slice data length ≈ 96000 bytes (1.0s at 48 kHz mono 16-bit)',
    Math.abs(sliceHeader.dataLen - 96_000) <= 4,
    `dataLen=${sliceHeader.dataLen}`,
  );
  check(
    'Slice request carries the right sample_rate',
    req.sample_rate === 48000,
    `req.sample_rate=${req.sample_rate}`,
  );

  console.log('\n════════════════════════════════════════════════');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

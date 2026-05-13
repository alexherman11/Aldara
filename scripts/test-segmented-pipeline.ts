import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { OpenAIWhisperSTT } from '../src/stt/openai-stt.js';
import { DeepgramSTT } from '../src/stt/deepgram-stt.js';
import { AzureAssessor } from '../src/pronunciation/azure-assessor.js';
import { SegmentedScorer } from '../src/pronunciation/segmented-scorer.js';
import { chunksToWav } from '../src/pronunciation/wav.js';

/**
 * End-to-end validation of the Phase 13 segmented pronunciation pipeline.
 *
 * Synthesizes a mixed Spanish + English utterance via Cartesia (using two
 * voice/language settings), splices the audio together, and runs both the
 * old monolithic Azure pipeline and the new segmented pipeline against it.
 *
 * Expected behavior:
 *   - Old pipeline scores the whole thing against one mixed reference text →
 *     either very low scores or contaminated by the English portion
 *   - New pipeline scores ONLY the Spanish phrases → meaningful scores for
 *     the parts Azure was designed to handle
 */

async function cartesiaSynth(
  text: string,
  language: 'es' | 'en',
): Promise<Buffer> {
  const resp = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.CARTESIA_API_KEY!,
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: text,
      voice: { mode: 'id', id: process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      language,
    }),
  });
  if (!resp.ok) throw new Error(`Cartesia HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  return chunksToWav([{ samples, sampleRate, channels: 1 }]);
}

/** Concatenate raw PCM blobs with optional silence gaps between them. */
function concatWithGaps(
  blobs: Array<{ pcm: Buffer; gapSec?: number }>,
  sampleRate: number,
): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < blobs.length; i++) {
    parts.push(blobs[i].pcm);
    const gap = blobs[i].gapSec ?? 0;
    if (gap > 0) {
      parts.push(Buffer.alloc(Math.floor(gap * sampleRate * 2)));
    }
  }
  return Buffer.concat(parts);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Phase 13 segmented pipeline — end-to-end test');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('Synthesizing test audio: Spanish + English + Spanish with silence gaps...');

  // Build a realistic mixed-language test utterance like the user produced:
  // Spanish thought → English hesitation → Spanish recovery
  const part1 = await cartesiaSynth('Hola me llamo Carlos y tengo treinta años', 'es');
  const part2 = await cartesiaSynth('but I need to think for a moment', 'en');
  const part3 = await cartesiaSynth('me gusta cocinar la pasta italiana', 'es');

  const combined = concatWithGaps(
    [
      { pcm: part1, gapSec: 0.8 },
      { pcm: part2, gapSec: 0.7 },
      { pcm: part3, gapSec: 0 },
    ],
    16000,
  );
  const wav = pcmToWav(combined, 16000);
  console.log(`  Combined audio: ${(combined.length / 2 / 16000).toFixed(2)}s, WAV ${wav.length} bytes\n`);

  // ── Old monolithic baseline ─────────────────────────────────────
  console.log('── BASELINE: Azure scored against single concatenated reference ──');
  const azure = new AzureAssessor();
  const baselineRef =
    'Hola me llamo Carlos y tengo treinta años but I need to think for a moment me gusta cocinar la pasta italiana';
  const baseline = await azure.assess({
    audio: wav,
    reference_text: baselineRef,
    sample_rate: 16000,
    language: 'es-MX',
  });
  console.log(
    `  acc=${baseline.overall.accuracy.toFixed(0)} pron=${baseline.overall.pronunciation.toFixed(0)} ` +
      `fluency=${baseline.overall.fluency.toFixed(0)} words=${baseline.words.length} lat=${baseline.latency_ms}ms`,
  );
  if (baseline.recognized_text && baseline.recognized_text.length > 0) {
    console.log(`  recognized: "${baseline.recognized_text}"`);
  }

  // ── New segmented pipeline ──────────────────────────────────────
  // Default to Deepgram for offline pipeline: empirically better at
  // code-switching than Whisper-1 (which translates English to Spanish).
  // Whisper kept as fallback.
  const sttChoice = process.env.STT_FOR_TEST || 'deepgram';
  const transcriber =
    sttChoice === 'whisper' ? new OpenAIWhisperSTT() : new DeepgramSTT();
  console.log(`\n── SEGMENTED: ${transcriber.name} → segmenter → per-phrase Azure ──`);
  const scorer = new SegmentedScorer({
    transcriber,
    assessor: azure,
    sampleRate: 16000,
  });
  const segmented = await scorer.score(wav);

  console.log(`  STT (${segmented.stt.provider}): ${segmented.stt.latency_ms}ms, dominant_language="${segmented.stt.dominant_language}"`);
  console.log(`  Phrases identified: ${segmented.phrases.length}`);
  for (const p of segmented.phrases) {
    const dur = (p.end_sec - p.start_sec).toFixed(2);
    if (p.assessment) {
      console.log(
        `    [${p.language}] ${dur}s  acc=${p.assessment.accuracy.toFixed(0)}  pron=${p.assessment.pronunciation.toFixed(0)}  "${p.text}"`,
      );
    } else {
      console.log(`    [${p.language}] ${dur}s  (not scored)  "${p.text}"`);
    }
  }
  console.log(
    `\n  Weighted overall: acc=${segmented.overall.accuracy.toFixed(0)} pron=${segmented.overall.pronunciation.toFixed(0)} fluency=${segmented.overall.fluency.toFixed(0)}`,
  );

  // ── Comparison ──────────────────────────────────────────────────
  console.log('\n── COMPARISON ──');
  console.log(`  baseline accuracy:    ${baseline.overall.accuracy.toFixed(0)}`);
  console.log(`  segmented accuracy:   ${segmented.overall.accuracy.toFixed(0)}`);
  console.log(
    `  delta:                ${(segmented.overall.accuracy - baseline.overall.accuracy >= 0 ? '+' : '') +
      (segmented.overall.accuracy - baseline.overall.accuracy).toFixed(1)} points`,
  );
  const spanishPhrases = segmented.phrases.filter((p) => p.assessment);
  console.log(`  Spanish phrases scored individually: ${spanishPhrases.length}`);
  console.log(`  Total audio handed to Azure: ${spanishPhrases.reduce((s, p) => s + (p.end_sec - p.start_sec), 0).toFixed(2)}s (vs ${(combined.length / 2 / 16000).toFixed(2)}s monolithic)`);

  // Pass criteria
  let passed = 0;
  let failed = 0;
  const check = (label: string, ok: boolean, info?: string) => {
    if (ok) {
      console.log(`  PASS  ${label}${info ? ` — ${info}` : ''}`);
      passed++;
    } else {
      console.log(`  FAIL  ${label}${info ? ` — ${info}` : ''}`);
      failed++;
    }
  };

  console.log('\n── Verification ──');
  check('Whisper identified ≥2 phrases', segmented.phrases.length >= 2);
  check('At least one English phrase detected', segmented.phrases.some((p) => p.language === 'en'));
  check('At least one Spanish phrase scored', spanishPhrases.length >= 1);
  check(
    'English phrases not pronunciation-scored',
    segmented.phrases.filter((p) => p.language === 'en').every((p) => !p.assessment),
  );
  check(
    'Segmented overall accuracy > baseline',
    segmented.overall.accuracy > baseline.overall.accuracy,
    `${segmented.overall.accuracy.toFixed(0)} > ${baseline.overall.accuracy.toFixed(0)}`,
  );
  check(
    'Spanish phrase scores are reasonable (>60)',
    spanishPhrases.every((p) => (p.assessment?.accuracy ?? 0) > 60),
  );

  console.log('\n════════════════════════════════════════════════');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Pipeline test failed:', err);
  process.exit(1);
});

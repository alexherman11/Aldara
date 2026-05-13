import dotenv from 'dotenv';
dotenv.config({ override: true });

import { AzureAssessor } from '../src/pronunciation/azure-assessor.js';
import { chunksToWav } from '../src/pronunciation/wav.js';

/**
 * End-to-end live test of the Azure pronunciation pipeline.
 *
 *   1. Synthesize a known Spanish phrase via Cartesia HTTP API at 16kHz mono PCM
 *   2. Wrap as WAV (the same shape the agent produces from per-turn frames)
 *   3. Hand to AzureAssessor.assess() with es-MX language tag
 *   4. Verify the response: provider, recognized text, plausible scores,
 *      per-word + per-phoneme structure, latency
 *
 * Caveat: TTS-generated audio is "perfect" pronunciation, so all word scores
 * should be very high. This validates the pipeline is wired correctly, not
 * that Azure is sensitive to real learner errors. For the latter you need an
 * actual learner saying the phrase poorly — which is what the agent will
 * produce in a live session.
 */

interface CartesiaPcmResp {
  audio: Buffer;
  sampleRate: number;
  channels: number;
}

async function synthesizeSpanish(text: string): Promise<CartesiaPcmResp> {
  const apiKey = process.env.CARTESIA_API_KEY;
  const voiceId =
    process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c';
  if (!apiKey) throw new Error('CARTESIA_API_KEY missing');

  const startedAt = Date.now();
  const resp = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: text,
      voice: { mode: 'id', id: voiceId },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: 16000,
      },
      language: 'es',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Cartesia HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const ab = await resp.arrayBuffer();
  const ms = Date.now() - startedAt;
  const audio = Buffer.from(ab);
  console.log(
    `[cartesia] synthesized "${text}" → ${audio.length} bytes raw PCM (${(audio.length / 2 / 16000).toFixed(2)}s) in ${ms}ms`,
  );
  return { audio, sampleRate: 16000, channels: 1 };
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  // Reconstruct an Int16Array view over the PCM buffer (zero-copy)
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  return chunksToWav([{ samples, sampleRate, channels }]);
}

async function main() {
  const phrase = 'Tengo un perro grande en mi casa';

  console.log('Live Azure pronunciation pipeline test\n');
  console.log(`Reference text: "${phrase}"\n`);

  console.log('── 1. Cartesia synthesis ──');
  const tts = await synthesizeSpanish(phrase);

  console.log('\n── 2. PCM → WAV ──');
  const wav = pcmToWav(tts.audio, tts.sampleRate, tts.channels);
  console.log(`  WAV buffer: ${wav.length} bytes`);
  console.log(`  Header OK: ${wav.toString('ascii', 0, 4) === 'RIFF'}`);

  console.log('\n── 3. Azure assessment ──');
  const assessor = new AzureAssessor();
  const startedAt = Date.now();
  const result = await assessor.assess({
    audio: wav,
    reference_text: phrase,
    sample_rate: 16000,
    language: 'es-MX',
  });
  const wallMs = Date.now() - startedAt;

  console.log(`  provider:        ${result.provider}`);
  console.log(`  api latency:     ${result.latency_ms}ms`);
  console.log(`  wall-clock:      ${wallMs}ms`);
  console.log(`  recognized_text: "${result.recognized_text ?? '(none)'}"`);
  console.log(
    `  overall:         accuracy=${result.overall.accuracy.toFixed(1)} fluency=${result.overall.fluency.toFixed(1)} completeness=${result.overall.completeness.toFixed(1)} pronunciation=${result.overall.pronunciation.toFixed(1)}`,
  );
  if (result.prosody) {
    console.log(
      `  prosody:         score=${result.prosody.score?.toFixed(1) ?? 'n/a'} errors=${result.prosody.errors.map((e) => e.type).join(',') || 'none'}`,
    );
  } else {
    console.log('  prosody:         (es-MX — Azure prosody is en-US only)');
  }
  console.log(`  words returned:  ${result.words.length}`);
  for (const w of result.words) {
    const phonStr = w.phonemes
      ? ` [${w.phonemes.map((p) => `${p.phoneme}:${Math.round(p.accuracy_score)}`).join(', ')}]`
      : '';
    console.log(
      `    ${w.word.padEnd(14)} acc=${Math.round(w.accuracy_score).toString().padStart(3)} ${w.error_type}${phonStr}`,
    );
  }

  console.log('\n── 4. Verification ──');
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

  check('provider is "azure"', result.provider === 'azure');
  check(
    'recognized_text is non-empty',
    Boolean(result.recognized_text && result.recognized_text.length > 0),
    result.recognized_text,
  );
  check(
    'overall.accuracy is high (TTS audio expected ≥80)',
    result.overall.accuracy >= 80,
    `got ${result.overall.accuracy.toFixed(1)}`,
  );
  check(
    'word count matches reference (7 words)',
    result.words.length === phrase.split(/\s+/).length,
    `got ${result.words.length}`,
  );
  check(
    'every word has phoneme-level scores',
    result.words.every((w) => (w.phonemes?.length ?? 0) > 0),
  );
  check(
    'every word accuracy is high',
    result.words.every((w) => w.accuracy_score >= 70),
  );
  check('latency is reasonable (<10s)', result.latency_ms < 10_000);

  console.log('\n════════════════════════════════════════════════');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Live Azure test failed:', err);
  process.exit(1);
});

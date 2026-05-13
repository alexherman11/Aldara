import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { writeFileSync } from 'node:fs';
import { AzureAssessor } from '../src/pronunciation/azure-assessor.js';
import { chunksToWav } from '../src/pronunciation/wav.js';
import { formatAnnotation } from '../src/pronunciation/types.js';
import type { PronunciationAssessment } from '../src/pronunciation/types.js';

/**
 * Expanded pronunciation stress test (Phase 12 prep).
 *
 * Five test groups, each isolating one robustness dimension:
 *
 *   A. CROSS-VOICE clean — same Spanish phrase synthesized through 5 Cartesia
 *      voices. Expectation: scores cluster high across voices. Failure here
 *      means Azure is fragile to voice character — a deal-breaker for production.
 *
 *   B. ENGLISH-TRAINED voices reading Spanish — OpenAI TTS voices (alloy, echo,
 *      nova) are trained on English and produce noticeably English-flavored
 *      Spanish, which is a closer-to-real-world L1 simulation than Cartesia
 *      with mutated input text. Expectation: scores cluster lower than Cartesia.
 *
 *   C. AGGRESSIVE garbling — input-text mutations beyond v1: full phonetic
 *      respellings, missing accents, dropped phonemes. Whether Cartesia
 *      cooperates is part of what we measure.
 *
 *   D. NOISE robustness — additive white Gaussian noise at three SNR levels
 *      (20 dB clean office, 10 dB busy cafe, 0 dB very degraded). Expectation:
 *      scores degrade gracefully without crash; engine doesn't claim 95% on
 *      noise-corrupted audio.
 *
 *   E. SAMPLE-RATE robustness — downsample to 8 kHz (phone quality). Verifies
 *      the path doesn't break when audio comes from a low-quality mic.
 */

const SPANISH_PHRASE = 'Hola, me llamo Carlos y vivo en Madrid';

// ── TTS providers ──────────────────────────────────────────────────

const CARTESIA_VOICES = [
  { id: '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c', label: 'cartesia-default' },
  { id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', label: 'cartesia-skylar' },
  { id: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b', label: 'cartesia-brooke' },
  { id: '47c38ca4-5f35-497b-b1a3-415245fb35e1', label: 'cartesia-daniel' },
  { id: 'f9836c6e-a0bd-460e-9d3c-f7299fa60f94', label: 'cartesia-caroline' },
];

const OPENAI_VOICES = ['alloy', 'echo', 'nova'] as const;

async function cartesiaSynth(
  text: string,
  voiceId: string,
): Promise<{ pcm: Buffer; sampleRate: number }> {
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
      voice: { mode: 'id', id: voiceId },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      language: 'es',
    }),
  });
  if (!resp.ok) throw new Error(`Cartesia HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const ab = await resp.arrayBuffer();
  return { pcm: Buffer.from(ab), sampleRate: 16000 };
}

async function openaiSynth(
  text: string,
  voice: (typeof OPENAI_VOICES)[number],
): Promise<{ pcm: Buffer; sampleRate: number }> {
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice,
      input: text,
      response_format: 'pcm',
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const ab = await resp.arrayBuffer();
  return { pcm: Buffer.from(ab), sampleRate: 24000 };
}

// ── Audio manipulation utilities ───────────────────────────────────

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  return chunksToWav([{ samples, sampleRate, channels: 1 }]);
}

/** Add white Gaussian noise at a target SNR (in dB). */
function addNoise(pcm: Buffer, snrDb: number): Buffer {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  // Signal RMS power
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const signalPower = sumSq / samples.length;

  // Target noise power from SNR
  const noisePower = signalPower / Math.pow(10, snrDb / 10);
  const noiseStd = Math.sqrt(noisePower);

  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Box-Muller for Gaussian
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const noisy = samples[i] + n * noiseStd;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(noisy)));
  }
  return Buffer.from(out.buffer);
}

/** Naive downsample by integer factor (decimation with simple averaging). */
function downsample(pcm: Buffer, srcRate: number, dstRate: number): Buffer {
  if (srcRate === dstRate) return pcm;
  const factor = srcRate / dstRate;
  if (!Number.isInteger(factor)) {
    throw new Error(`Non-integer downsample factor ${factor} not supported here`);
  }
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const outLen = Math.floor(samples.length / factor);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += samples[i * factor + j];
    out[i] = Math.round(sum / factor);
  }
  return Buffer.from(out.buffer);
}

// ── Test runner ────────────────────────────────────────────────────

interface Row {
  group: string;
  label: string;
  reference: string;
  audio_duration_sec?: number;
  sample_rate?: number;
  recognized?: string;
  acc?: number;
  pron?: number;
  fluency?: number;
  completeness?: number;
  flagged_words: string[];
  divergence: boolean;
  monotone: boolean;
  latency_ms?: number;
  annotation?: string | null;
  status: 'ok' | 'error';
  reason?: string;
}

function normalize(s: string | undefined): string {
  return (s || '').replace(/[.,!?;:¿¡]/g, '').trim().toLowerCase();
}

async function score(
  assessor: AzureAssessor,
  group: string,
  label: string,
  audio: Buffer,
  sampleRate: number,
  reference: string,
): Promise<Row> {
  try {
    const wav = pcmToWav(audio, sampleRate);
    const result = await assessor.assess({
      audio: wav,
      reference_text: reference,
      sample_rate: sampleRate,
      language: 'es-MX',
    });
    const flagged = result.words.filter(
      (w) => w.accuracy_score < 70 || w.error_type !== 'None',
    );
    const divergence = normalize(result.recognized_text) !== normalize(reference);
    const monotone = result.prosody?.errors.some((e) => e.type === 'Monotone') ?? false;
    return {
      group,
      label,
      reference,
      audio_duration_sec: Number((audio.length / 2 / sampleRate).toFixed(2)),
      sample_rate: sampleRate,
      recognized: result.recognized_text,
      acc: result.overall.accuracy,
      pron: result.overall.pronunciation,
      fluency: result.overall.fluency,
      completeness: result.overall.completeness,
      flagged_words: flagged.map(
        (w) => `${w.word}(${Math.round(w.accuracy_score)})`,
      ),
      divergence,
      monotone,
      latency_ms: result.latency_ms,
      annotation: formatAnnotation(result),
      status: 'ok',
    };
  } catch (err) {
    return {
      group,
      label,
      reference,
      flagged_words: [],
      divergence: false,
      monotone: false,
      status: 'error',
      reason: String(err).slice(0, 200),
    };
  }
}

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return str.length >= n
    ? str.slice(0, n)
    : right
      ? str + ' '.repeat(n - str.length)
      : ' '.repeat(n - str.length) + str;
}

function logRow(r: Row): void {
  const accStr = r.acc !== undefined ? r.acc.toFixed(0) : '-';
  const pronStr = r.pron !== undefined ? r.pron.toFixed(0) : '-';
  const flagsStr = r.flagged_words.length.toString();
  const divStr = r.divergence ? 'Y' : 'N';
  const latStr = r.latency_ms?.toString() ?? '-';
  console.log(
    `  ${pad(r.label, 26, true)} acc=${pad(accStr, 3)} pron=${pad(pronStr, 3)} ` +
      `flags=${pad(flagsStr, 1)} div=${pad(divStr, 1)} lat=${pad(latStr, 4)}ms ` +
      (r.flagged_words.length > 0 ? `→ ${r.flagged_words.slice(0, 4).join(', ')}` : ''),
  );
  if (r.divergence && r.recognized) {
    console.log(`     ref: "${r.reference}"`);
    console.log(`     rec: "${r.recognized}"`);
  }
  if (r.status === 'error') console.log(`     ERROR: ${r.reason}`);
}

// ── Main test groups ───────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Pronunciation stress test v2 — robustness across conditions');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Reference phrase: "${SPANISH_PHRASE}"\n`);

  const assessor = new AzureAssessor();
  const rows: Row[] = [];

  // ── Group A: Cartesia voice variance ────────────────────────────
  console.log('── A. CROSS-VOICE clean (Cartesia, language:es) ──');
  for (const v of CARTESIA_VOICES) {
    try {
      const { pcm, sampleRate } = await cartesiaSynth(SPANISH_PHRASE, v.id);
      const r = await score(assessor, 'A', v.label, pcm, sampleRate, SPANISH_PHRASE);
      rows.push(r);
      logRow(r);
    } catch (err) {
      console.log(`  ${v.label}: ERROR — ${String(err).slice(0, 150)}`);
    }
  }

  // ── Group B: OpenAI English-trained voices ──────────────────────
  console.log('\n── B. ENGLISH-TRAINED voices reading Spanish (OpenAI tts-1) ──');
  for (const v of OPENAI_VOICES) {
    try {
      const { pcm, sampleRate } = await openaiSynth(SPANISH_PHRASE, v);
      const r = await score(assessor, 'B', `openai-${v}`, pcm, sampleRate, SPANISH_PHRASE);
      rows.push(r);
      logRow(r);
    } catch (err) {
      console.log(`  openai-${v}: ERROR — ${String(err).slice(0, 150)}`);
    }
  }

  // ── Group C: Aggressive garbling via input-text mutation ────────
  console.log('\n── C. AGGRESSIVE garbling (full phonetic respelling) ──');
  const garbledCases = [
    { label: 'no-accents', synth: 'Hola me llamo Carlos y vivo en Madrid' },
    { label: 'english-respelling', synth: 'Oh-lah may yah-moh Car-lohs ee vee-voh en Mah-dreed' },
    { label: 'dropped-syllables', synth: 'Hla me lmo Crls y vvo en Mdrd' },
    { label: 'doubled-vowels', synth: 'Hoolaa mee llaamoo Caarlooos y veeevooo eeen Maadriiid' },
    { label: 'wrong-stress', synth: 'hoLA me LLAmo carLOS y viVO en maDRID' },
  ];
  for (const c of garbledCases) {
    try {
      const { pcm, sampleRate } = await cartesiaSynth(c.synth, CARTESIA_VOICES[0].id);
      const r = await score(assessor, 'C', c.label, pcm, sampleRate, SPANISH_PHRASE);
      rows.push(r);
      logRow(r);
    } catch (err) {
      console.log(`  ${c.label}: ERROR — ${String(err).slice(0, 150)}`);
    }
  }

  // ── Group D: Noise robustness ───────────────────────────────────
  console.log('\n── D. NOISE injection (white Gaussian @ SNR levels) ──');
  // Synthesize once with the clean voice, then add varying noise.
  const cleanForNoise = await cartesiaSynth(SPANISH_PHRASE, CARTESIA_VOICES[0].id);
  for (const snr of [30, 20, 10, 5, 0]) {
    const noisy = addNoise(cleanForNoise.pcm, snr);
    const r = await score(
      assessor,
      'D',
      `snr-${snr}dB`,
      noisy,
      cleanForNoise.sampleRate,
      SPANISH_PHRASE,
    );
    rows.push(r);
    logRow(r);
  }

  // ── Group E: Sample-rate robustness ─────────────────────────────
  console.log('\n── E. SAMPLE-RATE robustness ──');
  // 16 kHz → 8 kHz (phone quality)
  const downsampled = downsample(cleanForNoise.pcm, 16000, 8000);
  const r8k = await score(assessor, 'E', '8kHz-phone', downsampled, 8000, SPANISH_PHRASE);
  rows.push(r8k);
  logRow(r8k);

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');

  for (const g of ['A', 'B', 'C', 'D', 'E']) {
    const grp = rows.filter((r) => r.group === g && r.status === 'ok');
    if (grp.length === 0) continue;
    const accs = grp.map((r) => r.acc ?? 0);
    const avg = accs.reduce((a, b) => a + b, 0) / accs.length;
    const min = Math.min(...accs);
    const max = Math.max(...accs);
    const lats = grp.map((r) => r.latency_ms ?? 0);
    const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;
    console.log(
      `  Group ${g}: n=${grp.length} avg_acc=${avg.toFixed(1)} ` +
        `range=[${min.toFixed(0)}, ${max.toFixed(0)}] avg_latency=${avgLat.toFixed(0)}ms`,
    );
  }

  // Cross-group sensitivity comparison
  const groupAAvg =
    rows.filter((r) => r.group === 'A' && r.acc !== undefined)
      .map((r) => r.acc!)
      .reduce((a, b, _, arr) => a + b / arr.length, 0);
  const groupBAvg =
    rows.filter((r) => r.group === 'B' && r.acc !== undefined)
      .map((r) => r.acc!)
      .reduce((a, b, _, arr) => a + b / arr.length, 0);
  console.log(
    `\n  Cross-engine sensitivity (Cartesia clean A vs OpenAI-EN B): ${(groupAAvg - groupBAvg).toFixed(1)} points`,
  );

  writeFileSync(
    'phase12-stress-v2-results.json',
    JSON.stringify(rows, null, 2),
  );
  console.log('\nFull results: phase12-stress-v2-results.json');

  process.exit(0);
}

main().catch((err) => {
  console.error('Stress v2 fatal:', err);
  process.exit(1);
});

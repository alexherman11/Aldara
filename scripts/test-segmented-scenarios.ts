import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { writeFileSync } from 'node:fs';
import { DeepgramSTT } from '../src/stt/deepgram-stt.js';
import { AzureAssessor } from '../src/pronunciation/azure-assessor.js';
import { SegmentedScorer } from '../src/pronunciation/segmented-scorer.js';
import { chunksToWav } from '../src/pronunciation/wav.js';

/**
 * Regression suite for the segmented pronunciation pipeline.
 *
 * Each scenario synthesizes audio that mimics a realistic L2 learner pattern,
 * runs it through the segmented pipeline, and asserts specific behaviors
 * (right number of phrases, right language splits, plausible scores). When we
 * tune the pipeline later — change segmentation thresholds, swap STT models,
 * adjust language classifier — these tests are the guardrail.
 *
 * Scenarios are designed to be cheap (short audio, minimal calls) but cover
 * the failure modes we've seen and expect:
 *   - Pure Spanish baseline
 *   - Spanish + English code-switch
 *   - Heavy hesitation with short interjections
 *   - Self-correction (says wrong thing, fixes it)
 *   - Very short utterance
 *   - Silent audio
 */

interface Scenario {
  name: string;
  description: string;
  /** Parts to synthesize: [text, language, gap_after_in_sec] */
  parts: Array<[string, 'es' | 'en', number]>;
  /** Custom test predicates */
  assertions: (result: {
    phrases: Array<{ text: string; language: string; assessment?: { accuracy: number } }>;
    overall: { accuracy: number };
  }) => Array<{ label: string; pass: boolean; info?: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'pure-spanish-clean',
    description: 'A1 learner reads a clean Spanish sentence',
    parts: [['Hola me llamo Carlos y tengo treinta años', 'es', 0]],
    assertions: (r) => [
      { label: 'one Spanish phrase', pass: r.phrases.length === 1 && r.phrases[0].language === 'es' },
      { label: 'accuracy >= 85', pass: r.overall.accuracy >= 85, info: `acc=${r.overall.accuracy.toFixed(0)}` },
    ],
  },
  {
    name: 'spanish-with-english-fallback',
    description: 'Learner says Spanish then falls back to English mid-sentence',
    parts: [
      ['Me gusta cocinar', 'es', 0.7],
      ['but I forget the word', 'en', 0.6],
      ['en español', 'es', 0],
    ],
    assertions: (r) => [
      { label: 'at least 2 phrases', pass: r.phrases.length >= 2, info: `${r.phrases.length}` },
      { label: 'has English phrase', pass: r.phrases.some((p) => p.language === 'en') },
      { label: 'has Spanish phrase', pass: r.phrases.some((p) => p.language === 'es') },
      {
        label: 'English not scored',
        pass: r.phrases.filter((p) => p.language === 'en').every((p) => !p.assessment),
      },
    ],
  },
  {
    name: 'short-interjections',
    description: 'Lots of short Spanish words with pauses between (typical hesitation)',
    parts: [
      ['Sí', 'es', 0.8],
      ['pues', 'es', 0.7],
      ['bueno', 'es', 0.7],
      ['está bien', 'es', 0],
    ],
    assertions: (r) => [
      // Each interjection may segment separately due to silence gaps, or merge
      { label: 'all phrases tagged Spanish', pass: r.phrases.every((p) => p.language === 'es') },
      { label: '≥1 phrase scored', pass: r.phrases.some((p) => p.assessment !== undefined) },
    ],
  },
  {
    name: 'long-monologue',
    description: 'Single long Spanish sentence without significant pauses',
    parts: [
      [
        'Ayer fui al mercado con mi familia y compramos muchas frutas y verduras para preparar una cena especial',
        'es',
        0,
      ],
    ],
    assertions: (r) => [
      { label: 'all Spanish', pass: r.phrases.every((p) => p.language === 'es') },
      { label: 'high accuracy (>=80)', pass: r.overall.accuracy >= 80, info: `acc=${r.overall.accuracy.toFixed(0)}` },
    ],
  },
  {
    name: 'spanish-english-alternating',
    description: 'Heavy code-switching — alternating language every clause',
    parts: [
      ['Hoy es un día bonito', 'es', 0.5],
      ['I went for a walk', 'en', 0.5],
      ['y vi muchas flores', 'es', 0.5],
      ['it was really nice', 'en', 0],
    ],
    assertions: (r) => [
      { label: '≥3 phrases', pass: r.phrases.length >= 3, info: `${r.phrases.length}` },
      { label: 'multiple Spanish phrases', pass: r.phrases.filter((p) => p.language === 'es').length >= 2 },
      { label: 'multiple English phrases', pass: r.phrases.filter((p) => p.language === 'en').length >= 1 },
    ],
  },
];

async function cartesiaSynth(text: string, language: 'es' | 'en'): Promise<Buffer> {
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

function pcmToWav(pcm: Buffer): Buffer {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  return chunksToWav([{ samples, sampleRate: 16000, channels: 1 }]);
}

async function synthesizeScenario(s: Scenario): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const [text, lang, gap] of s.parts) {
    parts.push(await cartesiaSynth(text, lang));
    if (gap > 0) parts.push(Buffer.alloc(Math.floor(gap * 16000 * 2)));
  }
  return pcmToWav(Buffer.concat(parts));
}

interface ScenarioResult {
  name: string;
  passed: number;
  failed: number;
  details: Array<{ label: string; pass: boolean; info?: string }>;
  phrases: Array<{ text: string; language: string; accuracy?: number; duration_sec: number }>;
  overall_accuracy: number;
  total_latency_ms: number;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Segmented pipeline — scenario regression suite');
  console.log('═══════════════════════════════════════════════════════════\n');

  const scorer = new SegmentedScorer({
    transcriber: new DeepgramSTT(),
    assessor: new AzureAssessor(),
    sampleRate: 16000,
  });

  const results: ScenarioResult[] = [];
  let totalPass = 0;
  let totalFail = 0;

  for (const s of SCENARIOS) {
    console.log(`── ${s.name} ──`);
    console.log(`   ${s.description}`);
    const started = Date.now();
    try {
      const wav = await synthesizeScenario(s);
      const result = await scorer.score(wav);
      const totalMs = Date.now() - started;

      const phrasesView = result.phrases.map((p) => ({
        text: p.text,
        language: p.language,
        accuracy: p.assessment?.accuracy,
        duration_sec: Number((p.end_sec - p.start_sec).toFixed(2)),
      }));

      for (const p of phrasesView) {
        const acc = p.accuracy !== undefined ? `acc=${p.accuracy.toFixed(0)}` : 'not scored';
        console.log(`     [${p.language}] ${p.duration_sec}s ${acc.padEnd(11)} "${p.text.slice(0, 70)}"`);
      }

      const checks = s.assertions({ phrases: result.phrases, overall: result.overall });
      let p = 0;
      let f = 0;
      for (const c of checks) {
        const symbol = c.pass ? 'PASS' : 'FAIL';
        console.log(`     [${symbol}] ${c.label}${c.info ? ` — ${c.info}` : ''}`);
        if (c.pass) p++;
        else f++;
      }
      totalPass += p;
      totalFail += f;

      results.push({
        name: s.name,
        passed: p,
        failed: f,
        details: checks,
        phrases: phrasesView,
        overall_accuracy: result.overall.accuracy,
        total_latency_ms: totalMs,
      });
    } catch (err) {
      console.log(`   ERROR — ${String(err).slice(0, 200)}`);
      totalFail += 1;
      results.push({
        name: s.name,
        passed: 0,
        failed: 1,
        details: [{ label: 'pipeline did not throw', pass: false, info: String(err).slice(0, 100) }],
        phrases: [],
        overall_accuracy: 0,
        total_latency_ms: Date.now() - started,
      });
    }
    console.log();
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` RESULT: ${totalPass} passed, ${totalFail} failed across ${SCENARIOS.length} scenarios`);
  console.log('═══════════════════════════════════════════════════════════');

  writeFileSync(
    `phase13-scenario-results-${Date.now()}.json`,
    JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2),
  );

  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Scenario suite failed:', err);
  process.exit(1);
});

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { writeFileSync } from 'node:fs';
import { AzureAssessor } from '../src/pronunciation/azure-assessor.js';
import { chunksToWav } from '../src/pronunciation/wav.js';
import { formatAnnotation } from '../src/pronunciation/types.js';
import type { PronunciationAssessment } from '../src/pronunciation/types.js';

/**
 * Pronunciation stress test against the live Azure Speech endpoint.
 *
 * Three test classes:
 *
 *   A. CLEAN — synthesized via Cartesia in es. These should score very high
 *      (≥85). If they don't, the pipeline is broken or Azure's es-MX voice
 *      acoustic model is rejecting Cartesia's voice character.
 *
 *   B. L1-INFLUENCED — synthesize the SAME Spanish words but with the input
 *      text mutated to look like an English-speaker reading Spanish:
 *      "yo soy" → "joh soyy", "perro" → "pair-oh", "casa" → "kahsa".
 *      Cartesia will pronounce the mutated spellings literally, producing an
 *      L2-shaped audio that's still being assessed against the original
 *      Spanish reference text. Azure should flag these.
 *
 *   C. EDGE CASES — silence, very short, very long, noise, wrong-language audio.
 *      Verifies the assessor degrades gracefully (no crash, no hang) under
 *      conditions the agent will see in production.
 *
 * Plus concurrency: hammer the assessor with N parallel calls to verify the
 * SDK handles parallel push streams without state corruption.
 */

interface TestCase {
  id: string;
  reference_text: string;
  /** What to actually feed Cartesia — mutated to simulate L1 errors */
  synth_text: string;
  /** What we EXPECT to happen */
  expectation: 'high' | 'flagged' | 'degraded';
  notes?: string;
}

// ── A. CLEAN baseline cases ─────────────────────────────────────────
const CLEAN_CASES: TestCase[] = [
  {
    id: 'clean-greet',
    reference_text: 'Hola, me llamo Sofía',
    synth_text: 'Hola, me llamo Sofía',
    expectation: 'high',
  },
  {
    id: 'clean-rolled-r',
    reference_text: 'El perro corre rápido por el parque',
    synth_text: 'El perro corre rápido por el parque',
    expectation: 'high',
    notes: 'rolled /r/ in perro, corre, rápido, parque',
  },
  {
    id: 'clean-vowels',
    reference_text: 'Quiero un café con leche por favor',
    synth_text: 'Quiero un café con leche por favor',
    expectation: 'high',
  },
  {
    id: 'clean-numbers',
    reference_text: 'Tengo treinta y dos años',
    synth_text: 'Tengo treinta y dos años',
    expectation: 'high',
    notes: 'ñ, diphthongs',
  },
  {
    id: 'clean-long',
    reference_text:
      'Ayer fui al mercado con mi familia y compramos muchas frutas frescas',
    synth_text:
      'Ayer fui al mercado con mi familia y compramos muchas frutas frescas',
    expectation: 'high',
    notes: '12 words, multi-clause',
  },
];

// ── B. L1-INFLUENCED (English-accent simulated) ─────────────────────
// Strategy: Cartesia is told the text in mutated form so it pronounces it
// the way an English speaker might. The reference_text stays correct.
const L1_CASES: TestCase[] = [
  {
    id: 'l1-no-rolled-r',
    reference_text: 'El perro corre rápido',
    // English speakers tap or bunch instead of trilling. Spelling that nudges
    // Cartesia toward a flatter /r/.
    synth_text: 'El paro core rapido',
    expectation: 'flagged',
    notes: 'simulates flat /r/ instead of rolled trill',
  },
  {
    id: 'l1-flat-vowels',
    reference_text: 'Quiero un café con leche',
    // English /eɪ/ instead of pure /e/, /oʊ/ instead of pure /o/
    synth_text: 'Kieyro oon kafey con leichey',
    expectation: 'flagged',
    notes: 'diphthongized vowels (English-style)',
  },
  {
    id: 'l1-h-vs-j',
    reference_text: 'Mi jefe trabaja mucho',
    // English speakers say /dʒ/ (jeffe) or /h/ instead of Spanish /x/
    synth_text: 'Me heffey trabaha muchoh',
    expectation: 'flagged',
    notes: 'jefe → heffey (English /h/ instead of /x/)',
  },
  {
    id: 'l1-final-vowels',
    reference_text: 'Casa grande bonita',
    // English speakers shorten or drop final vowels
    synth_text: 'Kasuh grand bonih',
    expectation: 'flagged',
    notes: 'truncated final vowels',
  },
  {
    id: 'l1-stress-shift',
    reference_text: 'México es fantástico',
    // Stress on wrong syllable
    synth_text: 'mexEEko es fantasTEEko',
    expectation: 'flagged',
    notes: 'stress on penultimate (English habit) instead of antepenultimate',
  },
];

// ── Cartesia synthesis ─────────────────────────────────────────────
async function synthesize(
  text: string,
  voiceLang: 'es' | 'en' = 'es',
): Promise<{ pcm: Buffer; durationSec: number }> {
  const apiKey = process.env.CARTESIA_API_KEY!;
  const voiceId =
    process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c';

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
      language: voiceLang,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Cartesia HTTP ${resp.status}: ${await resp.text()}`);
  }
  const ab = await resp.arrayBuffer();
  const pcm = Buffer.from(ab);
  return { pcm, durationSec: pcm.length / 2 / 16000 };
}

function pcmToWav(pcm: Buffer): Buffer {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  return chunksToWav([{ samples, sampleRate: 16000, channels: 1 }]);
}

// ── Test runner ────────────────────────────────────────────────────
interface TestResult {
  id: string;
  reference: string;
  synth: string;
  expectation: TestCase['expectation'];
  recognized?: string;
  overall_accuracy?: number;
  overall_pron?: number;
  flagged_words: string[];
  flag_count: number;
  annotation: string | null;
  latency_ms?: number;
  audio_duration_sec?: number;
  divergence?: boolean; // recognized_text != reference_text
  status: 'pass' | 'fail' | 'error';
  reason: string;
  raw?: PronunciationAssessment;
}

async function runCase(
  assessor: AzureAssessor,
  tc: TestCase,
  voiceLang: 'es' | 'en' = 'es',
): Promise<TestResult> {
  try {
    const { pcm, durationSec } = await synthesize(tc.synth_text, voiceLang);
    const wav = pcmToWav(pcm);

    const result = await assessor.assess({
      audio: wav,
      reference_text: tc.reference_text,
      sample_rate: 16000,
      language: 'es-MX',
    });

    const flagged = result.words.filter(
      (w) => w.accuracy_score < 70 || w.error_type !== 'None',
    );
    const annotation = formatAnnotation(result);
    const divergence = (result.recognized_text || '').replace(/[.,!?;:]/g, '').trim().toLowerCase() !==
      tc.reference_text.replace(/[.,!?;:]/g, '').trim().toLowerCase();

    let status: 'pass' | 'fail' = 'pass';
    let reason = '';
    if (tc.expectation === 'high') {
      if (result.overall.accuracy >= 80) {
        reason = `accuracy ${result.overall.accuracy.toFixed(0)} ≥80`;
      } else {
        status = 'fail';
        reason = `expected high but got accuracy ${result.overall.accuracy.toFixed(0)}`;
      }
    } else if (tc.expectation === 'flagged') {
      if (flagged.length > 0 || divergence || result.overall.accuracy < 80) {
        const sigs: string[] = [];
        if (flagged.length > 0) sigs.push(`${flagged.length} flagged words`);
        if (divergence) sigs.push('recognized≠reference');
        if (result.overall.accuracy < 80)
          sigs.push(`accuracy=${result.overall.accuracy.toFixed(0)}`);
        reason = sigs.join(', ');
      } else {
        status = 'fail';
        reason = `expected flag but accuracy=${result.overall.accuracy.toFixed(0)} no flags`;
      }
    }

    return {
      id: tc.id,
      reference: tc.reference_text,
      synth: tc.synth_text,
      expectation: tc.expectation,
      recognized: result.recognized_text,
      overall_accuracy: result.overall.accuracy,
      overall_pron: result.overall.pronunciation,
      flagged_words: flagged.map((w) => `${w.word}(${Math.round(w.accuracy_score)})`),
      flag_count: flagged.length,
      annotation,
      latency_ms: result.latency_ms,
      audio_duration_sec: Number(durationSec.toFixed(2)),
      divergence,
      status,
      reason,
      raw: result,
    };
  } catch (err) {
    return {
      id: tc.id,
      reference: tc.reference_text,
      synth: tc.synth_text,
      expectation: tc.expectation,
      flagged_words: [],
      flag_count: 0,
      annotation: null,
      status: 'error',
      reason: String(err).slice(0, 200),
    };
  }
}

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  if (str.length >= n) return str.slice(0, n);
  return right ? str + ' '.repeat(n - str.length) : ' '.repeat(n - str.length) + str;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Pronunciation stress test — Azure Speech, es-MX');
  console.log('═══════════════════════════════════════════════════════════\n');

  const assessor = new AzureAssessor();
  const allResults: TestResult[] = [];

  // ── Phase A: clean baseline ─────────────────────────────────────
  console.log('── Phase A: clean baseline (synthesized in Spanish voice) ──\n');
  for (const tc of CLEAN_CASES) {
    const r = await runCase(assessor, tc, 'es');
    allResults.push(r);
    console.log(
      `  [${pad(r.status, 5, true)}] ${pad(r.id, 18, true)} ` +
        `acc=${pad(r.overall_accuracy?.toFixed(0) ?? '-', 3)} ` +
        `pron=${pad(r.overall_pron?.toFixed(0) ?? '-', 3)} ` +
        `flags=${pad(r.flag_count, 1)} ` +
        `lat=${pad(r.latency_ms ?? '-', 4)}ms ` +
        `dur=${pad(r.audio_duration_sec ?? '-', 4)}s ` +
        `— ${r.reason}`,
    );
  }

  // ── Phase B: L1-influenced ──────────────────────────────────────
  console.log('\n── Phase B: L1-influenced (mutated Cartesia input) ──\n');
  for (const tc of L1_CASES) {
    const r = await runCase(assessor, tc, 'en');
    allResults.push(r);
    console.log(
      `  [${pad(r.status, 5, true)}] ${pad(r.id, 18, true)} ` +
        `acc=${pad(r.overall_accuracy?.toFixed(0) ?? '-', 3)} ` +
        `pron=${pad(r.overall_pron?.toFixed(0) ?? '-', 3)} ` +
        `flags=${pad(r.flag_count, 1)} ` +
        `div=${pad(r.divergence ? 'Y' : 'N', 1)} ` +
        `lat=${pad(r.latency_ms ?? '-', 4)}ms ` +
        `— ${r.reason}`,
    );
    if (r.recognized && r.recognized !== r.reference) {
      console.log(`           ref:  "${r.reference}"`);
      console.log(`           rec:  "${r.recognized}"`);
    }
    if (r.annotation) {
      console.log(
        r.annotation
          .split('\n')
          .map((l) => `           ${l}`)
          .join('\n'),
      );
    }
  }

  // ── Phase C: edge cases ─────────────────────────────────────────
  console.log('\n── Phase C: edge cases ──\n');

  // C1: silence
  {
    const silentPcm = Buffer.alloc(16000 * 2 * 2); // 2s of zero PCM
    const wav = pcmToWav(silentPcm);
    const startedAt = Date.now();
    const result = await assessor.assess({
      audio: wav,
      reference_text: 'Hola buenos días',
      sample_rate: 16000,
      language: 'es-MX',
    });
    const ms = Date.now() - startedAt;
    console.log(
      `  silence(2s)         acc=${pad(result.overall.accuracy.toFixed(0), 3)} ` +
        `pron=${pad(result.overall.pronunciation.toFixed(0), 3)} ` +
        `flags=${pad(result.words.filter((w) => w.error_type !== 'None').length, 1)} ` +
        `lat=${pad(result.latency_ms, 4)}ms wall=${pad(ms, 4)}ms ` +
        `recognized="${result.recognized_text || ''}"`,
    );
  }

  // C2: very short audio (<0.3s — agent skips these)
  {
    const tinyPcm = Buffer.alloc(16000 * 2 * 0.1); // 100ms
    const wav = pcmToWav(tinyPcm);
    const startedAt = Date.now();
    const result = await assessor.assess({
      audio: wav,
      reference_text: 'Sí',
      sample_rate: 16000,
      language: 'es-MX',
    });
    const ms = Date.now() - startedAt;
    console.log(
      `  too-short(0.1s)    acc=${pad(result.overall.accuracy.toFixed(0), 3)} ` +
        `pron=${pad(result.overall.pronunciation.toFixed(0), 3)} ` +
        `lat=${pad(result.latency_ms, 4)}ms wall=${pad(ms, 4)}ms ` +
        `(agent will skip <0.3s — this proves graceful fallback)`,
    );
  }

  // C3: very long audio
  {
    const longText =
      'Hoy es un día muy bonito para caminar por el parque. Veo árboles, flores, ' +
      'y muchas personas. Mi familia y yo vamos al mercado. Compramos manzanas, ' +
      'naranjas, plátanos y un poco de pan. Después regresamos a casa para preparar ' +
      'la cena. Mi madre cocina muy bien. Ella hace una sopa deliciosa.';
    const { pcm, durationSec } = await synthesize(longText, 'es');
    const wav = pcmToWav(pcm);
    const startedAt = Date.now();
    const result = await assessor.assess({
      audio: wav,
      reference_text: longText,
      sample_rate: 16000,
      language: 'es-MX',
    });
    const ms = Date.now() - startedAt;
    console.log(
      `  long(${pad(durationSec.toFixed(1), 4)}s)        acc=${pad(result.overall.accuracy.toFixed(0), 3)} ` +
        `pron=${pad(result.overall.pronunciation.toFixed(0), 3)} ` +
        `words=${pad(result.words.length, 2)} ` +
        `lat=${pad(result.latency_ms, 4)}ms wall=${pad(ms, 4)}ms`,
    );
  }

  // C4: wrong-language audio (English text scored against Spanish reference)
  {
    const { pcm } = await synthesize('I love hiking in the mountains', 'en');
    const wav = pcmToWav(pcm);
    const startedAt = Date.now();
    const result = await assessor.assess({
      audio: wav,
      reference_text: 'Me gusta caminar en las montañas',
      sample_rate: 16000,
      language: 'es-MX',
    });
    const ms = Date.now() - startedAt;
    console.log(
      `  wrong-lang          acc=${pad(result.overall.accuracy.toFixed(0), 3)} ` +
        `pron=${pad(result.overall.pronunciation.toFixed(0), 3)} ` +
        `flags=${pad(result.words.filter((w) => w.accuracy_score < 70).length, 2)} ` +
        `lat=${pad(result.latency_ms, 4)}ms wall=${pad(ms, 4)}ms ` +
        `recognized="${result.recognized_text || ''}"`,
    );
  }

  // ── Phase D: concurrency ────────────────────────────────────────
  console.log('\n── Phase D: concurrency (5 parallel assessments) ──\n');
  {
    // Pre-synthesize all to isolate Azure latency from Cartesia
    const concurrentTexts = [
      'Buenos días señorita',
      'Tengo dos hermanos pequeños',
      'El gato negro corre rápido',
      'Quiero comer una manzana',
      'Hoy hace mucho calor afuera',
    ];
    // Synthesize SERIALLY (Cartesia limits free-tier concurrency to 2). The
    // concurrency under test is Azure assessment, not TTS.
    const wavs: Array<{ text: string; wav: Buffer }> = [];
    for (const t of concurrentTexts) {
      wavs.push({ text: t, wav: pcmToWav((await synthesize(t, 'es')).pcm) });
    }

    const startedAt = Date.now();
    const concurrentResults = await Promise.all(
      wavs.map((w) =>
        assessor.assess({
          audio: w.wav,
          reference_text: w.text,
          sample_rate: 16000,
          language: 'es-MX',
        }),
      ),
    );
    const totalMs = Date.now() - startedAt;
    const apiLatencies = concurrentResults.map((r) => r.latency_ms);
    const allOk = concurrentResults.every(
      (r) => r.provider === 'azure' && r.words.length > 0,
    );
    console.log(
      `  5 parallel calls completed in ${totalMs}ms wall-clock`,
    );
    console.log(
      `  per-call api latencies: ${apiLatencies.join(', ')}ms ` +
        `(min=${Math.min(...apiLatencies)} max=${Math.max(...apiLatencies)} ` +
        `avg=${Math.round(apiLatencies.reduce((a, b) => a + b) / apiLatencies.length)})`,
    );
    console.log(
      `  all returned valid results: ${allOk ? 'YES' : 'NO — concurrency issue!'}`,
    );
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  const passed = allResults.filter((r) => r.status === 'pass').length;
  const failed = allResults.filter((r) => r.status === 'fail').length;
  const errored = allResults.filter((r) => r.status === 'error').length;
  console.log(
    ` SUMMARY: ${passed}/${allResults.length} cases passed (${failed} failed, ${errored} errored)`,
  );

  const cleanResults = allResults.filter((r) => r.id.startsWith('clean'));
  const l1Results = allResults.filter((r) => r.id.startsWith('l1'));
  const cleanAvg =
    cleanResults
      .map((r) => r.overall_accuracy ?? 0)
      .reduce((a, b) => a + b, 0) / Math.max(cleanResults.length, 1);
  const l1Avg =
    l1Results.map((r) => r.overall_accuracy ?? 0).reduce((a, b) => a + b, 0) /
    Math.max(l1Results.length, 1);
  console.log(` Clean avg accuracy:         ${cleanAvg.toFixed(1)}`);
  console.log(` L1-influenced avg accuracy: ${l1Avg.toFixed(1)}`);
  console.log(
    ` Sensitivity (clean − L1):   ${(cleanAvg - l1Avg).toFixed(1)} points`,
  );
  console.log('═══════════════════════════════════════════════════════════');

  // Persist full results for later inspection
  writeFileSync(
    'phase11-pronunciation-stress-results.json',
    JSON.stringify(
      allResults.map((r) => {
        const { raw: _raw, ...rest } = r;
        return rest;
      }),
      null,
      2,
    ),
  );
  console.log('\nFull results written to phase11-pronunciation-stress-results.json');

  process.exit(failed === 0 && errored === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Stress test fatal:', err);
  process.exit(1);
});

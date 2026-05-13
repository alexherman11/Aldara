/**
 * Edge-case tests for formatAnnotation + summarizePronunciationTrends.
 *
 * The prompt-builder tests cover the happy paths. This file pins the awkward
 * corners that would otherwise regress silently:
 *   - clean assessment returns null (no annotation block)
 *   - error_type != 'None' with high score still gets flagged
 *   - low score with error_type 'None' is labeled LowScore
 *   - phoneme hints cap at 3 per word
 *   - divergence alone (no word flags) still surfaces
 *   - prosody=Monotone alone (no other flags) still surfaces
 *   - trend summary needs >= 2 assessments to fire
 *   - trend summary picks recurring phonemes that appear in 2+ words
 *
 * Pure functions only — no network.
 */

import {
  formatAnnotation,
  summarizePronunciationTrends,
  type PronunciationAssessment,
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

function baseAssessment(): PronunciationAssessment {
  return {
    reference_text: 'hola',
    recognized_text: 'hola',
    overall: { accuracy: 95, fluency: 95, completeness: 100, pronunciation: 95 },
    words: [{ word: 'hola', accuracy_score: 95, error_type: 'None' }],
    provider: 'test',
    latency_ms: 0,
  };
}

console.log('── Annotation rendering edge cases ──\n');

// ── 1. Clean assessment returns null ────────────────────────────────
console.log('1. Clean turn returns null (no annotation block)');
check('clean assessment → null', formatAnnotation(baseAssessment()) === null);

// ── 2. error_type != 'None' is flagged even with high score ─────────
console.log('\n2. error_type override (high score, but not "None")');
{
  const a = baseAssessment();
  a.words = [
    {
      word: 'cocinar',
      accuracy_score: 88,
      error_type: 'UnexpectedBreak',
    },
  ];
  const out = formatAnnotation(a);
  check('annotation present', out !== null);
  check('includes UnexpectedBreak label', out !== null && out.includes('UnexpectedBreak'));
}

// ── 3. Low score with error_type 'None' uses LowScore label ─────────
console.log('\n3. Low score with no specific error becomes LowScore');
{
  const a = baseAssessment();
  a.words = [{ word: 'sendero', accuracy_score: 55, error_type: 'None' }];
  const out = formatAnnotation(a);
  check('annotation present', out !== null);
  check('LowScore label used', out !== null && out.includes('LowScore'));
  check('exact score surfaces', out !== null && /sendero: 55/.test(out));
}

// ── 4. Phoneme hint cap at 3 per word ───────────────────────────────
console.log('\n4. Phoneme hints cap at 3 per word');
{
  const a = baseAssessment();
  a.words = [
    {
      word: 'extraordinario',
      accuracy_score: 30,
      error_type: 'Mispronunciation',
      phonemes: [
        { phoneme: 'e', accuracy_score: 40, alternatives: [{ phoneme: 'ɛ', confidence: 0.8 }] },
        { phoneme: 'k', accuracy_score: 45, alternatives: [{ phoneme: 'g', confidence: 0.7 }] },
        { phoneme: 's', accuracy_score: 35, alternatives: [{ phoneme: 'ʃ', confidence: 0.6 }] },
        { phoneme: 't', accuracy_score: 40, alternatives: [{ phoneme: 'θ', confidence: 0.6 }] },
        { phoneme: 'r', accuracy_score: 38, alternatives: [{ phoneme: 'ɾ', confidence: 0.7 }] },
      ],
    },
  ];
  const out = formatAnnotation(a);
  check('annotation present', out !== null);
  const arrows = (out ?? '').match(/\/[^/]+\/ → \/[^/]+\//g) ?? [];
  check(`exactly 3 phoneme arrows surfaced (got ${arrows.length})`, arrows.length === 3);
}

// ── 5. Divergence alone surfaces ────────────────────────────────────
console.log('\n5. STT/assessor divergence with no word flags still surfaces');
{
  const a = baseAssessment();
  a.reference_text = 'mi perro';
  a.recognized_text = 'mi pero'; // engine heard a tap, STT auto-corrected
  a.words = [
    { word: 'mi', accuracy_score: 95, error_type: 'None' },
    { word: 'perro', accuracy_score: 92, error_type: 'None' },
  ];
  const out = formatAnnotation(a);
  check('annotation present', out !== null);
  check(
    'mentions STT/assessor mismatch',
    out !== null && out.includes('STT/assessor mismatch'),
  );
  check(
    'quotes the divergent heard text',
    out !== null && /heard "mi pero"/.test(out),
  );
}

// ── 6. Prosody monotone alone surfaces ─────────────────────────────
console.log('\n6. Monotone prosody alone surfaces');
{
  const a = baseAssessment();
  a.reference_text = 'estoy muy bien';
  a.recognized_text = 'estoy muy bien';
  a.words = [
    { word: 'estoy', accuracy_score: 92, error_type: 'None' },
    { word: 'muy', accuracy_score: 95, error_type: 'None' },
    { word: 'bien', accuracy_score: 90, error_type: 'None' },
  ];
  a.prosody = { score: 40, errors: [{ type: 'Monotone' }] };
  const out = formatAnnotation(a);
  check('annotation present', out !== null);
  check('prosody monotone surfaced', out !== null && out.includes('prosody: monotone'));
}

// ── 7. Threshold parameterization ───────────────────────────────────
console.log('\n7. Threshold parameter — score=72 unflagged at default, flagged at 80');
{
  const a = baseAssessment();
  a.words = [{ word: 'fiesta', accuracy_score: 72, error_type: 'None' }];
  check('default threshold 70 → not flagged', formatAnnotation(a) === null);
  check('threshold 80 → flagged', formatAnnotation(a, 80) !== null);
}

// ── 8. Trend summary: < 2 assessments → null ───────────────────────
console.log('\n8. Trend summary needs at least 2 assessments');
{
  check('zero assessments → null', summarizePronunciationTrends([]) === null);
  check('one assessment → null', summarizePronunciationTrends([baseAssessment()]) === null);
}

// ── 9. Trend summary: persistent /r/ across 3 turns surfaces ───────
console.log('\n9. Trend summary surfaces recurring phoneme weakness');
{
  const makeRTurn = (refText: string, words: string[]): PronunciationAssessment => ({
    reference_text: refText,
    recognized_text: refText,
    overall: { accuracy: 60, fluency: 80, completeness: 100, pronunciation: 60 },
    words: words.map((w) => ({
      word: w,
      accuracy_score: 55,
      error_type: 'Mispronunciation',
      phonemes: [
        { phoneme: 'r', accuracy_score: 30, alternatives: [{ phoneme: 'ɾ', confidence: 0.85 }] },
      ],
    })),
    provider: 'test',
    latency_ms: 0,
  });
  const assessments = [
    makeRTurn('el perro', ['perro']),
    makeRTurn('corre rápido', ['corre', 'rápido']),
    makeRTurn('arrancar el carro', ['arrancar', 'carro']),
  ];
  const summary = summarizePronunciationTrends(assessments);
  check('trend summary fires', summary !== null);
  check('mentions phoneme /r/', summary !== null && /\/r\//.test(summary));
  check(
    'mentions multiple example words',
    summary !== null &&
      /(perro|corre|rápido|arrancar|carro)/.test(summary) &&
      summary.split(/(perro|corre|rápido|arrancar|carro)/g).length >= 4,
  );
}

// ── 10. Trend summary: one-off blip below 2-occurrence threshold ───
console.log('\n10. One-off phoneme weakness does NOT trend');
{
  const cleanTurn = (refText: string, words: Array<[string, number]>): PronunciationAssessment => ({
    reference_text: refText,
    recognized_text: refText,
    overall: { accuracy: 80, fluency: 80, completeness: 100, pronunciation: 80 },
    words: words.map(([w, score]) => ({
      word: w,
      accuracy_score: score,
      error_type: score < 70 ? 'Mispronunciation' : 'None',
    })),
    provider: 'test',
    latency_ms: 0,
  });
  const assessments = [
    cleanTurn('mi día', [['mi', 95], ['día', 92]]),
    cleanTurn('está bien', [['está', 92], ['bien', 90]]),
    cleanTurn('un café', [['un', 95], ['café', 95]]),
  ];
  check(
    'three clean turns produce no trend',
    summarizePronunciationTrends(assessments) === null,
  );
}

console.log('\n════════════════════════════════════════════════');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);

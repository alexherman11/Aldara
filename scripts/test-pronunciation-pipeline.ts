import dotenv from 'dotenv';
dotenv.config({ override: true });

import {
  createAssessor,
  formatAnnotation,
  NoOpAssessor,
  SpeechAceAssessor,
  AzureAssessor,
  type PronunciationAssessment,
} from '../src/pronunciation/index.js';

/**
 * Pronunciation pipeline contract tests. Verifies:
 *   1. Factory returns the right concrete type for each provider name
 *   2. NoOpAssessor produces a clean, well-shaped assessment
 *   3. formatAnnotation suppresses output when nothing is flagged
 *   4. formatAnnotation produces the expected markup when words are flagged
 *   5. SpeechAceAssessor instantiates without crashing when key is set
 *
 * Does NOT make any real API calls — those need real audio buffers and live
 * a tier above the unit-test boundary. Live SpeechAce calls happen during
 * the agent integration once we've wired audio capture in.
 */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, info?: string) {
  if (ok) {
    console.log(`  ${label}: PASS${info ? ` (${info})` : ''}`);
    passed++;
  } else {
    console.log(`  ${label}: FAIL${info ? ` (${info})` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('Pronunciation pipeline contract tests\n');

  // ── 1. Factory selection ────────────────────────────────────────
  console.log('── 1. Factory selection ──');
  // Clear env so the no-arg case really tests the hardcoded default, not
  // whatever PRONUNCIATION_PROVIDER happens to be set to in this shell.
  const savedProvider = process.env.PRONUNCIATION_PROVIDER;
  delete process.env.PRONUNCIATION_PROVIDER;
  check('createAssessor() defaults to NoOp', createAssessor() instanceof NoOpAssessor);
  if (savedProvider) process.env.PRONUNCIATION_PROVIDER = savedProvider;
  check('createAssessor("noop") → NoOp', createAssessor('noop') instanceof NoOpAssessor);

  if (process.env.SPEECHACE_API_KEY) {
    check(
      'createAssessor("speechace") → SpeechAce',
      createAssessor('speechace') instanceof SpeechAceAssessor,
    );
  } else {
    console.log('  createAssessor("speechace"): SKIP (no SPEECHACE_API_KEY)');
  }

  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) {
    check(
      'createAssessor("azure") → Azure',
      createAssessor('azure') instanceof AzureAssessor,
    );
  } else {
    console.log('  createAssessor("azure"): SKIP (no AZURE_SPEECH_KEY/REGION)');
  }

  // ── 2. NoOp assessment shape ────────────────────────────────────
  console.log('\n── 2. NoOp assessment shape ──');
  const noop = new NoOpAssessor();
  const noopResult = await noop.assess({
    audio: Buffer.alloc(0),
    reference_text: 'tengo un perro grande',
  });
  check('NoOp returns provider="noop"', noopResult.provider === 'noop');
  check('NoOp has perfect overall scores', noopResult.overall.accuracy === 100);
  check(
    'NoOp word count matches input',
    noopResult.words.length === 4,
    `${noopResult.words.length} words`,
  );
  check(
    'NoOp every word is "None" error',
    noopResult.words.every((w) => w.error_type === 'None'),
  );

  // ── 3. formatAnnotation: clean assessment → null ────────────────
  console.log('\n── 3. Annotation: clean assessment ──');
  const cleanAnnotation = formatAnnotation(noopResult);
  check('Clean assessment produces no annotation', cleanAnnotation === null);

  // ── 4. formatAnnotation: flagged assessment ─────────────────────
  console.log('\n── 4. Annotation: flagged assessment ──');
  const flagged: PronunciationAssessment = {
    reference_text: 'tengo un perro grande',
    overall: {
      accuracy: 78,
      fluency: 85,
      completeness: 100,
      pronunciation: 78,
    },
    words: [
      { word: 'tengo', accuracy_score: 92, error_type: 'None' },
      { word: 'un', accuracy_score: 95, error_type: 'None' },
      {
        word: 'perro',
        accuracy_score: 62,
        error_type: 'Mispronunciation',
        phonemes: [
          { phoneme: 'p', accuracy_score: 88 },
          { phoneme: 'e', accuracy_score: 91 },
          {
            phoneme: 'r',
            accuracy_score: 28,
            alternatives: [{ phoneme: 'ɾ', confidence: 0.81 }],
          },
          { phoneme: 'o', accuracy_score: 90 },
        ],
      },
      { word: 'grande', accuracy_score: 88, error_type: 'None' },
    ],
    provider: 'azure',
    latency_ms: 850,
  };

  const annotation = formatAnnotation(flagged);
  console.log('\n  Generated annotation:');
  console.log(
    annotation
      ?.split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
  check('Annotation is non-null', annotation !== null);
  check(
    'Annotation flags "perro"',
    annotation?.includes('perro') ?? false,
  );
  check(
    'Annotation includes phoneme hint /r/ → /ɾ/',
    annotation?.includes('/r/ → /ɾ/') ?? false,
  );
  check(
    'Annotation does NOT include "tengo" (unflagged)',
    !annotation?.includes('tengo'),
  );

  // ── 5. Annotation respects threshold ────────────────────────────
  console.log('\n── 5. Threshold customization ──');
  // With a higher threshold, more words get flagged
  const strictAnnotation = formatAnnotation(flagged, 95);
  check(
    'Strict threshold (95) flags "tengo"',
    strictAnnotation?.includes('tengo') ?? false,
  );

  // Engine-flagged words (non-"None" error_type) are kept regardless of threshold —
  // categorical flags from the engine are a stronger signal than the soft threshold.
  // With a low threshold, "tengo" (score 92, error_type "None") drops out, but
  // "perro" (engine-flagged Mispronunciation) stays.
  const lenientAnnotation = formatAnnotation(flagged, 50);
  check(
    'Lenient threshold (50) DROPS "tengo" (clean, 92)',
    !lenientAnnotation?.includes('tengo'),
  );
  check(
    'Lenient threshold (50) KEEPS engine-flagged "perro"',
    lenientAnnotation?.includes('perro') ?? false,
  );

  // ── 6. Prosody monotone flag ────────────────────────────────────
  console.log('\n── 6. Prosody monotone flag ──');
  const monotone: PronunciationAssessment = {
    ...flagged,
    prosody: {
      score: 35,
      errors: [{ type: 'Monotone' }],
    },
  };
  const monotoneAnnotation = formatAnnotation(monotone);
  check(
    'Monotone prosody adds prosody flag',
    monotoneAnnotation?.includes('prosody: monotone') ?? false,
  );

  // ── 7. SpeechAce instantiation ──────────────────────────────────
  console.log('\n── 7. SpeechAce instantiation ──');
  if (process.env.SPEECHACE_API_KEY) {
    try {
      const sa = new SpeechAceAssessor();
      check('SpeechAceAssessor constructs', sa.name === 'speechace');
    } catch (err) {
      check('SpeechAceAssessor constructs', false, String(err));
    }
  } else {
    console.log('  SpeechAceAssessor instantiation: SKIP (no key)');
  }

  // SpeechAce without key should throw
  console.log('\n── 8. SpeechAce error handling ──');
  const savedKey = process.env.SPEECHACE_API_KEY;
  delete process.env.SPEECHACE_API_KEY;
  try {
    new SpeechAceAssessor();
    check('SpeechAce throws when no key', false, 'should have thrown');
  } catch {
    check('SpeechAce throws when no key', true);
  }
  if (savedKey) process.env.SPEECHACE_API_KEY = savedKey;

  // ── 9. Azure error handling ──────────────────────────────────────
  console.log('\n── 9. Azure error handling ──');
  const savedAzureKey = process.env.AZURE_SPEECH_KEY;
  const savedAzureRegion = process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  try {
    new AzureAssessor();
    check('Azure throws when no key/region', false, 'should have thrown');
  } catch {
    check('Azure throws when no key/region', true);
  }
  // Partial config should also throw — region without key
  process.env.AZURE_SPEECH_REGION = 'eastus';
  try {
    new AzureAssessor();
    check('Azure throws on key-only-missing', false, 'should have thrown');
  } catch {
    check('Azure throws on key-only-missing', true);
  }
  // Restore
  delete process.env.AZURE_SPEECH_REGION;
  if (savedAzureKey) process.env.AZURE_SPEECH_KEY = savedAzureKey;
  if (savedAzureRegion) process.env.AZURE_SPEECH_REGION = savedAzureRegion;

  // Azure name property
  try {
    const azure = new AzureAssessor({ key: 'fake', region: 'fake' });
    check('AzureAssessor.name === "azure"', azure.name === 'azure');
  } catch (err) {
    check('AzureAssessor.name === "azure"', false, String(err));
  }

  console.log('\n════════════════════════════════════════════════');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Pipeline test failed:', err);
  process.exit(1);
});

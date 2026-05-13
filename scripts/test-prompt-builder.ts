import 'dotenv/config';
import { buildSystemPrompt } from '../src/prompt-builder.js';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';
import type { SessionContext } from '../src/session-context.js';
import type { LearnerCore, TutorCore } from '../src/types.js';

// ── Test Fixtures ───────────────────────────────────────────────────

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    learnerId: 'test-learner',
    sessionId: 'test-session',
    learnerCore: SEED_LEARNER_CORE,
    tutorCore: SEED_TUTOR_CORE,
    fsrsDueItems: [],
    fullTranscript: [],
    turnCount: 0,
    sessionStartedAt: new Date(),
    ...overrides,
  };
}

const EVOLVED_LEARNER: LearnerCore = {
  ...SEED_LEARNER_CORE,
  version: 2,
  session_trajectory:
    'Alex is intermediate, strong on cooking vocab, working on past tenses. Next session should push preterite conjugations.',
  learning_profile: {
    ...SEED_LEARNER_CORE.learning_profile,
    interests: ['cooking', 'hiking', 'travel to Mexico'],
    correction_preference: 'inline recasts accepted well',
    frustration_triggers: ['verb conjugation drills'],
  },
  proficiency: {
    ...SEED_LEARNER_CORE.proficiency,
    cefr_level: 'A2',
  },
};

const EVOLVED_TUTOR: TutorCore = {
  ...SEED_TUTOR_CORE,
  version: 2,
  teaching_narrative:
    'Alex loves cooking. Build on past-tense verbs through recipe stories. Use more Spanish now — 60/40 English/Spanish.',
  bilingual_ratio_target: 0.6,
};

// ── Test Runner ─────────────────────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function runChecks(label: string, checks: Check[]): boolean {
  console.log(`\n── ${label} ──`);
  let allPass = true;
  for (const c of checks) {
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`         ${c.detail}`);
    if (!c.pass) allPass = false;
  }
  return allPass;
}

function includes(prompt: string, text: string): Check {
  return {
    name: `Contains: "${text}"`,
    pass: prompt.includes(text),
    detail: prompt.includes(text) ? 'Found' : 'Missing',
  };
}

function excludes(prompt: string, text: string): Check {
  return {
    name: `Excludes: "${text}"`,
    pass: !prompt.includes(text),
    detail: !prompt.includes(text) ? 'Correctly absent' : 'Should not be present',
  };
}

// ── Test Cases ──────────────────────────────────────────────────────

function test1_freshLearner(): boolean {
  const ctx = makeCtx();
  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 1: Fresh learner (seed cores)', [
    includes(prompt, 'Spoken Aloud'),
    includes(prompt, 'NEVER use parenthetical pronunciation guides'),
    includes(prompt, 'new learner'),
    // Code-switching is now the primary teaching tool (Phase 6 persona rewrite)
    includes(prompt, 'Code-switching'),
    includes(prompt, 'Sandwich technique'),
    excludes(prompt, 'Vocabulary due for review'),
    excludes(prompt, 'Level reminder'),
  ]);
}

function test2_evolvedLearnerWithInterests(): boolean {
  const ctx = makeCtx({
    learnerCore: EVOLVED_LEARNER,
    tutorCore: EVOLVED_TUTOR,
  });
  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 2: Evolved learner with cooking interest', [
    includes(prompt, 'game plan for this session'),
    includes(prompt, 'Alex loves cooking'),
    includes(prompt, 'About this learner'),
    includes(prompt, 'cooking'),
    includes(prompt, 'hiking'),
    includes(prompt, 'Interests:'),
    includes(prompt, 'verb conjugation drills'),
    excludes(prompt, 'new learner'),
  ]);
}

function test3_fsrsItemsSurfaced(): boolean {
  const ctx = makeCtx({
    learnerCore: EVOLVED_LEARNER,
    tutorCore: EVOLVED_TUTOR,
    fsrsDueItems: [
      { item_key: 'empinado', item_context: 'steep terrain during hiking' },
      { item_key: 'sendero', item_context: 'hiking trail' },
      { item_key: 'cocinar', item_context: null },
    ],
  });
  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 3: FSRS items woven into prompt', [
    includes(prompt, 'Vocabulary due for review'),
    includes(prompt, '"empinado"'),
    includes(prompt, 'steep terrain during hiking'),
    includes(prompt, '"sendero"'),
    includes(prompt, '"cocinar"'),
    includes(prompt, 'Weave these Spanish words naturally'),
    includes(prompt, 'Do NOT quiz the learner'),
  ]);
}

function test4_cefrReminderTriggers(): boolean {
  const ctx = makeCtx({
    learnerCore: EVOLVED_LEARNER,
    tutorCore: EVOLVED_TUTOR,
    turnCount: 7,
  });
  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 4: CEFR reminder fires on turn 7', [
    includes(prompt, 'Level reminder'),
    includes(prompt, 'CEFR A2'),
    includes(prompt, '60% English'),
    includes(prompt, '40% Spanish'),
  ]);
}

function test5_cefrReminderSkipsOffTurns(): boolean {
  const promptsByTurn: { [turn: number]: string } = {};
  for (const turn of [1, 3, 6, 14]) {
    const ctx = makeCtx({ turnCount: turn });
    promptsByTurn[turn] = buildSystemPrompt(ctx);
  }

  return runChecks('Test 5: CEFR reminder skips non-multiples-of-7', [
    excludes(promptsByTurn[1], 'Level reminder'),
    excludes(promptsByTurn[3], 'Level reminder'),
    excludes(promptsByTurn[6], 'Level reminder'),
    // Turn 14 is 2*7, should fire
    includes(promptsByTurn[14], 'Level reminder'),
  ]);
}

function test6_explicitCefrOverride(): boolean {
  const ctx = makeCtx({ turnCount: 3 });
  const prompt = buildSystemPrompt(ctx, { includeCefrReminder: true });
  return runChecks('Test 6: Explicit CEFR override forces reminder', [
    includes(prompt, 'Level reminder'),
  ]);
}

function test7_emptyFsrsSkipsSection(): boolean {
  const ctx = makeCtx({
    learnerCore: EVOLVED_LEARNER,
    fsrsDueItems: [],
  });
  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 7: Empty FSRS list skips section', [
    excludes(prompt, 'Vocabulary due for review'),
  ]);
}

function test9_pronunciationInjection(): boolean {
  const ctx = makeCtx({
    recentAssessments: [
      {
        reference_text: 'tengo un perro grande',
        overall: { accuracy: 78, fluency: 85, completeness: 100, pronunciation: 78 },
        words: [
          { word: 'tengo', accuracy_score: 92, error_type: 'None' },
          { word: 'un', accuracy_score: 95, error_type: 'None' },
          {
            word: 'perro',
            accuracy_score: 62,
            error_type: 'Mispronunciation',
            phonemes: [
              {
                phoneme: 'r',
                accuracy_score: 28,
                alternatives: [{ phoneme: 'ɾ', confidence: 0.81 }],
              },
            ],
          },
          { word: 'grande', accuracy_score: 88, error_type: 'None' },
        ],
        provider: 'speechace',
        latency_ms: 850,
      },
    ],
  });

  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 9: Pronunciation annotation injection', [
    includes(prompt, 'Pronunciation flags from the learner'),
    includes(prompt, 'tengo un perro grande'),
    includes(prompt, 'perro'),
    includes(prompt, '/r/ → /ɾ/'),
    includes(prompt, 'On pronunciation'),
    excludes(prompt, 'tengo: '), // not flagged
  ]);
}

function test11_pronunciationMultiPhonemeAndDivergence(): boolean {
  // Word with TWO weak phonemes (multi-phoneme L1 pattern) and a recognized
  // text that diverges from reference (STT auto-corrected).
  const ctx = makeCtx({
    recentAssessments: [
      {
        reference_text: 'mi perro',
        recognized_text: 'mi pero',
        overall: { accuracy: 55, fluency: 80, completeness: 100, pronunciation: 55 },
        words: [
          { word: 'mi', accuracy_score: 95, error_type: 'None' },
          {
            word: 'perro',
            accuracy_score: 40,
            error_type: 'Mispronunciation',
            phonemes: [
              {
                phoneme: 'r',
                accuracy_score: 25,
                alternatives: [{ phoneme: 'ɾ', confidence: 0.85 }],
              },
              {
                phoneme: 'e',
                accuracy_score: 50,
                alternatives: [{ phoneme: 'ɛ', confidence: 0.70 }],
              },
            ],
          },
        ],
        provider: 'azure',
        latency_ms: 900,
      },
    ],
  });

  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 11: Multi-phoneme + STT divergence', [
    includes(prompt, '/r/ → /ɾ/'),
    includes(prompt, '/e/ → /ɛ/'), // both phoneme substitutions surfaced
    includes(prompt, 'STT/assessor mismatch'),
    includes(prompt, 'pero'),
    includes(prompt, 'perro'),
  ]);
}

function test12_pronunciationTrendSummary(): boolean {
  // Five turns where /r/ is weak in 3 of 5 (≥2 = persistent)
  const mkAssessment = (
    ref: string,
    rrWords: Array<[string, number]>,
  ) => ({
    reference_text: ref,
    overall: { accuracy: 70, fluency: 85, completeness: 100, pronunciation: 70 },
    words: rrWords.map(([w, score]) => ({
      word: w,
      accuracy_score: score,
      error_type: (score < 70 ? 'Mispronunciation' : 'None') as
        | 'Mispronunciation'
        | 'None',
      phonemes: w.includes('rr')
        ? [
            {
              phoneme: 'r',
              accuracy_score: score < 70 ? 25 : 90,
              alternatives:
                score < 70
                  ? [{ phoneme: 'ɾ', confidence: 0.8 }]
                  : undefined,
            },
          ]
        : undefined,
    })),
    provider: 'azure',
    latency_ms: 900,
  });

  const ctx = makeCtx({
    recentAssessments: [
      mkAssessment('el perro corre', [['el', 95], ['perro', 30], ['corre', 35]]),
      mkAssessment('hola amigo', [['hola', 90], ['amigo', 92]]),
      mkAssessment('un perrito', [['un', 95], ['perrito', 40]]),
      mkAssessment('está cerrado', [['está', 95], ['cerrado', 45]]),
      mkAssessment('buenas tardes', [['buenas', 92], ['tardes', 90]]),
    ],
  });

  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 12: Pronunciation trend summary surfaces persistent /r/', [
    includes(prompt, 'Pronunciation patterns over recent turns'),
    includes(prompt, '/r/'),
    includes(prompt, 'Recurring phoneme weakness'),
  ]);
}

function test10_pronunciationCleanAssessmentSkipped(): boolean {
  const ctx = makeCtx({
    recentAssessments: [
      {
        reference_text: 'hola Sofía',
        overall: { accuracy: 100, fluency: 100, completeness: 100, pronunciation: 100 },
        words: [
          { word: 'hola', accuracy_score: 100, error_type: 'None' },
          { word: 'Sofía', accuracy_score: 100, error_type: 'None' },
        ],
        provider: 'noop',
        latency_ms: 0,
      },
    ],
  });

  const prompt = buildSystemPrompt(ctx);
  return runChecks('Test 10: Clean pronunciation skips annotation section', [
    excludes(prompt, 'Pronunciation flags from the learner'),
  ]);
}

function test8_ttsRulesAlwaysFirst(): boolean {
  const ctx = makeCtx();
  const prompt = buildSystemPrompt(ctx);
  const ttsIdx = prompt.indexOf('CRITICAL: Your Output Is Spoken Aloud');
  const personaIdx = prompt.indexOf('Sofía');
  return runChecks('Test 8: TTS rules appear before everything else', [
    {
      name: 'TTS rules at top',
      pass: ttsIdx >= 0 && ttsIdx < personaIdx,
      detail: `TTS rules index: ${ttsIdx}, persona index: ${personaIdx}`,
    },
  ]);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ PROMPT BUILDER UNIT TESTS ═══');

  const results = [
    test1_freshLearner(),
    test2_evolvedLearnerWithInterests(),
    test3_fsrsItemsSurfaced(),
    test4_cefrReminderTriggers(),
    test5_cefrReminderSkipsOffTurns(),
    test6_explicitCefrOverride(),
    test7_emptyFsrsSkipsSection(),
    test8_ttsRulesAlwaysFirst(),
    test9_pronunciationInjection(),
    test10_pronunciationCleanAssessmentSkipped(),
    test11_pronunciationMultiPhonemeAndDivergence(),
    test12_pronunciationTrendSummary(),
  ];

  const passed = results.filter(Boolean).length;
  const total = results.length;

  console.log(
    `\n═══ ${passed}/${total} TESTS PASSED ═══\n`,
  );

  if (passed < total) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

/**
 * Bad-pronunciation feedback-loop harness.
 *
 * Verifies the end-to-end pronunciation path WITHOUT requiring a microphone:
 *
 *   pre-recorded WAV (real bad pronunciation, captured via RECORD_TURNS=1)
 *      → SegmentedAssessor (Deepgram + Azure)
 *      → ctx.recentAssessments
 *      → buildSystemPrompt — should emit a "Pronunciation flags" section
 *      → gpt-4o — should model the flagged word back cleanly
 *
 * Each test case picks a recording whose saved assessment already proved the
 * scorer flags specific words badly (e.g. "escalí" score 35,
 * "montañas" omission). We re-run the assessor live, then inspect both the
 * resulting prompt and Sofía's reply for evidence the loop closed.
 *
 * Why this exists: the LiveKit harness can't drive Deepgram with synthesized
 * audio (empty transcripts — see scenarios/.../events.jsonl from May 13).
 * The direct harness skips pronunciation entirely. Neither lets Claude tune
 * the bad-pronunciation feedback flow. This script does.
 *
 * Usage:
 *   npx tsx scripts/test-bad-pronunciation.ts                    # run all cases
 *   npx tsx scripts/test-bad-pronunciation.ts escali-mountains   # one case
 */

import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

import { SegmentedAssessor } from '../src/pronunciation/segmented-assessor.js';
import { formatAnnotation } from '../src/pronunciation/types.js';
import { buildSystemPrompt } from '../src/prompt-builder.js';
import { initControllerState } from '../src/difficulty-controller.js';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';
import type { SessionContext } from '../src/session-context.js';
import type { PronunciationAssessment } from '../src/pronunciation/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── Test cases ───────────────────────────────────────────────────────

interface BadPronCase {
  id: string;
  description: string;
  /** Path to the .wav, relative to project root. The matching .json is loaded too. */
  recordingPath: string;
  /**
   * Words we expect the assessor to flag (score < 70 OR error_type !== 'None').
   * Acts as a regression guard — if the assessor stops catching these we'll know.
   */
  mustFlagWords: string[];
  /**
   * If set, Sofía's reply must contain at least one of these substrings (case-
   * insensitive). Used to verify the feedback loop reaches the LLM and that the
   * LLM models the flagged word back cleanly. Empty array disables the check.
   */
  expectSofiaToEcho: string[];
}

const CASES: BadPronCase[] = [
  {
    id: 'escali-mountains',
    description:
      'Learner says "escalí montañas cerca de Machu Picchu" — saved assessment scored ' +
      '"escalí" at 35 and "montañas" as an omission (0).',
    recordingPath:
      'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_004.wav',
    mustFlagWords: ['escalí', 'montañas'],
    expectSofiaToEcho: ['escalé', 'escalaste', 'monta', 'montañ'],
  },
  {
    id: 'sofia-conmigo',
    description:
      'Learner mangles "Sofía" (28) and "conmigo" (54) in an introductory turn.',
    recordingPath:
      'recordings/5130758c-3ce3-4b7f-aa19-90fa8665db66/turn_001.wav',
    mustFlagWords: ['Sofía', 'conmigo'],
    expectSofiaToEcho: ['sofía', 'conmigo'],
  },
  {
    id: 'visitar-mispron',
    description:
      'Travel monologue with "visitar" mispronounced (26) and stray English.',
    recordingPath:
      'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_003.wav',
    mustFlagWords: ['visitar'],
    expectSofiaToEcho: ['visitar', 'visita'],
  },
];

// ── Runner ───────────────────────────────────────────────────────────

const openai = new OpenAI();
const CONVERSATION_MODEL = 'gpt-4o';

interface CaseResult {
  id: string;
  flaggedFromAssessor: Array<{ word: string; score: number; error: string }>;
  mustFlagHits: string[];
  mustFlagMisses: string[];
  promptContainsPronSection: boolean;
  promptMentionsFlaggedWords: string[];
  sofiaReply: string;
  sofiaEchoedFlaggedWord: boolean;
  echoMatches: string[];
  pass: boolean;
}

async function runCase(testCase: BadPronCase): Promise<CaseResult> {
  console.log(`\n══════ Case: ${testCase.id} ══════`);
  console.log(`  ${testCase.description}`);

  const wavAbs = join(PROJECT_ROOT, testCase.recordingPath);
  const metaAbs = wavAbs.replace(/\.wav$/, '.json');
  if (!existsSync(wavAbs)) {
    throw new Error(`Missing recording: ${wavAbs}`);
  }
  if (!existsSync(metaAbs)) {
    throw new Error(`Missing metadata: ${metaAbs}`);
  }

  const wav = readFileSync(wavAbs);
  const meta = JSON.parse(readFileSync(metaAbs, 'utf8')) as {
    reference_text: string;
    sample_rate: number;
    duration_sec: number;
  };
  console.log(`  reference_text: "${meta.reference_text}"`);
  console.log(`  ${meta.duration_sec.toFixed(1)}s @ ${meta.sample_rate}Hz`);

  // 1. Live assessment ─ NOT the saved one. We want to know what the current
  //    pipeline does, not what it did weeks ago.
  console.log('\n  → running SegmentedAssessor...');
  const assessor = new SegmentedAssessor();
  const t0 = Date.now();
  const assessment = await assessor.assess({
    audio: wav,
    reference_text: meta.reference_text,
    sample_rate: meta.sample_rate,
    language: 'es-MX',
  });
  console.log(`  assessor done in ${Date.now() - t0}ms`);
  console.log(
    `  overall: acc=${assessment.overall.accuracy.toFixed(0)} ` +
      `pron=${assessment.overall.pronunciation.toFixed(0)}`,
  );

  const flagged = assessment.words.filter(
    (w) => w.accuracy_score < 70 || w.error_type !== 'None',
  );
  console.log(`  flagged words: ${flagged.length}/${assessment.words.length}`);
  for (const f of flagged.slice(0, 12)) {
    console.log(
      `    [${f.error_type.padEnd(15)}] "${f.word}" score=${f.accuracy_score.toFixed(0)}`,
    );
  }

  // 2. Check the regression guard: must-flag words present in flagged list
  const flaggedLower = flagged.map((f) => f.word.toLowerCase());
  const mustFlagHits: string[] = [];
  const mustFlagMisses: string[] = [];
  for (const expected of testCase.mustFlagWords) {
    if (flaggedLower.some((w) => w === expected.toLowerCase())) {
      mustFlagHits.push(expected);
    } else {
      mustFlagMisses.push(expected);
    }
  }
  console.log(
    `  must-flag check: hit=[${mustFlagHits.join(', ')}] miss=[${mustFlagMisses.join(', ') || '∅'}]`,
  );

  // 3. Drop the assessment into a minimal SessionContext and see what the
  //    prompt-builder emits.
  const ctx: SessionContext = {
    learnerId: '00000000-0000-0000-0000-0000000000bb',
    sessionId: '00000000-0000-0000-0000-000000000bbb',
    learnerCore: structuredClone(SEED_LEARNER_CORE),
    tutorCore: structuredClone(SEED_TUTOR_CORE),
    fsrsDueItems: [],
    fullTranscript: [
      // Pretend the agent already greeted, so gpt-4o has context for a reply.
      {
        role: 'tutor',
        text: '¡Hola! Soy Sofía. Cuéntame, ¿qué has estado haciendo?',
        ts: new Date(),
      },
      { role: 'learner', text: meta.reference_text, ts: new Date() },
    ],
    turnCount: 1,
    sessionStartedAt: new Date(),
    recentAssessments: [assessment],
  };
  const controllerState = initControllerState(ctx);

  const sysPrompt = buildSystemPrompt(ctx, { controllerState });
  const promptContainsPronSection = sysPrompt.includes(
    'Pronunciation flags from the learner',
  );
  console.log(
    `\n  prompt has pronunciation section: ${promptContainsPronSection ? 'YES' : 'NO'}`,
  );

  const promptLower = sysPrompt.toLowerCase();
  const promptMentionsFlaggedWords = testCase.mustFlagWords.filter((w) =>
    promptLower.includes(w.toLowerCase()),
  );
  console.log(
    `  prompt mentions: [${promptMentionsFlaggedWords.join(', ') || '∅'}]`,
  );

  // 4. Ask gpt-4o for Sofía's reply and inspect it.
  console.log('\n  → calling gpt-4o for Sofía\'s reply...');
  const messages = [
    { role: 'system' as const, content: sysPrompt },
    ...ctx.fullTranscript.map((t) => ({
      role: (t.role === 'learner' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: t.text,
    })),
  ];
  const completion = await openai.chat.completions.create({
    model: CONVERSATION_MODEL,
    messages,
    temperature: 0.5,
  });
  const sofiaReply = completion.choices[0].message.content?.trim() ?? '';
  console.log(`\n  Sofía: "${sofiaReply}"`);

  const replyLower = sofiaReply.toLowerCase();
  const echoMatches = testCase.expectSofiaToEcho.filter((s) =>
    replyLower.includes(s.toLowerCase()),
  );
  const sofiaEchoedFlaggedWord =
    testCase.expectSofiaToEcho.length === 0 || echoMatches.length > 0;
  console.log(
    `  Sofía echoed expected word: ${sofiaEchoedFlaggedWord ? 'YES' : 'NO'} ` +
      (echoMatches.length ? `(matched: [${echoMatches.join(', ')}])` : ''),
  );

  const pass =
    mustFlagMisses.length === 0 &&
    promptContainsPronSection &&
    promptMentionsFlaggedWords.length === testCase.mustFlagWords.length &&
    sofiaEchoedFlaggedWord;
  console.log(`\n  CASE RESULT: ${pass ? '✓ PASS' : '✗ FAIL'}`);

  return {
    id: testCase.id,
    flaggedFromAssessor: flagged.map((f) => ({
      word: f.word,
      score: Math.round(f.accuracy_score),
      error: f.error_type,
    })),
    mustFlagHits,
    mustFlagMisses,
    promptContainsPronSection,
    promptMentionsFlaggedWords,
    sofiaReply,
    sofiaEchoedFlaggedWord,
    echoMatches,
    pass,
  };
}

async function main() {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.id === filter) : CASES;
  if (cases.length === 0) {
    console.error(
      `Unknown case "${filter}". Known: ${CASES.map((c) => c.id).join(', ')}`,
    );
    process.exit(1);
  }

  const results: CaseResult[] = [];
  for (const c of cases) {
    try {
      results.push(await runCase(c));
    } catch (err) {
      console.error(`Case ${c.id} crashed:`, err);
      results.push({
        id: c.id,
        flaggedFromAssessor: [],
        mustFlagHits: [],
        mustFlagMisses: c.mustFlagWords,
        promptContainsPronSection: false,
        promptMentionsFlaggedWords: [],
        sofiaReply: `<error: ${String(err).slice(0, 200)}>`,
        sofiaEchoedFlaggedWord: false,
        echoMatches: [],
        pass: false,
      });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' Bad-pronunciation harness summary');
  console.log('══════════════════════════════════════════════════════');
  for (const r of results) {
    console.log(
      `  ${r.pass ? '✓' : '✗'} ${r.id.padEnd(22)} ` +
        `flag-hits=${r.mustFlagHits.length}/${r.mustFlagHits.length + r.mustFlagMisses.length} ` +
        `prompt=${r.promptContainsPronSection ? 'Y' : 'N'} ` +
        `echo=${r.sofiaEchoedFlaggedWord ? 'Y' : 'N'}`,
    );
  }

  // Write the full artifact for later diffing.
  const outDir = join(PROJECT_ROOT, 'scenarios', 'bad-pronunciation');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n  full artifact: ${outPath}`);

  const failed = results.filter((r) => !r.pass).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

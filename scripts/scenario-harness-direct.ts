/**
 * Transcript-injection scenario harness.
 *
 * Bypasses LiveKit audio entirely and tests the LLM + difficulty controller +
 * prompt evolution + (optionally) the offline pronunciation pipeline by
 * exercising the same code paths the agent uses in-process. For each scripted
 * learner turn:
 *
 *   1. Append "{role: 'learner', text}" to the in-memory SessionContext
 *   2. Run evaluateTurn (and evaluateEdge every 5 turns) — waiting for the
 *      result, unlike the live agent which fires-and-forgets. This makes the
 *      test deterministic.
 *   3. Rebuild the system prompt with the latest controller + pronunciation state
 *   4. Call the conversation LLM (same model the agent uses: gpt-4o) with the
 *      system prompt + transcript
 *   5. Append the tutor response to the transcript
 *   6. Optional: synthesize the learner's audio via Cartesia and run the
 *      segmented assessor against it, so pronunciation flags feed the next prompt
 *
 * Writes one events.jsonl + the final compaction-result.json to
 * scenarios/<name>/<runId>-direct/ for the judge harness to consume.
 *
 * Compared to the LiveKit-based harness, this is:
 *   ~10× faster per turn (no audio transport, no TTS playback)
 *   100% reliable (no Opus encoding, no track subscription races)
 *   covers everything except the live audio path itself
 */

import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

import {
  evaluateTurn,
  evaluateEdge,
  initControllerState,
  type ControllerState,
} from '../src/difficulty-controller.js';
import { buildSystemPrompt } from '../src/prompt-builder.js';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';
import { runCompaction } from '../src/compaction.js';
import { closePool } from '../src/db/index.js';
import { createAssessor } from '../src/pronunciation/index.js';
import { chunksToWav } from '../src/pronunciation/wav.js';
import type { SessionContext } from '../src/session-context.js';
import type { PronunciationAssessment } from '../src/pronunciation/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EDGE_CHECK_EVERY_N_TURNS = 5;
const CONVERSATION_MODEL = 'gpt-4o';

// ── Scenario definitions ─────────────────────────────────────────────

export interface DirectScriptedTurn {
  /** What the learner said this turn — text only, language inferred. */
  text: string;
  /** ISO language for optional audio synthesis. Defaults to autodetect from text. */
  audioLanguage?: 'es' | 'en';
  /** Skip pronunciation scoring for this turn (e.g., very short utterances). */
  skipPronunciation?: boolean;
}

export interface DirectScenario {
  name: string;
  description: string;
  turns: DirectScriptedTurn[];
  /** Run compaction at the end? */
  endWithCompaction?: boolean;
  /** Synthesize learner audio + score pronunciation each turn? */
  includePronunciation?: boolean;
  /** Initial cores override (e.g., evolved learner instead of seed). */
  initialLearner?: typeof SEED_LEARNER_CORE;
  initialTutor?: typeof SEED_TUTOR_CORE;
}

// ── Synthesis (Spanish via Cartesia only; English-only turns skip) ──

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
      voice: {
        mode: 'id',
        id: process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c',
      },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      language,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Cartesia HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function bufferToInt16(buf: Buffer): Int16Array {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

// ── LLM driver ───────────────────────────────────────────────────────

const openai = new OpenAI();

/**
 * Ask gpt-4o for Sofía's next turn, using the same system prompt + transcript
 * that the live agent would have built. Returns plain text.
 */
async function callConversationLLM(
  systemPrompt: string,
  transcript: Array<{ role: 'learner' | 'tutor'; text: string }>,
): Promise<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];
  for (const turn of transcript) {
    messages.push({
      role: turn.role === 'learner' ? 'user' : 'assistant',
      content: turn.text,
    });
  }
  const resp = await openai.chat.completions.create({
    model: CONVERSATION_MODEL,
    messages,
    temperature: 0.7,
  });
  return resp.choices[0].message.content?.trim() ?? '';
}

// ── Runner ───────────────────────────────────────────────────────────

interface EventRecord {
  ts: number;
  type:
    | 'learner-turn'
    | 'tutor-turn'
    | 'controller-update'
    | 'edge-check'
    | 'pronunciation'
    | 'compaction'
    | 'note';
  data: unknown;
}

export async function runDirectScenario(scenario: DirectScenario): Promise<string> {
  const runId = `${Date.now()}-direct`;
  const outDir = join(__dirname, '..', 'scenarios', scenario.name, runId);
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, 'events.jsonl');
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(scenario, null, 2));
  const startedAt = Date.now();

  const log = (e: EventRecord) => {
    appendFileSync(logPath, JSON.stringify({ ...e, ts: e.ts - startedAt }) + '\n');
  };

  console.log(`\n══════ Direct scenario: ${scenario.name} ══════`);
  console.log(`  ${scenario.description}`);
  console.log(`  Artifacts → ${outDir}\n`);

  // ── In-memory session context ───────────────────────────────────
  const ctx: SessionContext = {
    learnerId: '00000000-0000-0000-0000-0000000000aa',
    sessionId: '00000000-0000-0000-0000-000000000aaa',
    learnerCore: structuredClone(scenario.initialLearner ?? SEED_LEARNER_CORE),
    tutorCore: structuredClone(scenario.initialTutor ?? SEED_TUTOR_CORE),
    fsrsDueItems: [],
    fullTranscript: [],
    turnCount: 0,
    sessionStartedAt: new Date(),
    recentAssessments: [],
  };
  const controllerState: ControllerState = initControllerState(ctx);
  const assessor = scenario.includePronunciation
    ? createAssessor('segmented')
    : null;

  // ── Greeting (mirrors agent.ts onEnter) ─────────────────────────
  const greetingPrompt = buildSystemPrompt(ctx, { controllerState });
  log({ ts: Date.now(), type: 'note', data: { systemPromptHash: hashShort(greetingPrompt) } });
  const greeting = await callConversationLLM(greetingPrompt, [
    {
      role: 'learner',
      text:
        // We synthesize a fake "first contact" prompt so gpt-4o produces an
        // opening turn that mirrors what onEnter would generate in the live agent.
        "[system note: Greet the learner warmly with '¡Hola!' and introduce yourself as Sofía. Ask what made them want to learn Spanish. Keep it brief and friendly.]",
    },
  ]);
  ctx.fullTranscript.push({ role: 'tutor', text: greeting, ts: new Date() });
  log({ ts: Date.now(), type: 'tutor-turn', data: { turnIdx: 0, text: greeting, isGreeting: true } });
  console.log(`  Sofía (greeting): "${greeting}"\n`);

  // ── Drive scripted learner turns ────────────────────────────────
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    console.log(`── Turn ${i + 1}/${scenario.turns.length}`);
    console.log(`  Learner: "${turn.text}"`);

    // 1. Append learner turn
    ctx.fullTranscript.push({ role: 'learner', text: turn.text, ts: new Date() });
    ctx.turnCount++;
    log({ ts: Date.now(), type: 'learner-turn', data: { turnIdx: i + 1, text: turn.text } });

    // 2. Run controller updates synchronously (unlike the live agent's
    //    fire-and-forget). This makes the scenario deterministic.
    await evaluateTurn(ctx, controllerState);
    log({
      ts: Date.now(),
      type: 'controller-update',
      data: {
        turnIdx: i + 1,
        ratio: controllerState.current_ratio_target,
        edgeState: controllerState.edge_state,
        lastTurnReason: controllerState.last_turn_reason,
      },
    });

    const shouldEdgeCheck =
      ctx.turnCount > 0 && ctx.turnCount % EDGE_CHECK_EVERY_N_TURNS === 0;
    if (shouldEdgeCheck) {
      await evaluateEdge(ctx, controllerState);
      log({
        ts: Date.now(),
        type: 'edge-check',
        data: {
          turnIdx: i + 1,
          edgeState: controllerState.edge_state,
          edgeReason: controllerState.last_edge_reason,
        },
      });
    }

    // 3. Optional pronunciation scoring (synthesize learner audio → assess)
    if (scenario.includePronunciation && assessor && !turn.skipPronunciation) {
      try {
        const lang = turn.audioLanguage ?? guessLang(turn.text);
        const pcm = await cartesiaSynth(turn.text, lang);
        const samples = bufferToInt16(pcm);
        const wav = chunksToWav([{ samples, sampleRate: 16000, channels: 1 }]);
        const assessment = await assessor.assess({
          audio: wav,
          reference_text: turn.text,
          sample_rate: 16000,
          language: lang === 'es' ? 'es-mx' : 'en-us',
        });
        ctx.recentAssessments!.push(assessment);
        if (ctx.recentAssessments!.length > 20) {
          ctx.recentAssessments!.shift();
        }
        log({
          ts: Date.now(),
          type: 'pronunciation',
          data: {
            turnIdx: i + 1,
            referenceText: assessment.reference_text,
            recognizedText: assessment.recognized_text,
            overall: assessment.overall,
            flaggedWords: assessment.words.filter(
              (w) => w.accuracy_score < 70 || w.error_type !== 'None',
            ).map((w) => ({ word: w.word, score: Math.round(w.accuracy_score), errorType: w.error_type })),
            latencyMs: assessment.latency_ms,
          },
        });
        console.log(
          `  pronunciation: acc=${Math.round(assessment.overall.accuracy)} ` +
            `flagged=${assessment.words.filter((w) => w.accuracy_score < 70).length}/${assessment.words.length}`,
        );
      } catch (err) {
        console.warn(`  pronunciation failed for turn ${i + 1}:`, err);
        log({ ts: Date.now(), type: 'note', data: { msg: 'pronunciation failed', err: String(err), turnIdx: i + 1 } });
      }
    }

    // 4. Rebuild system prompt with fresh controller + pronunciation state
    const sysPrompt = buildSystemPrompt(ctx, { controllerState });
    log({
      ts: Date.now(),
      type: 'note',
      data: { msg: 'prompt-rebuilt', turnIdx: i + 1, systemPromptHash: hashShort(sysPrompt) },
    });

    // 5. Call conversation LLM for the next tutor turn
    const tutorText = await callConversationLLM(sysPrompt, ctx.fullTranscript);
    ctx.fullTranscript.push({ role: 'tutor', text: tutorText, ts: new Date() });
    log({ ts: Date.now(), type: 'tutor-turn', data: { turnIdx: i + 1, text: tutorText } });

    const ratioPct = Math.round(controllerState.current_ratio_target * 100);
    console.log(`  controller: ${ratioPct}% EN / ${100 - ratioPct}% ES, edge=${controllerState.edge_state}`);
    console.log(`  Sofía: "${tutorText}"\n`);
  }

  // ── Optional compaction ─────────────────────────────────────────
  if (scenario.endWithCompaction) {
    console.log('── Running compaction ──');
    try {
      const outcome = await runCompaction(ctx, controllerState);
      log({
        ts: Date.now(),
        type: 'compaction',
        data: {
          durationMs: outcome.durationMs,
          fsrsCreated: outcome.fsrsCreated,
          fsrsRated: outcome.fsrsRated,
          notes: outcome.result.compaction_notes,
        },
      });
      writeFileSync(join(outDir, 'compaction.json'), JSON.stringify(outcome, null, 2));
      console.log(`  compaction: ${outcome.durationMs}ms, ${outcome.fsrsCreated} created, ${outcome.fsrsRated} rated`);
    } catch (err) {
      console.warn('  compaction failed:', err);
      log({ ts: Date.now(), type: 'note', data: { msg: 'compaction failed', err: String(err) } });
    }
  }

  // Save final transcript + final controller state for the judge
  writeFileSync(
    join(outDir, 'transcript.json'),
    JSON.stringify(
      {
        scenario: scenario.name,
        transcript: ctx.fullTranscript.map((t) => ({ role: t.role, text: t.text })),
        finalControllerState: controllerState,
        finalLearnerCore: ctx.learnerCore,
        finalTutorCore: ctx.tutorCore,
        recentAssessments: ctx.recentAssessments,
      },
      null,
      2,
    ),
  );

  console.log(`\n✓ Scenario complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return outDir;
}

// ── Utilities ────────────────────────────────────────────────────────

function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function guessLang(text: string): 'es' | 'en' {
  // Cheap heuristic — tilde or ñ or any high-frequency Spanish word → es.
  if (/[áéíóúñ¿¡]/.test(text)) return 'es';
  const spanishHints = /\b(me|te|el|la|gusta|cocinar|llamo|por\s+favor|gracias|hola|tengo|estoy|soy|qué|tacos)\b/i;
  if (spanishHints.test(text)) return 'es';
  return 'en';
}

// ── Scenario library ─────────────────────────────────────────────────

export const SCENARIO_1_DIRECT: DirectScenario = {
  name: 'first-session-warm-up',
  description:
    'A1 cold-start. Mostly English with one broken Spanish attempt. Expect Sofía to stay ~80% English, model "cocinar tacos" back cleanly, never quiz.',
  includePronunciation: false, // pronunciation off for the first pass; flip on for Layer 4
  endWithCompaction: false,
  turns: [
    { text: "Hi Sofia, I'm just getting started with Spanish, so go easy on me please" },
    { text: "My main goal is to be able to talk to people when I travel to Mexico next year" },
    { text: "me gusta cocinar tacos pero no soy muy bueno", audioLanguage: 'es' },
    { text: "I love cooking, actually — I cook almost every night" },
    { text: "I would love to learn how to order food at a restaurant in Spanish" },
  ],
};

// ── CLI ──────────────────────────────────────────────────────────────

async function main() {
  const scenarioName = process.argv[2] ?? 'first-session-warm-up';
  const scenarios: Record<string, DirectScenario> = {
    'first-session-warm-up': SCENARIO_1_DIRECT,
  };
  const scenario = scenarios[scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario "${scenarioName}". Known: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }
  try {
    const outDir = await runDirectScenario(scenario);
    console.log(`\nArtifacts: ${outDir}`);
  } catch (err) {
    console.error('Scenario failed:', err);
    process.exit(1);
  } finally {
    await closePool().catch(() => {});
  }
}

if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}

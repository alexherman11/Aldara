import dotenv from 'dotenv';
// override:true because shells sometimes export an empty ANTHROPIC_API_KEY,
// which the default `import 'dotenv/config'` will refuse to overwrite.
dotenv.config({ override: true });

import {
  initControllerState,
  evaluateTurn,
  evaluateEdge,
  buildControllerPromptSection,
} from '../src/difficulty-controller.js';
import type { SessionContext } from '../src/session-context.js';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';

/**
 * Synthetic learner profiles used to verify the difficulty controller
 * produces sensibly-different ratio adjustments and edge states.
 *
 * Run with: npx tsx scripts/test-difficulty-controller.ts
 */

interface Scenario {
  label: string;
  expectedDirection: 'push' | 'back-off' | 'hold';
  expectedEdge: 'edge' | 'coasting' | 'overwhelmed';
  turns: Array<{ role: 'tutor' | 'learner'; text: string }>;
}

const scenarios: Scenario[] = [
  {
    label: 'Coasting learner — A1 prompts, fluent A2+ answers, no effort',
    expectedDirection: 'push',
    expectedEdge: 'coasting',
    turns: [
      { role: 'tutor', text: '¡Hola! How are you today?' },
      {
        role: 'learner',
        text: 'Hola Sofía, estoy muy bien. Esta mañana fui al gimnasio, hice ejercicio, y después tomé un café con mi hermana en el centro. ¿Y tú, cómo estás?',
      },
      {
        role: 'tutor',
        text: 'Estoy bien. Tell me about your hermana — what is she like?',
      },
      {
        role: 'learner',
        text: 'Mi hermana es muy divertida y trabajadora. Vive en Chicago pero viene a visitarme cada dos meses. Nos llevamos muy bien.',
      },
      { role: 'tutor', text: 'Qué bonito. Do you have other family nearby?' },
      {
        role: 'learner',
        text: 'Sí, mis padres viven a quince minutos de mi casa. Los veo casi todos los fines de semana.',
      },
    ],
  },
  {
    label: 'Overwhelmed learner — frustration and falls back to English',
    expectedDirection: 'back-off',
    expectedEdge: 'overwhelmed',
    turns: [
      {
        role: 'tutor',
        text: 'Cuéntame, qué hiciste el fin de semana pasado?',
      },
      { role: 'learner', text: 'Umm... I... no sé.' },
      {
        role: 'tutor',
        text: 'No te preocupes. ¿Fuiste al parque? ¿O te quedaste en casa?',
      },
      {
        role: 'learner',
        text: 'Wait, what does "te quedaste" mean? This is too hard.',
      },
      {
        role: 'tutor',
        text: 'It just means "did you stay" — quedarse means to stay.',
      },
      {
        role: 'learner',
        text: "I don't know. Can we just talk in English?",
      },
    ],
  },
  {
    label: 'On-edge learner — productive struggle, self-corrects, lands it',
    // Successfully landing with effort is reason to push slightly per the
    // controller's own rules ("hesitation + self-correction but landed it").
    expectedDirection: 'push',
    expectedEdge: 'edge',
    turns: [
      {
        role: 'tutor',
        text: 'What do you usually eat for breakfast — el desayuno?',
      },
      {
        role: 'learner',
        text: 'Para el desayuno... yo como... como huevos. Y un poco de pan.',
      },
      {
        role: 'tutor',
        text: 'Huevos y pan, clásico. ¿Con café o con jugo?',
      },
      {
        role: 'learner',
        text: 'Con... café. Yo bebo... no, yo tomo café cada mañana.',
      },
      { role: 'tutor', text: '¿Lo tomas con leche o solo?' },
      { role: 'learner', text: 'Con leche. Siempre con leche.' },
    ],
  },
];

function buildSyntheticContext(
  scenario: Scenario,
  turnCount: number,
): SessionContext {
  return {
    learnerId: 'synthetic',
    sessionId: 'synthetic-session',
    learnerCore: structuredClone(SEED_LEARNER_CORE),
    tutorCore: structuredClone(SEED_TUTOR_CORE),
    fsrsDueItems: [],
    fullTranscript: scenario.turns.map((t) => ({
      role: t.role,
      text: t.text,
      ts: new Date(),
    })),
    turnCount,
    sessionStartedAt: new Date(),
  };
}

async function runScenario(
  scenario: Scenario,
  timings: { evalTurnMs: number[]; edgeCheckMs: number[] },
): Promise<boolean> {
  console.log('\n────────────────────────────────────────────────');
  console.log(`SCENARIO: ${scenario.label}`);
  console.log(
    `Expected: ratio ${scenario.expectedDirection}, edge=${scenario.expectedEdge}`,
  );
  console.log('────────────────────────────────────────────────');

  const ctx = buildSyntheticContext(scenario, scenario.turns.length / 2);
  const state = initControllerState(ctx);
  const initialRatio = state.current_ratio_target;

  // Run per-turn evaluation (timed)
  const turnStart = Date.now();
  await evaluateTurn(ctx, state);
  timings.evalTurnMs.push(Date.now() - turnStart);

  // Run edge check (timed)
  const edgeStart = Date.now();
  await evaluateEdge(ctx, state);
  timings.edgeCheckMs.push(Date.now() - edgeStart);

  const ratioDelta = state.current_ratio_target - initialRatio;
  const ratioDirection: 'push' | 'back-off' | 'hold' =
    ratioDelta < -0.005 ? 'push' : ratioDelta > 0.005 ? 'back-off' : 'hold';

  console.log(`\nResult:`);
  console.log(
    `  ratio: ${initialRatio.toFixed(2)} → ${state.current_ratio_target.toFixed(2)} ` +
      `(${ratioDelta >= 0 ? '+' : ''}${ratioDelta.toFixed(2)}, ${ratioDirection})`,
  );
  console.log(`  edge: ${state.edge_state}`);
  console.log(`  turn reason: ${state.last_turn_reason}`);
  console.log(`  edge reason: ${state.last_edge_reason}`);

  console.log('\nPrompt section that would be injected:');
  console.log('---');
  console.log(buildControllerPromptSection(state));
  console.log('---');

  const directionMatch = ratioDirection === scenario.expectedDirection;
  const edgeMatch = state.edge_state === scenario.expectedEdge;

  console.log(
    `\n  ratio direction: ${directionMatch ? 'PASS' : 'FAIL'} (got ${ratioDirection}, expected ${scenario.expectedDirection})`,
  );
  console.log(
    `  edge state:      ${edgeMatch ? 'PASS' : 'FAIL'} (got ${state.edge_state}, expected ${scenario.expectedEdge})`,
  );

  return directionMatch && edgeMatch;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main() {
  console.log('Difficulty Controller — synthetic scenario tests');
  console.log(`Running ${scenarios.length} scenarios...`);

  const timings = { evalTurnMs: [] as number[], edgeCheckMs: [] as number[] };

  let passed = 0;
  for (const scenario of scenarios) {
    const ok = await runScenario(scenario, timings);
    if (ok) passed++;
  }

  const avg = (a: number[]) =>
    a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0;

  console.log('\n════════════════════════════════════════════════');
  console.log(`RESULT: ${passed}/${scenarios.length} scenarios passed`);
  console.log('────────────────────────────────────────────────');
  console.log('LATENCY (Claude Haiku 4.5 classifier calls):');
  console.log(
    `  evaluateTurn:  avg ${avg(timings.evalTurnMs)}ms, ` +
      `p50 ${pct(timings.evalTurnMs, 0.5)}ms, ` +
      `p90 ${pct(timings.evalTurnMs, 0.9)}ms`,
  );
  console.log(
    `  evaluateEdge:  avg ${avg(timings.edgeCheckMs)}ms, ` +
      `p50 ${pct(timings.edgeCheckMs, 0.5)}ms, ` +
      `p90 ${pct(timings.edgeCheckMs, 0.9)}ms`,
  );
  console.log(
    `  Note: these run in parallel and fire-and-forget, so they don't block the LLM response.`,
  );
  console.log('════════════════════════════════════════════════');
  process.exit(passed === scenarios.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

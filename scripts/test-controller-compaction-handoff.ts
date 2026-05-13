import dotenv from 'dotenv';
dotenv.config({ override: true });

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';
import type { ControllerState } from '../src/difficulty-controller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPACTION_PROMPT = readFileSync(
  join(__dirname, '..', 'src', 'prompts', 'compaction-prompt.txt'),
  'utf-8',
);

/**
 * Verifies that <live_controller_state> in the compaction input actually
 * influences Sonnet's choice for tutor_core.bilingual_ratio_target.
 *
 * Strategy: feed the SAME ambiguous transcript twice to compaction, but with
 * different controller summaries. Compare the resulting bilingual_ratio_target.
 * If the controller summary is being respected, the two outputs should differ
 * in the same direction as the controller's signal.
 */

interface CompactionResult {
  tutor_core: { bilingual_ratio_target: number; [k: string]: unknown };
  learner_core: { proficiency: { bilingual_ratio: number }; [k: string]: unknown };
  fsrs_updates: unknown[];
  compaction_notes: string;
}

const AMBIGUOUS_TRANSCRIPT = [
  '[tutor] ¡Hola! How was your day?',
  '[learner] Bien, gracias. Trabajé mucho hoy.',
  '[tutor] ¿Sí? What kind of work do you do?',
  '[learner] Soy ingeniera. I work on software.',
  '[tutor] Qué interesante. ¿Te gusta tu trabajo?',
  '[learner] Sí, me gusta mucho.',
  '[tutor] ¡Qué bueno! Y, what do you do to relax after work?',
  '[learner] Me gusta cocinar y leer libros.',
].join('\n');

function buildControllerSummary(state: ControllerState): string {
  return `

<live_controller_state>
Final bilingual ratio target after this session: ${state.current_ratio_target.toFixed(2)} (${Math.round(
    state.current_ratio_target * 100,
  )}% English)
Final edge state: ${state.edge_state}
Last edge directive: ${state.last_edge_reason}
Last turn read: ${state.last_turn_reason}

Use this as a strong signal for tutor_core.bilingual_ratio_target. The ratio above
reflects the live difficulty controller's adjustments across the session — prefer it
over the entering value unless the transcript strongly suggests overshooting.
</live_controller_state>`;
}

async function runCompactionWithSummary(
  controllerSummary: string,
): Promise<CompactionResult> {
  const anthropic = new Anthropic();

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: COMPACTION_PROMPT,
    messages: [
      {
        role: 'user',
        content: `
<existing_learner_core>
${JSON.stringify(SEED_LEARNER_CORE, null, 2)}
</existing_learner_core>

<existing_tutor_core>
${JSON.stringify(SEED_TUTOR_CORE, null, 2)}
</existing_tutor_core>

<session_transcript>
${AMBIGUOUS_TRANSCRIPT}
</session_transcript>

<session_metrics>
Turn count: 4
Session duration: 6.0 minutes
</session_metrics>${controllerSummary}
        `.trim(),
      },
    ],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  return JSON.parse(clean);
}

async function main() {
  console.log('Controller → Compaction handoff test');
  console.log('Running TWO compactions on the SAME transcript with DIFFERENT controller signals.\n');

  // Signal 1: controller says learner is COASTING — wants more Spanish (lower English ratio)
  const coastingState: ControllerState = {
    current_ratio_target: 0.55,
    edge_state: 'coasting',
    last_turn_reason: 'Learner producing complex Spanish without effort.',
    last_edge_reason: 'Coasting → push toward more Spanish, introduce past tense.',
    last_evaluated_turn: 4,
    last_edge_check_turn: 4,
    recent_assessments: [],
  };

  // Signal 2: controller says learner is OVERWHELMED — wants more English (higher English ratio)
  const overwhelmedState: ControllerState = {
    current_ratio_target: 0.92,
    edge_state: 'overwhelmed',
    last_turn_reason: 'Learner expressing fatigue, frequent English fallback.',
    last_edge_reason: 'Overwhelmed → drop back to mostly English, simpler topics.',
    last_evaluated_turn: 4,
    last_edge_check_turn: 4,
    recent_assessments: [],
  };

  console.log('── Run A: controller signals COASTING (target 0.55) ──');
  const resultA = await runCompactionWithSummary(buildControllerSummary(coastingState));
  console.log(`  → tutor_core.bilingual_ratio_target = ${resultA.tutor_core.bilingual_ratio_target}`);
  console.log(`  → notes: ${resultA.compaction_notes.slice(0, 200)}...`);

  console.log('\n── Run B: controller signals OVERWHELMED (target 0.92) ──');
  const resultB = await runCompactionWithSummary(buildControllerSummary(overwhelmedState));
  console.log(`  → tutor_core.bilingual_ratio_target = ${resultB.tutor_core.bilingual_ratio_target}`);
  console.log(`  → notes: ${resultB.compaction_notes.slice(0, 200)}...`);

  // ── Run C: NO controller summary (baseline) ─────────────────────────
  console.log('\n── Run C: NO controller summary (baseline) ──');
  const resultC = await runCompactionWithSummary('');
  console.log(`  → tutor_core.bilingual_ratio_target = ${resultC.tutor_core.bilingual_ratio_target}`);
  console.log(`  → notes: ${resultC.compaction_notes.slice(0, 200)}...`);

  // ── Assertions ─────────────────────────────────────────────────────
  console.log('\n══════════ ASSERTIONS ══════════');

  const ratioA = resultA.tutor_core.bilingual_ratio_target;
  const ratioB = resultB.tutor_core.bilingual_ratio_target;
  const ratioC = resultC.tutor_core.bilingual_ratio_target;

  // 1. Coasting signal should produce LOWER bilingual_ratio_target than overwhelmed signal
  const directionOk = ratioA < ratioB;
  console.log(
    `  Coasting (A) < Overwhelmed (B): ${directionOk ? 'PASS' : 'FAIL'} ` +
      `(A=${ratioA}, B=${ratioB})`,
  );

  // 2. The signals should produce a meaningful spread (>0.10)
  const spread = ratioB - ratioA;
  const spreadOk = spread > 0.1;
  console.log(
    `  Spread (B - A) > 0.10: ${spreadOk ? 'PASS' : 'FAIL'} (Δ=${spread.toFixed(3)})`,
  );

  // 3. Controller signal should pull A and B further apart than baseline C
  // i.e. baseline should sit somewhere between (or close to) A and B
  const baselineReasonable =
    Math.min(ratioA, ratioB) - 0.05 <= ratioC &&
    ratioC <= Math.max(ratioA, ratioB) + 0.05;
  console.log(
    `  Baseline (C=${ratioC}) sits between A and B (±0.05): ${baselineReasonable ? 'PASS' : 'FAIL'}`,
  );

  const allPass = directionOk && spreadOk && baselineReasonable;
  console.log('\n════════════════════════════════════════════════');
  console.log(`OVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log('════════════════════════════════════════════════');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Handoff test failed:', err);
  process.exit(1);
});

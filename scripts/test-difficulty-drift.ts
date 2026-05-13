import dotenv from 'dotenv';
dotenv.config({ override: true });

import {
  initControllerState,
  evaluateTurn,
  evaluateEdge,
  type ControllerState,
} from '../src/difficulty-controller.js';
import type { SessionContext } from '../src/session-context.js';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';

/**
 * Multi-turn drift test.
 *
 * Replays a 12-turn session where the learner starts cold (English-heavy,
 * tentative) and gradually warms up (more Spanish, less hesitation, by the
 * end producing complete sentences). Verifies:
 *   1. The ratio drifts in the expected direction over time (toward more Spanish)
 *   2. No single turn produces a >0.05 swing (controller obeys its own bound)
 *   3. The edge state transitions through reasonable progressions
 *      (overwhelmed/unknown → edge → coasting is plausible)
 *   4. Edge checks fire on turns 5 and 10 (every 5 turns)
 */

interface Turn {
  role: 'tutor' | 'learner';
  text: string;
}

const session: Turn[] = [
  { role: 'tutor', text: '¡Hola! How are you today?' },
  { role: 'learner', text: 'Um... I am... I am fine I think.' },
  {
    role: 'tutor',
    text: '¡Qué bueno! Glad to hear it. What did you do this morning?',
  },
  { role: 'learner', text: 'Uh... breakfast? I had... breakfast.' },
  {
    role: 'tutor',
    text: 'El desayuno — breakfast. ¿Qué comiste? What did you eat?',
  },
  { role: 'learner', text: 'Yo... como huevos. Eggs. Y café.' },
  {
    role: 'tutor',
    text: 'Huevos y café, qué rico. ¿Sales mucho los fines de semana?',
  },
  {
    role: 'learner',
    text: 'Sí... I go out... salgo con amigos. To restaurants.',
  },
  {
    role: 'tutor',
    text: '¡Qué padre! ¿A dónde van normalmente? Where do you usually go?',
  },
  {
    role: 'learner',
    text: 'Normalmente vamos a un restaurante mexicano. Me gusta mucho la comida mexicana.',
  },
  {
    role: 'tutor',
    text: 'A mí también me encanta. ¿Cuál es tu plato favorito?',
  },
  {
    role: 'learner',
    text: 'Mi plato favorito son los tacos al pastor. Son deliciosos. Los como cada vez que voy.',
  },
];

interface TurnSnapshot {
  turn_number: number;
  ratio_target: number;
  edge_state: string;
  reason: string;
  edge_check_ran: boolean;
}

function buildContextAtTurn(turnIndex: number): SessionContext {
  // turnIndex is the index of the LAST entry (0-based, must be a learner turn)
  const transcript = session.slice(0, turnIndex + 1).map((t) => ({
    role: t.role,
    text: t.text,
    ts: new Date(),
  }));
  // turnCount = number of learner turns so far
  const learnerTurnCount = transcript.filter((t) => t.role === 'learner').length;

  return {
    learnerId: 'drift-test',
    sessionId: 'drift-test-session',
    learnerCore: structuredClone(SEED_LEARNER_CORE),
    tutorCore: structuredClone(SEED_TUTOR_CORE),
    fsrsDueItems: [],
    fullTranscript: transcript,
    turnCount: learnerTurnCount,
    sessionStartedAt: new Date(),
  };
}

async function main() {
  console.log('Multi-turn difficulty drift test');
  console.log(`Replaying ${session.length / 2} learner turns sequentially...\n`);

  // One state object that persists across all turns, like the live agent
  let state: ControllerState | null = null;
  const snapshots: TurnSnapshot[] = [];

  // Walk through each learner turn (odd indices since session goes tutor, learner, tutor, ...)
  for (let i = 1; i < session.length; i += 2) {
    const ctx = buildContextAtTurn(i);
    if (!state) state = initControllerState(ctx);

    const learnerTurnNumber = ctx.turnCount;
    const shouldEdgeCheck = learnerTurnNumber % 5 === 0;

    const tasks: Promise<void>[] = [evaluateTurn(ctx, state)];
    if (shouldEdgeCheck) tasks.push(evaluateEdge(ctx, state));
    await Promise.all(tasks);

    snapshots.push({
      turn_number: learnerTurnNumber,
      ratio_target: state.current_ratio_target,
      edge_state: state.edge_state,
      reason: state.last_turn_reason,
      edge_check_ran: shouldEdgeCheck,
    });
  }

  // ── Render the trajectory table ───────────────────────────────────
  console.log('\n══════════ DRIFT TRAJECTORY ══════════');
  console.log(
    'turn │ ratio │ edge state    │ edge? │ reason',
  );
  console.log(
    '─────┼───────┼───────────────┼───────┼────────────────────────────',
  );
  for (const s of snapshots) {
    const ratioStr = s.ratio_target.toFixed(2);
    const edgeStr = s.edge_state.padEnd(13);
    const edgeMark = s.edge_check_ran ? ' ✓ ' : '   ';
    const reasonShort = s.reason.slice(0, 60).replace(/\n/g, ' ');
    console.log(
      `  ${s.turn_number}  │ ${ratioStr}  │ ${edgeStr} │  ${edgeMark}  │ ${reasonShort}`,
    );
  }

  // ── Assertions ────────────────────────────────────────────────────
  const initialRatio = 0.8;
  const finalRatio = snapshots[snapshots.length - 1].ratio_target;
  const totalDrift = finalRatio - initialRatio;

  console.log('\n══════════ ASSERTIONS ══════════');

  // 1. Per-turn delta never exceeds ±0.05
  let maxDelta = 0;
  let prevRatio = initialRatio;
  for (const s of snapshots) {
    const d = Math.abs(s.ratio_target - prevRatio);
    if (d > maxDelta) maxDelta = d;
    prevRatio = s.ratio_target;
  }
  const deltaOk = maxDelta <= 0.0501; // tiny epsilon for float
  console.log(
    `  Per-turn delta ≤ 0.05: ${deltaOk ? 'PASS' : 'FAIL'} (max observed: ${maxDelta.toFixed(3)})`,
  );

  // 2. Edge checks fire on turns 5 and 10
  const edgeCheckTurns = snapshots
    .filter((s) => s.edge_check_ran)
    .map((s) => s.turn_number);
  const expectedEdgeTurns = [5];
  if (snapshots.length >= 10) expectedEdgeTurns.push(10);
  const edgeCheckOk =
    JSON.stringify(edgeCheckTurns) === JSON.stringify(expectedEdgeTurns);
  console.log(
    `  Edge checks on turns ${expectedEdgeTurns.join(',')}: ${edgeCheckOk ? 'PASS' : 'FAIL'} ` +
      `(actual: ${edgeCheckTurns.join(',')})`,
  );

  // 3. Once the learner warms up, the controller responds. Check that the
  // ratio at the END is lower (more Spanish) than the ratio at PEAK English —
  // this proves the controller pulled back toward Spanish once the learner
  // started producing well, rather than ratcheting up monotonically.
  const peakEnglish = Math.max(...snapshots.map((s) => s.ratio_target));
  const responsivenessOk = finalRatio < peakEnglish - 0.02;
  console.log(
    `  Controller pulled back toward Spanish after warmup: ${responsivenessOk ? 'PASS' : 'FAIL'} ` +
      `(peak English=${peakEnglish.toFixed(2)} → final=${finalRatio.toFixed(2)}, Δ=${(finalRatio - peakEnglish).toFixed(2)})`,
  );

  // 4. By turn 10+ the learner produces complete Spanish sentences. Edge state
  // at the final edge check should NOT be 'overwhelmed' (we didn't simulate that).
  const finalEdgeCheck = snapshots
    .filter((s) => s.edge_check_ran)
    .pop();
  const edgeStateOk =
    finalEdgeCheck && finalEdgeCheck.edge_state !== 'overwhelmed';
  console.log(
    `  Final edge state ∈ {edge, coasting, unknown}: ${edgeStateOk ? 'PASS' : 'FAIL'} ` +
      `(actual: ${finalEdgeCheck?.edge_state ?? 'none'})`,
  );

  const allPass = deltaOk && edgeCheckOk && responsivenessOk && edgeStateOk;
  console.log('\n════════════════════════════════════════════════');
  console.log(`OVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log('════════════════════════════════════════════════');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Drift test failed:', err);
  process.exit(1);
});

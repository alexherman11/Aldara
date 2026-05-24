/**
 * Pure-function unit tests for the placement calibration math.
 *
 * Verifies the contract that:
 *   - CEFR ↔ ratio maps round-trip and ratioToCefr snaps to the nearest bucket
 *   - the placement opens ABOVE the self-rated ratio (more English / more basic)
 *   - calibrationGain decays monotonically from START toward FLOOR
 *   - applyCalibrationTurn converges current_ratio_target onto a steady
 *     demonstrated signal, with early steps moving more than later steps
 *   - the ratio stays in [0.10, 0.95] under extreme/oscillating signals
 *   - finalizePlacement falls back to the marked level with zero turns, and
 *     reports high confidence only when recent estimates cluster tightly
 *
 * No network, no Anthropic, sub-second runtime — runs every commit.
 */

import {
  applyCalibrationTurn,
  calibrationGain,
  cefrToRatio,
  ratioToCefr,
  clampRatio,
  finalizePlacement,
  initControllerState,
  CEFR_TO_RATIO,
  CALIBRATION_GAIN_START,
  CALIBRATION_GAIN_FLOOR,
  PLACEMENT_START_OFFSET,
  MIN_RATIO_TARGET,
  MAX_RATIO_TARGET,
  type CalibrationTurn,
  type ControllerState,
} from '../src/difficulty-controller.js';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';
import type { SessionContext } from '../src/session-context.js';

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

function calibrationState(markedCefr: string): ControllerState {
  const ctx: SessionContext = {
    learnerId: 'unit',
    sessionId: 'unit',
    learnerCore: structuredClone(SEED_LEARNER_CORE),
    tutorCore: structuredClone(SEED_TUTOR_CORE),
    fsrsDueItems: [],
    mode: 'placement',
    markedCefrLevel: markedCefr,
    fullTranscript: [],
    turnCount: 0,
    sessionStartedAt: new Date(),
    recentAssessments: [],
  };
  return initControllerState(ctx, 'calibration');
}

function mkTurn(demonstratedRatio: number): CalibrationTurn {
  return {
    demonstrated_ratio: demonstratedRatio,
    demonstrated_cefr: ratioToCefr(demonstratedRatio),
    confidence: 0.5,
    tenses_observed: ['present'],
    notes: 'test',
  };
}

console.log('── Placement calibration math ──\n');

// ── 1. CEFR ↔ ratio maps ─────────────────────────────────────────────
console.log('1. CEFR ↔ ratio mapping');
check('cefrToRatio(B1) === map value', cefrToRatio('B1') === CEFR_TO_RATIO.B1);
check('cefrToRatio is case-insensitive', cefrToRatio('b1') === CEFR_TO_RATIO.B1);
check('cefrToRatio(undefined) falls back to A1', cefrToRatio(undefined) === CEFR_TO_RATIO.A1);
check('cefrToRatio(garbage) falls back to A1', cefrToRatio('ZZ') === CEFR_TO_RATIO.A1);
check(
  'ratioToCefr round-trips every bucket',
  (['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const).every(
    (lvl) => ratioToCefr(CEFR_TO_RATIO[lvl]) === lvl,
  ),
);
check(
  'ratioToCefr snaps to nearest bucket',
  ratioToCefr(CEFR_TO_RATIO.B1 + 0.02) === 'B1',
  `0.47 → ${ratioToCefr(CEFR_TO_RATIO.B1 + 0.02)}`,
);
check(
  'higher CEFR means less English',
  CEFR_TO_RATIO.A1 > CEFR_TO_RATIO.B1 && CEFR_TO_RATIO.B1 > CEFR_TO_RATIO.C1,
);

// ── 2. Placement opens below the self-rated level ────────────────────
console.log('\n2. Placement start sits below the marked level');
{
  const s = calibrationState('B1');
  check(
    'marked_ratio matches the self-rated CEFR',
    Math.abs(s.marked_ratio - CEFR_TO_RATIO.B1) < 1e-9,
  );
  check(
    'opens with MORE English than marked (a gentler start)',
    s.current_ratio_target > s.marked_ratio,
    `start=${s.current_ratio_target.toFixed(2)} marked=${s.marked_ratio.toFixed(2)}`,
  );
  check(
    'start offset is ~PLACEMENT_START_OFFSET above marked',
    Math.abs(s.current_ratio_target - (s.marked_ratio + PLACEMENT_START_OFFSET)) < 1e-9,
  );
}
{
  // A1 + offset exceeds MAX — must clamp, not overflow.
  const s = calibrationState('A1');
  check(
    'A1 start clamps to MAX_RATIO_TARGET',
    Math.abs(s.current_ratio_target - MAX_RATIO_TARGET) < 1e-9,
    `start=${s.current_ratio_target}`,
  );
}
check('mode is calibration', calibrationState('B1').mode === 'calibration');

// ── 3. Gain decays from START toward FLOOR ───────────────────────────
console.log('\n3. Convergence gain decays monotonically');
{
  const gains = [0, 1, 2, 3, 4, 5, 10, 20].map((i) => calibrationGain(i));
  check('gain(0) === CALIBRATION_GAIN_START', Math.abs(gains[0] - CALIBRATION_GAIN_START) < 1e-9);
  check(
    'gain strictly decreases over the first steps',
    gains[0] > gains[1] && gains[1] > gains[2] && gains[2] > gains[3],
    `${gains.slice(0, 4).map((g) => g.toFixed(3)).join(' > ')}`,
  );
  check(
    'gain approaches FLOOR but never drops below it',
    gains.every((g) => g >= CALIBRATION_GAIN_FLOOR - 1e-9) &&
      gains[gains.length - 1] < CALIBRATION_GAIN_FLOOR + 0.01,
    `gain(20)=${gains[gains.length - 1].toFixed(4)}`,
  );
}

// ── 4. Convergence onto a steady signal ──────────────────────────────
console.log('\n4. Ratio converges onto a steady demonstrated signal');
{
  const s = calibrationState('B1'); // opens ~0.63
  const demonstrated = 0.30;
  for (let i = 0; i < 8; i++) applyCalibrationTurn(s, mkTurn(demonstrated));
  check(
    'after 8 steady turns, ratio is within 0.04 of the demonstrated level',
    Math.abs(s.current_ratio_target - demonstrated) < 0.04,
    `ratio=${s.current_ratio_target.toFixed(3)} target=${demonstrated}`,
  );
  check('calibration_step_count tracks turns applied', s.calibration_step_count === 8);
  check('calibration_turns recorded all 8 observations', s.calibration_turns.length === 8);
}

// ── 5. Early steps move more than later steps (refinement) ───────────
console.log('\n5. Early corrections are larger than later ones');
{
  const s = calibrationState('B1');
  const demonstrated = 0.25;
  const moves: number[] = [];
  for (let i = 0; i < 5; i++) {
    const before = s.current_ratio_target;
    applyCalibrationTurn(s, mkTurn(demonstrated));
    moves.push(Math.abs(s.current_ratio_target - before));
  }
  check(
    'each successive correction is smaller than the last',
    moves[0] > moves[1] && moves[1] > moves[2] && moves[2] > moves[3],
    moves.map((m) => m.toFixed(3)).join(' > '),
  );
}

// ── 6. Ratio stays bounded under extreme / oscillating signals ───────
console.log('\n6. Ratio stays in [0.10, 0.95] under stress');
{
  const s = calibrationState('B1');
  for (let i = 0; i < 40; i++) {
    // Demonstrated values well outside the valid band, alternating hard.
    applyCalibrationTurn(s, mkTurn(i % 2 === 0 ? 1.5 : -0.5));
    if (s.current_ratio_target < MIN_RATIO_TARGET - 1e-9 ||
        s.current_ratio_target > MAX_RATIO_TARGET + 1e-9) {
      break;
    }
  }
  check(
    'oscillating out-of-range signals never escape the band',
    s.current_ratio_target >= MIN_RATIO_TARGET - 1e-9 &&
      s.current_ratio_target <= MAX_RATIO_TARGET + 1e-9,
    `ratio=${s.current_ratio_target.toFixed(3)}`,
  );
}
check('clampRatio pins below MIN', clampRatio(-1) === MIN_RATIO_TARGET);
check('clampRatio pins above MAX', clampRatio(2) === MAX_RATIO_TARGET);

// ── 7. finalizePlacement ─────────────────────────────────────────────
console.log('\n7. finalizePlacement');
{
  // Zero turns — learner skipped immediately → fall back to the marked level.
  const s = calibrationState('B1');
  const r = finalizePlacement(s);
  check('zero turns → marked CEFR', r.cefr_level === 'B1', `got ${r.cefr_level}`);
  check('zero turns → not converged', r.converged === false);
  check('zero turns → calibration_turns 0', r.calibration_turns === 0);
}
{
  // Tight cluster of recent estimates → high confidence, converged.
  const s = calibrationState('B2');
  for (let i = 0; i < 6; i++) applyCalibrationTurn(s, mkTurn(0.30));
  const r = finalizePlacement(s);
  check('tight cluster → high confidence', r.confidence >= 0.6, `conf=${r.confidence.toFixed(2)}`);
  check('tight cluster → converged', r.converged === true);
  check(
    'placed CEFR matches the converged ratio',
    r.cefr_level === ratioToCefr(s.current_ratio_target),
  );
}
{
  // Wildly spread recent estimates → low confidence, not converged.
  const s = calibrationState('B1');
  applyCalibrationTurn(s, mkTurn(0.30));
  applyCalibrationTurn(s, mkTurn(0.70));
  applyCalibrationTurn(s, mkTurn(0.30));
  const r = finalizePlacement(s);
  check('spread estimates → low confidence', r.confidence < 0.6, `conf=${r.confidence.toFixed(2)}`);
  check('spread estimates → not converged', r.converged === false);
}

console.log('\n════════════════════════════════════════════════');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);

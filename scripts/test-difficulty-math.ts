/**
 * Pure-function unit tests for the difficulty controller math.
 *
 * Verifies the contract that:
 *   - per-turn delta is clamped to ±0.05 regardless of what the LLM emits
 *   - ratio target stays in [0.10, 0.95] across any sequence of updates
 *   - recent_assessments window is capped at 5 (FIFO eviction)
 *   - last_turn_reason / last_evaluated_turn are stamped exactly
 *   - applyTurnAssessment is idempotent against a no-op delta of 0
 *
 * No network, no Anthropic, sub-second runtime — runs every commit.
 */

import {
  applyTurnAssessment,
  initControllerState,
  MAX_RATIO_DELTA,
  MAX_RATIO_TARGET,
  MIN_RATIO_TARGET,
  RECENT_ASSESSMENTS_WINDOW,
  type ControllerState,
  type TurnAssessment,
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

function freshState(): ControllerState {
  const ctx: SessionContext = {
    learnerId: 'unit',
    sessionId: 'unit',
    learnerCore: structuredClone(SEED_LEARNER_CORE),
    tutorCore: structuredClone(SEED_TUTOR_CORE),
    fsrsDueItems: [],
    fullTranscript: [],
    turnCount: 0,
    sessionStartedAt: new Date(),
    recentAssessments: [],
  };
  return initControllerState(ctx);
}

function mkAssessment(delta: number, reason = 'test'): TurnAssessment {
  return {
    signals: {
      hesitated: false,
      self_corrected: false,
      asked_for_translation: false,
      answered_in_english_when_spanish_expected: false,
      nailed_it: false,
      expressed_frustration: false,
    },
    ratio_delta: delta,
    reason,
  };
}

console.log('── Difficulty controller math ──\n');

// ── 1. Bounds constants are sane ─────────────────────────────────────
console.log('1. Constants');
check('MIN < MAX', MIN_RATIO_TARGET < MAX_RATIO_TARGET);
check('MAX delta is positive', MAX_RATIO_DELTA > 0);
check('Window is positive', RECENT_ASSESSMENTS_WINDOW > 0);

// ── 2. Delta clamping ───────────────────────────────────────────────
console.log('\n2. Per-turn delta clamping (±0.05)');
{
  const s = freshState();
  s.current_ratio_target = 0.5;
  applyTurnAssessment(s, mkAssessment(0.5, 'huge positive'), 1);
  check(
    'huge positive delta clamped to +0.05',
    Math.abs(s.current_ratio_target - 0.55) < 1e-9,
    `ratio=${s.current_ratio_target}`,
  );
}
{
  const s = freshState();
  s.current_ratio_target = 0.5;
  applyTurnAssessment(s, mkAssessment(-0.5, 'huge negative'), 1);
  check(
    'huge negative delta clamped to -0.05',
    Math.abs(s.current_ratio_target - 0.45) < 1e-9,
    `ratio=${s.current_ratio_target}`,
  );
}
{
  const s = freshState();
  s.current_ratio_target = 0.5;
  applyTurnAssessment(s, mkAssessment(0.0, 'neutral'), 1);
  check(
    'zero delta is a no-op on ratio',
    Math.abs(s.current_ratio_target - 0.5) < 1e-9,
  );
}

// ── 3. Ratio bounds across long sequences ───────────────────────────
console.log('\n3. Ratio bounds [0.10, 0.95] under sustained pressure');
{
  // Push toward more Spanish (negative delta) 100× — should pin at MIN, never go below.
  const s = freshState();
  for (let i = 0; i < 100; i++) {
    applyTurnAssessment(s, mkAssessment(-0.05, 'push'), i + 1);
  }
  check(
    'sustained negative deltas pin at MIN_RATIO_TARGET',
    Math.abs(s.current_ratio_target - MIN_RATIO_TARGET) < 1e-9,
    `ratio=${s.current_ratio_target}`,
  );
}
{
  // Push toward more English 100× — should pin at MAX.
  const s = freshState();
  for (let i = 0; i < 100; i++) {
    applyTurnAssessment(s, mkAssessment(+0.05, 'back off'), i + 1);
  }
  check(
    'sustained positive deltas pin at MAX_RATIO_TARGET',
    Math.abs(s.current_ratio_target - MAX_RATIO_TARGET) < 1e-9,
    `ratio=${s.current_ratio_target}`,
  );
}

// ── 4. Window capping ────────────────────────────────────────────────
console.log('\n4. recent_assessments window cap');
{
  const s = freshState();
  for (let i = 0; i < 12; i++) {
    applyTurnAssessment(s, mkAssessment(0.01, `r${i}`), i + 1);
  }
  check(
    `window length is exactly ${RECENT_ASSESSMENTS_WINDOW}`,
    s.recent_assessments.length === RECENT_ASSESSMENTS_WINDOW,
    `len=${s.recent_assessments.length}`,
  );
  check(
    'oldest entries evicted (FIFO)',
    s.recent_assessments[0].reason === `r${12 - RECENT_ASSESSMENTS_WINDOW}`,
    `first.reason=${s.recent_assessments[0].reason}`,
  );
  check(
    'newest entry preserved at tail',
    s.recent_assessments[s.recent_assessments.length - 1].reason === 'r11',
  );
}

// ── 5. Stamping behavior ─────────────────────────────────────────────
console.log('\n5. State stamping');
{
  const s = freshState();
  applyTurnAssessment(s, mkAssessment(-0.02, 'because reason'), 7);
  check('last_evaluated_turn stamped', s.last_evaluated_turn === 7);
  check('last_turn_reason stamped', s.last_turn_reason === 'because reason');
}

// ── 6. Idempotence of no-op deltas ───────────────────────────────────
console.log('\n6. Repeated no-op deltas keep ratio stable');
{
  const s = freshState();
  s.current_ratio_target = 0.42;
  for (let i = 0; i < 20; i++) {
    applyTurnAssessment(s, mkAssessment(0, 'noop'), i + 1);
  }
  check(
    'ratio unchanged after 20 zero-delta applications',
    Math.abs(s.current_ratio_target - 0.42) < 1e-9,
    `ratio=${s.current_ratio_target}`,
  );
}

// ── 7. Alternating positive/negative converges, not diverges ─────────
console.log('\n7. Alternating ±0.05 over 100 turns stays bounded');
{
  const s = freshState();
  s.current_ratio_target = 0.5;
  for (let i = 0; i < 100; i++) {
    applyTurnAssessment(s, mkAssessment(i % 2 === 0 ? +0.05 : -0.05, 'osc'), i + 1);
  }
  check(
    'oscillating deltas leave ratio in valid bounds',
    s.current_ratio_target >= MIN_RATIO_TARGET &&
      s.current_ratio_target <= MAX_RATIO_TARGET,
    `ratio=${s.current_ratio_target}`,
  );
  check(
    'window only retains last 5 assessments under heavy oscillation',
    s.recent_assessments.length === RECENT_ASSESSMENTS_WINDOW,
  );
}

console.log('\n════════════════════════════════════════════════');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);

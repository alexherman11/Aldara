import Anthropic from '@anthropic-ai/sdk';
import type { SessionContext, TranscriptEntry } from './session-context.js';

/**
 * Per-turn difficulty controller.
 *
 * After each learner turn, classifies how the learner handled the previous
 * tutor turn and produces a small adjustment to the bilingual ratio target
 * for the NEXT tutor turn. Every 5 turns, runs a deeper "edge check" that
 * decides whether the learner is coasting, on-edge, or overwhelmed and
 * produces a directive for the tutor's next move.
 *
 * Designed to run as fire-and-forget after onUserTurnCompleted so it never
 * blocks the LLM response. The result lands in SessionContext.controllerState
 * and is picked up on the next prompt rebuild.
 */

// Lazy-init so the client picks up env vars set after this module is imported
// (ESM hoists imports above the statements that load .env, so constructing the
// client at top-level would race the env load).
let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export type EdgeState = 'coasting' | 'edge' | 'overwhelmed' | 'unknown';

export interface TurnAssessment {
  signals: {
    hesitated: boolean;
    self_corrected: boolean;
    asked_for_translation: boolean;
    answered_in_english_when_spanish_expected: boolean;
    nailed_it: boolean;
    expressed_frustration: boolean;
  };
  ratio_delta: number;
  reason: string;
}

export interface EdgeAssessment {
  state: EdgeState;
  directive: string;
  reason: string;
}

/**
 * 'normal' — the per-turn ± ratio nudge controller used in tutoring sessions.
 * 'calibration' — the placement controller: opens the learner BELOW their
 * self-rated level and converges on their true level with a decaying step
 * size (big early corrections, fine refinement later).
 */
export type ControllerMode = 'normal' | 'calibration';

/** One placement-turn observation produced by the calibration classifier. */
export interface CalibrationTurn {
  /** English fraction (0..1) the learner actually seems comfortable with. */
  demonstrated_ratio: number;
  /** CEFR bucket that ratio corresponds to. */
  demonstrated_cefr: string;
  /** Classifier confidence (0..1) given how much the learner has said so far. */
  confidence: number;
  /** Verb tenses the learner attempted this turn. */
  tenses_observed: string[];
  /** One-sentence read of what the turn revealed. */
  notes: string;
}

export interface ControllerState {
  mode: ControllerMode;
  current_ratio_target: number;
  edge_state: EdgeState;
  last_turn_reason: string;
  last_edge_reason: string;
  last_evaluated_turn: number;
  last_edge_check_turn: number;
  recent_assessments: TurnAssessment[];
  /** English ratio for the learner's self-reported CEFR (calibration only). */
  marked_ratio: number;
  /** Per-turn calibration observations, in order (calibration only). */
  calibration_turns: CalibrationTurn[];
  /** Count of calibration updates applied — drives the decaying gain. */
  calibration_step_count: number;
}

export function initControllerState(
  ctx: SessionContext,
  mode: ControllerMode = 'normal',
): ControllerState {
  const markedRatio = cefrToRatio(
    ctx.markedCefrLevel ?? ctx.learnerCore?.proficiency?.cefr_level,
  );
  // Placement opens BELOW the self-rated level (more English) so the first
  // minute is an easy win; calibration then converges up or down from there.
  const startRatio =
    mode === 'calibration'
      ? clampRatio(markedRatio + PLACEMENT_START_OFFSET)
      : ctx.tutorCore?.bilingual_ratio_target ?? 0.8;
  return {
    mode,
    current_ratio_target: startRatio,
    edge_state: 'unknown',
    last_turn_reason: 'No turns evaluated yet.',
    last_edge_reason: 'No edge check yet.',
    last_evaluated_turn: 0,
    last_edge_check_turn: 0,
    recent_assessments: [],
    marked_ratio: markedRatio,
    calibration_turns: [],
    calibration_step_count: 0,
  };
}

/**
 * Bounds on the ratio target and the per-turn delta. Kept as named constants
 * because both the LLM call and the unit tests need to agree on them.
 */
export const MIN_RATIO_TARGET = 0.10;
export const MAX_RATIO_TARGET = 0.95;
export const MAX_RATIO_DELTA = 0.05;
export const RECENT_ASSESSMENTS_WINDOW = 5;

/** Clamp a ratio into the controller's valid band. */
export function clampRatio(r: number): number {
  return Math.max(MIN_RATIO_TARGET, Math.min(MAX_RATIO_TARGET, r));
}

// ── CEFR ↔ bilingual-ratio mapping ───────────────────────────────────
// The bilingual ratio is the fraction of tutor output spoken in English.
// 1.0 = all English, 0.0 = all Spanish. Higher CEFR → less English needed.
export const CEFR_TO_RATIO: Record<string, number> = {
  A1: 0.85,
  A2: 0.65,
  B1: 0.45,
  B2: 0.28,
  C1: 0.15,
  C2: 0.10,
};

const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

/** Map a CEFR level to its canonical English ratio (defaults to A1). */
export function cefrToRatio(cefr: string | undefined | null): number {
  if (!cefr) return CEFR_TO_RATIO.A1;
  return CEFR_TO_RATIO[cefr.toUpperCase()] ?? CEFR_TO_RATIO.A1;
}

/** Map a bilingual ratio back to the nearest CEFR bucket. */
export function ratioToCefr(ratio: number): string {
  let best: string = CEFR_ORDER[0];
  let bestDist = Infinity;
  for (const lvl of CEFR_ORDER) {
    const d = Math.abs(CEFR_TO_RATIO[lvl] - ratio);
    if (d < bestDist) {
      bestDist = d;
      best = lvl;
    }
  }
  return best;
}

// ── Placement calibration ────────────────────────────────────────────
// The placement opens this much MORE English (more basic) than the
// learner's self-rated level — a deliberate easy start before converging.
export const PLACEMENT_START_OFFSET = 0.18;

// Decaying-gain convergence. Each placement turn moves current_ratio_target
// a fraction of the way toward the learner's demonstrated comfort level. The
// gain starts large (big early corrections, overshoot allowed) and decays to
// a floor (fine refinement) — a curve converging onto a tangent line.
export const CALIBRATION_GAIN_START = 0.6;
export const CALIBRATION_GAIN_FLOOR = 0.15;
export const CALIBRATION_GAIN_DECAY = 0.6;

/** Convergence gain for the Nth (0-indexed) calibration step. */
export function calibrationGain(stepIndex: number): number {
  return (
    CALIBRATION_GAIN_FLOOR +
    (CALIBRATION_GAIN_START - CALIBRATION_GAIN_FLOOR) *
      Math.pow(CALIBRATION_GAIN_DECAY, Math.max(0, stepIndex))
  );
}

/**
 * Pure-function update: clamp the delta, apply it to the ratio target with
 * bounds, append the assessment to the rolling window, and stamp the turn
 * number. Extracted from `evaluateTurn` so it can be exercised without an
 * Anthropic round-trip. The LLM call's job is now reduced to producing the
 * TurnAssessment; this function is the part we can verify deterministically.
 */
export function applyTurnAssessment(
  state: ControllerState,
  assessment: TurnAssessment,
  turnNumber: number,
): ControllerState {
  const delta = Math.max(
    -MAX_RATIO_DELTA,
    Math.min(MAX_RATIO_DELTA, assessment.ratio_delta),
  );
  state.current_ratio_target = Math.max(
    MIN_RATIO_TARGET,
    Math.min(MAX_RATIO_TARGET, state.current_ratio_target + delta),
  );
  state.last_turn_reason = assessment.reason;
  state.last_evaluated_turn = turnNumber;
  state.recent_assessments.push(assessment);
  if (state.recent_assessments.length > RECENT_ASSESSMENTS_WINDOW) {
    state.recent_assessments.shift();
  }
  return state;
}

/** Outcome of a placement conversation — what level to start the learner at. */
export interface PlacementResult {
  cefr_level: string;
  /** Converged English ratio. */
  ratio: number;
  /** 0..1 — how tightly the recent estimates clustered. */
  confidence: number;
  calibration_turns: number;
  /** True once confidence cleared the bar; false means we used a soft default. */
  converged: boolean;
}

/**
 * Pure convergence update for one placement turn. Moves current_ratio_target a
 * decaying fraction of the way toward the learner's demonstrated comfort ratio,
 * records the observation, and bumps the step counter. Extracted from
 * `evaluateCalibrationTurn` so the convergence math is unit-testable without an
 * Anthropic round-trip.
 */
export function applyCalibrationTurn(
  state: ControllerState,
  turn: CalibrationTurn,
): ControllerState {
  const gain = calibrationGain(state.calibration_step_count);
  const target = clampRatio(turn.demonstrated_ratio);
  state.current_ratio_target = clampRatio(
    state.current_ratio_target + gain * (target - state.current_ratio_target),
  );
  state.calibration_turns.push(turn);
  state.calibration_step_count += 1;
  state.last_turn_reason = turn.notes || state.last_turn_reason;
  return state;
}

/**
 * Resolve the placement outcome from the controller state. With zero
 * calibration turns (learner skipped immediately) we fall back to the
 * self-rated level. Otherwise the converged ratio IS the result; confidence is
 * the inverse spread of the last few demonstrated-ratio estimates — a tight
 * cluster means calibration settled.
 */
export function finalizePlacement(state: ControllerState): PlacementResult {
  const turns = state.calibration_turns;
  if (turns.length === 0) {
    return {
      cefr_level: ratioToCefr(state.marked_ratio),
      ratio: state.marked_ratio,
      confidence: 0,
      calibration_turns: 0,
      converged: false,
    };
  }
  const ratio = clampRatio(state.current_ratio_target);
  const recent = turns.slice(-3).map((t) => t.demonstrated_ratio);
  const spread =
    recent.length > 1 ? Math.max(...recent) - Math.min(...recent) : 0.4;
  // spread 0 → confidence 1; spread ≥ 0.4 → confidence 0.
  const confidence = Math.max(0, Math.min(1, 1 - spread / 0.4));
  return {
    cefr_level: ratioToCefr(ratio),
    ratio,
    confidence,
    calibration_turns: turns.length,
    converged: confidence >= 0.6,
  };
}

const TURN_CLASSIFIER_PROMPT = `You are the difficulty controller for a Spanish-English language tutor named Sofía. After each learner turn, you classify how the learner handled the previous tutor turn and adjust the bilingual ratio (English vs Spanish) for the next turn.

The bilingual ratio is the fraction of the tutor's output that should be in English. 1.0 = fully English, 0.0 = fully Spanish. A1 learners typically sit around 0.80 (mostly English with sprinkled Spanish), B1 around 0.45, B2 around 0.25.

You will be given:
- The current ratio target
- The tutor's previous turn
- The learner's response

Output a JSON object with this exact shape:
{
  "signals": {
    "hesitated": boolean,            // long pauses, "umm", "uhh", trailing off
    "self_corrected": boolean,       // started a word, restarted, fixed themselves
    "asked_for_translation": boolean, // "what does X mean?", "how do I say X?"
    "answered_in_english_when_spanish_expected": boolean, // tutor cued Spanish, learner used English
    "nailed_it": boolean,            // produced clean, confident Spanish appropriate to their level
    "expressed_frustration": boolean // "this is hard", "I can't", sighing/giving up cues
  },
  "ratio_delta": number,             // -0.05 to +0.05. Negative = MORE Spanish (push). Positive = MORE English (back off).
  "reason": string                   // one short sentence explaining the delta
}

HARD CEILING — the learner's English usage is the limit:
The tutor must NEVER use more English than the learner does. Estimate the fraction of the learner's response that was spoken in English. The ratio target must never exceed that fraction. If the current ratio target is already above the learner's English usage, output a negative ratio_delta to pull it back down toward their level — this overrides every principle below. Adding English is acceptable only up to the point where the tutor matches the learner, never past it.

Adjustment principles (applied only within the ceiling above):
- Nailed it + no struggle → ratio_delta -0.03 (push toward more Spanish)
- Hesitation + self-correction but landed it → ratio_delta -0.01 (slight push, they're learning)
- Frustration or asked-for-translation → ratio_delta +0.04 (back off, give breathing room — but never above the learner's own English usage)
- Answered in English when Spanish expected → ratio_delta 0 (mirror them; do not escalate English beyond what they just used)
- Default if nothing notable → ratio_delta 0
- Never exceed ±0.05 in a single turn.

Respond with ONLY the JSON object, no markdown fences, no preamble.`;

const EDGE_CHECK_PROMPT = `You are the edge-check evaluator for a Spanish-English language tutor. Every 5 turns you take a step back and judge whether the learner is on the productive edge of their ability, coasting (too easy), or overwhelmed (too hard).

You will be given the last 5 turns of conversation and the current ratio target.

Output a JSON object:
{
  "state": "coasting" | "edge" | "overwhelmed",
  "directive": string,  // ONE concrete instruction for the tutor's next move (max 25 words)
  "reason": string      // one short sentence explaining the state
}

Definitions:
- "edge": the learner is producing with effort but succeeding. Mistakes are productive — they reveal the next thing to learn. This is the goal.
- "coasting": the learner is responding fluidly with no visible effort. The tutor should introduce a new construction, a harder verb tense, or a topic the learner cares about but lacks vocabulary for.
- "overwhelmed": the learner is shutting down, defaulting to English, expressing frustration, or producing nothing. The tutor should retreat to a comfort topic, slow down, and build a small win.

The directive should be specific and actionable, e.g.:
- "Introduce one new past-tense verb in context of a story they tell."
- "Drop back to present tense and ask about their weekend."
- "They mentioned coffee — pivot the conversation there and let them lead."

Respond with ONLY the JSON object.`;

/**
 * Classify the learner's most recent turn and update the controller state.
 * Safe to fire-and-forget — never throws to the caller.
 */
export async function evaluateTurn(
  ctx: SessionContext,
  state: ControllerState,
): Promise<void> {
  const transcript = ctx.fullTranscript;
  if (transcript.length < 2) return;

  // Find the most recent learner turn and the tutor turn before it
  let learnerTurn: TranscriptEntry | null = null;
  let tutorTurn: TranscriptEntry | null = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (!learnerTurn && e.role === 'learner') {
      learnerTurn = e;
    } else if (learnerTurn && !tutorTurn && e.role === 'tutor') {
      tutorTurn = e;
      break;
    }
  }
  if (!learnerTurn || !tutorTurn) return;

  try {
    const resp = await getAnthropic().messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 400,
      system: TURN_CLASSIFIER_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            `Current ratio target: ${state.current_ratio_target.toFixed(2)} (${Math.round(
              state.current_ratio_target * 100,
            )}% English)`,
            `CEFR level: ${ctx.learnerCore?.proficiency?.cefr_level ?? 'A1'}`,
            '',
            `[tutor previous turn]`,
            tutorTurn.text,
            '',
            `[learner response]`,
            learnerTurn.text,
          ].join('\n'),
        },
      ],
    });

    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    const assessment: TurnAssessment = JSON.parse(clean);

    // Capture pre-state for the log line so we report the actual applied delta.
    const before = state.current_ratio_target;
    applyTurnAssessment(state, assessment, ctx.turnCount);
    const appliedDelta = state.current_ratio_target - before;

    console.log(
      `[difficulty] turn ${ctx.turnCount}: Δ=${appliedDelta >= 0 ? '+' : ''}${appliedDelta.toFixed(2)} ` +
        `→ ratio=${state.current_ratio_target.toFixed(2)} (${assessment.reason})`,
    );
  } catch (err) {
    console.warn('[difficulty] evaluateTurn failed:', err);
  }
}

const CALIBRATION_CLASSIFIER_PROMPT = `You are the placement calibrator for a Spanish-English language tutor named Sofía. A new learner is in a short spoken placement conversation. After each learner turn you estimate the Spanish level the learner is ACTUALLY demonstrating — in both comprehension and production — regardless of what they self-reported.

You will be given:
- The learner's self-reported CEFR level
- The current bilingual ratio target (fraction of tutor speech that is English; 1.0 = all English, 0.0 = all Spanish)
- The last several turns of the conversation
- Which placement turn this is

Estimate the bilingual ratio the learner is genuinely comfortable with RIGHT NOW. Weigh these signals:
- How much of Sofía's Spanish did they understand without help?
- How much Spanish did they produce, and how accurate was it?
- Which verb tenses did they attempt, and did they land them? (present / past / future / conditional / subjunctive)
- Did they hesitate, ask for a translation, or fall back to English?
- A learner producing fluent multi-tense Spanish belongs near 0.15-0.30 English. A learner managing only isolated words belongs near 0.80-0.90 English. Mixed, effortful intermediate production sits near 0.40-0.55.

Output ONLY this JSON object, no markdown fences, no preamble:
{
  "demonstrated_ratio": number,   // 0.10-0.95 — the English fraction this learner is comfortable with
  "demonstrated_cefr": "A1" | "A2" | "B1" | "B2" | "C1",
  "confidence": number,           // 0.0-1.0 — how sure you are, given how little they may have said so far
  "tenses_observed": string[],    // tenses the learner ATTEMPTED this turn, e.g. ["present","past"]
  "notes": string                 // one short sentence on what this turn revealed
}

Early turns carry little signal — that is expected, estimate anyway with low confidence. Do not anchor to the self-reported level; it is frequently wrong in both directions.`;

/**
 * Calibration-mode per-turn evaluation. Estimates the learner's demonstrated
 * comfort ratio with an LLM classifier and applies the decaying-gain
 * convergence update. Safe to fire-and-forget — never throws to the caller.
 */
export async function evaluateCalibrationTurn(
  ctx: SessionContext,
  state: ControllerState,
): Promise<void> {
  const transcript = ctx.fullTranscript;
  // Need at least one learner turn to read.
  if (!transcript.some((e) => e.role === 'learner')) return;

  const recent = transcript
    .slice(-8)
    .map((e) => `[${e.role}] ${e.text}`)
    .join('\n');

  try {
    const resp = await getAnthropic().messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 400,
      system: CALIBRATION_CLASSIFIER_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            `Self-reported CEFR level: ${ctx.markedCefrLevel ?? 'unknown'}`,
            `Current ratio target: ${state.current_ratio_target.toFixed(2)} (${Math.round(
              state.current_ratio_target * 100,
            )}% English)`,
            `Placement turn: ${state.calibration_step_count + 1}`,
            '',
            '[recent conversation]',
            recent,
          ].join('\n'),
        },
      ],
    });

    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    const parsed = JSON.parse(clean) as {
      demonstrated_ratio: number;
      demonstrated_cefr?: string;
      confidence?: number;
      tenses_observed?: string[];
      notes?: string;
    };

    const turn: CalibrationTurn = {
      demonstrated_ratio: clampRatio(parsed.demonstrated_ratio),
      demonstrated_cefr:
        parsed.demonstrated_cefr ?? ratioToCefr(clampRatio(parsed.demonstrated_ratio)),
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.3)),
      tenses_observed: Array.isArray(parsed.tenses_observed)
        ? parsed.tenses_observed
        : [],
      notes: parsed.notes ?? '',
    };

    const before = state.current_ratio_target;
    applyCalibrationTurn(state, turn);

    console.log(
      `[calibration] step ${state.calibration_step_count}: demonstrated=${turn.demonstrated_ratio.toFixed(
        2,
      )} → ratio ${before.toFixed(2)}→${state.current_ratio_target.toFixed(2)} ` +
        `(${turn.demonstrated_cefr}, conf=${turn.confidence.toFixed(2)}) ${turn.notes}`,
    );
  } catch (err) {
    console.warn('[calibration] evaluateCalibrationTurn failed:', err);
  }
}

/**
 * Run an edge check over the last 5 turns. Updates state with new edge state
 * and directive. Safe to fire-and-forget.
 */
export async function evaluateEdge(
  ctx: SessionContext,
  state: ControllerState,
): Promise<void> {
  const transcript = ctx.fullTranscript;
  if (transcript.length < 4) return;

  const recent = transcript.slice(-10); // up to 5 turns of back-and-forth
  const formatted = recent
    .map((e) => `[${e.role}] ${e.text}`)
    .join('\n');

  try {
    const resp = await getAnthropic().messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 400,
      system: EDGE_CHECK_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            `Current ratio target: ${state.current_ratio_target.toFixed(2)}`,
            `CEFR level: ${ctx.learnerCore?.proficiency?.cefr_level ?? 'A1'}`,
            `Turn count: ${ctx.turnCount}`,
            '',
            '[recent conversation]',
            formatted,
          ].join('\n'),
        },
      ],
    });

    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    const assessment: EdgeAssessment = JSON.parse(clean);

    state.edge_state = assessment.state;
    state.last_edge_reason = `${assessment.reason} → ${assessment.directive}`;
    state.last_edge_check_turn = ctx.turnCount;

    console.log(
      `[difficulty] edge check turn ${ctx.turnCount}: ${assessment.state} — ${assessment.directive}`,
    );
  } catch (err) {
    console.warn('[difficulty] evaluateEdge failed:', err);
  }
}

/**
 * Build the prompt section that injects current controller state into Sofía's
 * system prompt. Returned string is empty if there's nothing meaningful to say.
 */
export function buildControllerPromptSection(state: ControllerState): string {
  if (state.mode === 'calibration') {
    return buildCalibrationPromptSection(state);
  }

  const ratioPct = Math.round(state.current_ratio_target * 100);
  const lines: string[] = [
    `## Live difficulty target`,
    `Right now, target ~${ratioPct}% English / ${100 - ratioPct}% Spanish.`,
  ];

  if (state.edge_state !== 'unknown') {
    lines.push('');
    lines.push(`Learner state: **${state.edge_state}**.`);
    lines.push(`Directive: ${state.last_edge_reason}`);
  }

  if (state.last_evaluated_turn > 0) {
    lines.push('');
    lines.push(`Previous turn read: ${state.last_turn_reason}`);
  }

  return lines.join('\n');
}

const ALL_TENSES = ['present', 'past', 'future', 'conditional', 'subjunctive'];

/**
 * Calibration-mode prompt section. Tells Sofía the live placement target and,
 * once turns have been observed, which tenses still need sampling so she can
 * steer the conversation toward an unseen one.
 */
function buildCalibrationPromptSection(state: ControllerState): string {
  const ratioPct = Math.round(state.current_ratio_target * 100);

  // Concrete directive for the current band — an abstract "% English" alone
  // let gpt-4o drift into all-Spanish on the opening turn.
  let directive: string;
  if (ratioPct >= 86) {
    directive =
      'Speak in English right now — plain English sentences, at most a single Spanish word. Do NOT express English ideas in Spanish.';
  } else if (ratioPct >= 66) {
    directive =
      'Speak mostly in English right now, weaving in Spanish words and short phrases.';
  } else if (ratioPct >= 41) {
    directive =
      'Mix English and Spanish roughly evenly right now, trading off sentence by sentence.';
  } else if (ratioPct >= 21) {
    directive =
      'Speak mostly in Spanish right now, dropping into English only to rescue comprehension.';
  } else {
    directive = 'Speak almost entirely in Spanish right now.';
  }

  const lines: string[] = [
    `## Live placement target`,
    `Right now, target ~${ratioPct}% English / ${100 - ratioPct}% Spanish. ${directive}`,
    `This is a placement conversation: the target is recalibrated after every learner turn to converge on the learner's true level. Follow it exactly — if it rises, simplify and lean on English; if it falls, push more Spanish and reach for harder grammar.`,
  ];

  if (state.calibration_turns.length > 0) {
    const last = state.calibration_turns[state.calibration_turns.length - 1];
    if (last.notes) {
      lines.push('');
      lines.push(`Last read: ${last.notes}`);
    }
    const seen = new Set<string>();
    for (const t of state.calibration_turns) {
      for (const x of t.tenses_observed) seen.add(x.toLowerCase());
    }
    const untested = ALL_TENSES.filter((t) => !seen.has(t));
    if (untested.length > 0 && untested.length < ALL_TENSES.length) {
      lines.push(
        `Tenses not yet sampled: ${untested.join(', ')}. If the conversation allows, open a natural door to hear one.`,
      );
    }
  }

  return lines.join('\n');
}

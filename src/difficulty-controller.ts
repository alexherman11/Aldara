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

export interface ControllerState {
  current_ratio_target: number;
  edge_state: EdgeState;
  last_turn_reason: string;
  last_edge_reason: string;
  last_evaluated_turn: number;
  last_edge_check_turn: number;
  recent_assessments: TurnAssessment[];
}

export function initControllerState(ctx: SessionContext): ControllerState {
  return {
    current_ratio_target: ctx.tutorCore?.bilingual_ratio_target ?? 0.8,
    edge_state: 'unknown',
    last_turn_reason: 'No turns evaluated yet.',
    last_edge_reason: 'No edge check yet.',
    last_evaluated_turn: 0,
    last_edge_check_turn: 0,
    recent_assessments: [],
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

Adjustment principles:
- Nailed it + no struggle → ratio_delta -0.03 (push toward more Spanish)
- Hesitation + self-correction but landed it → ratio_delta -0.01 (slight push, they're learning)
- Frustration or asked-for-translation → ratio_delta +0.04 (back off, give breathing room)
- Answered in English when Spanish expected → ratio_delta +0.02 (they need more scaffolding)
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

    // Clamp delta to ±0.05 and keep ratio in [0.10, 0.95]
    const delta = Math.max(-0.05, Math.min(0.05, assessment.ratio_delta));
    state.current_ratio_target = Math.max(
      0.1,
      Math.min(0.95, state.current_ratio_target + delta),
    );
    state.last_turn_reason = assessment.reason;
    state.last_evaluated_turn = ctx.turnCount;
    state.recent_assessments.push(assessment);
    if (state.recent_assessments.length > 5) {
      state.recent_assessments.shift();
    }

    console.log(
      `[difficulty] turn ${ctx.turnCount}: Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ` +
        `→ ratio=${state.current_ratio_target.toFixed(2)} (${assessment.reason})`,
    );
  } catch (err) {
    console.warn('[difficulty] evaluateTurn failed:', err);
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

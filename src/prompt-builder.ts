import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionContext } from './session-context.js';
import {
  buildControllerPromptSection,
  type ControllerState,
} from './difficulty-controller.js';
import { formatAnnotation, summarizePronunciationTrends } from './pronunciation/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TTS_OUTPUT_RULES = `
## CRITICAL: Your Output Is Spoken Aloud
Your responses are synthesized by a Spanish-configured text-to-speech engine. Observe these rules strictly:
- NEVER use parenthetical pronunciation guides like "hola (OH-lah)" — the TTS reads them literally.
- NEVER use phonetic respellings, IPA, or dashes between syllables ("co-ci-nar").
- NEVER use markdown, bullets, or asterisks. Speak in natural flowing sentences.
- Spanish words will sound authentic. English words will have a warm Mexican-Spanish accent.
- If you want the learner to focus on a word, just repeat it naturally: "The word is cocinar. Cocinar."
`.trim();

// Persona is loaded once from disk; editable without recompile.
const SOFIA_PERSONA = readFileSync(
  join(__dirname, 'prompts', 'sofia-persona.txt'),
  'utf8',
).trim();

// Placement-mode mission — the calibration conversation arc. Loaded once,
// editable without recompile, same as the base persona.
const PLACEMENT_PERSONA = readFileSync(
  join(__dirname, 'prompts', 'placement-persona.txt'),
  'utf8',
).trim();

const DEFAULT_LEARNER_PROFILE =
  'This is a new learner. Start by asking about their interests and why they want to learn Spanish.';

export interface PromptBuilderOptions {
  /** Include a turn-count-triggered CEFR drift reminder. */
  includeCefrReminder?: boolean;
  /** Live difficulty controller state — injected if provided. */
  controllerState?: ControllerState;
}

/**
 * Build the system prompt for Sofía from the session context.
 *
 * Sections (in order):
 *   1. TTS output rules (always)
 *   2. Sofía persona + code-switching technique (loaded from sofia-persona.txt)
 *   3. Tutor game plan from evolved tutor core (if any)
 *   4. About this learner (from learner core)
 *   5. Learner profile bits (interests, correction preference, frustration triggers)
 *   6. FSRS vocabulary to weave in
 *   7. Live difficulty controller state (ratio target, edge state, directive)
 *   8. Optional CEFR reminder
 */
export function buildSystemPrompt(
  ctx: SessionContext,
  opts: PromptBuilderOptions = {},
): string {
  const sections: string[] = [];

  // 1. TTS output rules
  sections.push(TTS_OUTPUT_RULES);

  // 2. Sofía persona + code-switching technique
  sections.push(SOFIA_PERSONA);

  // Placement mode: a focused calibration script replaces the normal
  // game-plan / learner-profile / FSRS / pronunciation sections. The base
  // persona above still applies — placement is the same Sofía, just listening.
  if (ctx.mode === 'placement') {
    sections.push(PLACEMENT_PERSONA);
    if (opts.controllerState) {
      sections.push(buildControllerPromptSection(opts.controllerState));
    }
    return sections.join('\n\n');
  }

  // 3. Tutor game plan (only when tutor core has evolved past seed)
  const teachingNarrative = ctx.tutorCore?.teaching_narrative?.trim();
  if (teachingNarrative && ctx.tutorCore.version > 0) {
    sections.push(`## Your game plan for this session\n${teachingNarrative}`);
  }

  // 4. About this learner
  const trajectory = ctx.learnerCore?.session_trajectory?.trim();
  if (
    trajectory &&
    ctx.learnerCore.version > 0 &&
    !trajectory.includes('New learner. No sessions yet')
  ) {
    sections.push(`## About this learner\n${trajectory}`);

    // 5. Learner profile bits
    const profile = ctx.learnerCore.learning_profile;
    const profileBits: string[] = [];
    if (profile?.interests?.length) {
      profileBits.push(`Interests: ${profile.interests.join(', ')}`);
    }
    if (profile?.correction_preference) {
      profileBits.push(
        `Correction preference: ${profile.correction_preference}`,
      );
    }
    if (profile?.frustration_triggers?.length) {
      profileBits.push(
        `Avoid these frustration triggers: ${profile.frustration_triggers.join(', ')}`,
      );
    }
    if (profileBits.length > 0) {
      sections.push(`## Learner profile\n${profileBits.join('\n')}`);
    }
  } else {
    sections.push(`## About this learner\n${DEFAULT_LEARNER_PROFILE}`);
  }

  // 6. FSRS vocabulary to weave in
  if (ctx.fsrsDueItems.length > 0) {
    const items = ctx.fsrsDueItems
      .map((i) => {
        const ctxText = i.item_context ? ` — ${i.item_context}` : '';
        return `  - "${i.item_key}"${ctxText}`;
      })
      .join('\n');
    sections.push(
      `## Vocabulary due for review\n` +
        `Weave these Spanish words naturally into the conversation. Do NOT quiz the learner explicitly — let the words emerge in context. If a word doesn't fit naturally, skip it.\n${items}`,
    );
  }

  // 7. Live difficulty controller state
  if (opts.controllerState) {
    sections.push(buildControllerPromptSection(opts.controllerState));
  }

  // 7b. Pronunciation signal — most recent turn (always) + trend summary
  // (when persistent patterns emerge across the last few turns). The latest
  // assessment is the actionable one; the trend summary tells Sofía whether
  // a single flag is noise or part of a settling L1-transfer pattern.
  const assessments = ctx.recentAssessments ?? [];
  const latestAssessment = assessments[assessments.length - 1];
  if (latestAssessment) {
    const annotation = formatAnnotation(latestAssessment);
    if (annotation) {
      sections.push(
        `## Pronunciation flags from the learner's most recent turn\n` +
          `The learner just said "${latestAssessment.reference_text}" — the pronunciation engine flagged:\n` +
          annotation +
          `\n\nFollow the "On pronunciation" guidance from your persona — model the flagged word back cleanly inside your reply, do not call out the error directly. ` +
          `If the annotation includes "STT/assessor mismatch", the learner produced something acoustically distinct from what speech-to-text auto-corrected — treat that as a pronunciation issue, not a transcription error.`,
      );
    }
  }

  const trendSummary = summarizePronunciationTrends(assessments);
  if (trendSummary) {
    sections.push(
      trendSummary +
        `\n\nThis is a settling L1-transfer pattern — model the affected sounds cleanly when they next come up in conversation. Do not drill explicitly. If a phoneme has been weak in 3+ turns, you may briefly highlight the contrast once ("the rolled rr in perro — listen: perro").`,
    );
  }

  // 8. CEFR drift reminder (every 7 turns) — fallback when no controller is wired
  const shouldRemind =
    opts.includeCefrReminder ??
    (!opts.controllerState &&
      ctx.turnCount > 0 &&
      ctx.turnCount % 7 === 0);

  if (shouldRemind) {
    const cefrLevel = ctx.learnerCore?.proficiency?.cefr_level || 'A1';
    const ratio =
      opts.controllerState?.current_ratio_target ??
      ctx.tutorCore?.bilingual_ratio_target ??
      0.8;
    sections.push(
      `## Level reminder\n` +
        `Stay at CEFR ${cefrLevel}. Target bilingual ratio: ~${Math.round(ratio * 100)}% English, ${Math.round((1 - ratio) * 100)}% Spanish. ` +
        `Do not drift above the learner's level.`,
    );
  }

  return sections.join('\n\n');
}

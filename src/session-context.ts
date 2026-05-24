import {
  getOrCreateLearner,
  getDueCards,
  createSession,
} from './db/index.js';
import type { LearnerCore, TutorCore } from './types.js';
import type { PronunciationAssessment } from './pronunciation/index.js';

export interface TranscriptEntry {
  role: 'learner' | 'tutor';
  text: string;
  ts: Date;
}

export interface FsrsDueItem {
  item_key: string;
  item_context: string | null;
}

/**
 * 'normal' — a regular tutoring session.
 * 'placement' — the one-time post-signup conversation that calibrates the
 * learner's starting level. Drives the calibration controller and the
 * placement persona; see src/difficulty-controller.ts.
 */
export type SessionMode = 'normal' | 'placement';

export interface SessionContext {
  learnerId: string;
  sessionId: string;
  learnerCore: LearnerCore;
  tutorCore: TutorCore;
  fsrsDueItems: FsrsDueItem[];

  /**
   * Whether this is a normal session or the post-signup placement.
   * Optional so legacy/scripted contexts can omit it — absent is treated as
   * 'normal'. `loadSessionContext` always populates it for live sessions.
   */
  mode?: SessionMode;
  /**
   * The learner's self-reported CEFR level from signup (`learners.cefr_level`
   * / `profile.cefr_initial`). The placement controller opens just below this
   * and converges from there. Undefined for legacy/scripted contexts.
   */
  markedCefrLevel?: string;

  fullTranscript: TranscriptEntry[];
  turnCount: number;
  sessionStartedAt: Date;

  /**
   * Pronunciation assessments captured during this session, in turn order.
   * Most-recent-last. Used by the prompt builder to surface the latest
   * annotation to the LLM, by the debug panel to show what was flagged, and
   * by compaction to write per-phoneme trajectories into the learner core.
   *
   * Optional so legacy synthetic SessionContexts (test scripts, old code) can
   * omit it. Production agents always populate via initSessionContext().
   */
  recentAssessments?: PronunciationAssessment[];
}

export async function loadSessionContext(
  learnerId: string,
  mode: SessionMode = 'normal',
): Promise<SessionContext> {
  // 1. Fetch learner (or create with seed cores if new)
  const learner = await getOrCreateLearner(learnerId);

  // 2. Query due FSRS cards
  const dueCards = await getDueCards(learnerId);
  const fsrsDueItems: FsrsDueItem[] = dueCards.map(
    (c: { item_key: string; item_context: string | null }) => ({
      item_key: c.item_key,
      item_context: c.item_context,
    }),
  );

  // 3. Create a new session row
  const sessionId = await createSession(learnerId);

  // The self-reported level lives on the learner row (set at signup). Prefer
  // the dedicated column; fall back to the profile blob for older rows.
  const markedCefrLevel: string | undefined =
    (typeof learner.cefr_level === 'string' && learner.cefr_level) ||
    (learner.profile && typeof learner.profile.cefr_initial === 'string'
      ? learner.profile.cefr_initial
      : undefined) ||
    undefined;

  // 4. Assemble and return the session context
  return {
    learnerId,
    sessionId,
    learnerCore: learner.learner_core as LearnerCore,
    tutorCore: learner.tutor_core as TutorCore,
    fsrsDueItems,

    mode,
    markedCefrLevel,

    fullTranscript: [],
    turnCount: 0,
    sessionStartedAt: new Date(),
    recentAssessments: [],
  };
}

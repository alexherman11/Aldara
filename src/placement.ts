import { saveCores, saveSession } from './db/index.js';
import type { SessionContext } from './session-context.js';
import type {
  ControllerState,
  PlacementResult,
} from './difficulty-controller.js';
import type { LearnerCore, TutorCore } from './types.js';

export interface PlacementOutcome {
  result: PlacementResult;
  preCores: { learner: LearnerCore; tutor: TutorCore };
  postCores: { learner: LearnerCore; tutor: TutorCore };
}

/**
 * Persist a finished placement conversation.
 *
 * Unlike compaction, this is deterministic — the calibration controller's
 * converged ratio IS the authoritative output, so there is no LLM judgement
 * here. We write that ratio (and the CEFR bucket it maps to) into both cores,
 * bump the core version so the learner is no longer treated as brand-new, and
 * save the session row with the placement transcript. The first real tutoring
 * session then opens at exactly this calibrated level and greets the learner
 * as a returning user.
 *
 * Safe to call with an empty transcript (the learner skipped immediately): the
 * placement result falls back to their self-rated level upstream, and we still
 * write a real core so the seed "new learner" state is replaced.
 */
export async function persistPlacement(
  ctx: SessionContext,
  state: ControllerState,
  result: PlacementResult,
): Promise<PlacementOutcome> {
  const preLearner = ctx.learnerCore;
  const preTutor = ctx.tutorCore;

  const tenses = new Set<string>();
  for (const t of state.calibration_turns) {
    for (const x of t.tenses_observed) tenses.add(x.toLowerCase());
  }

  const learnerCore: LearnerCore = {
    ...preLearner,
    version: Math.max(1, (preLearner.version ?? 0) + 1),
    proficiency: {
      ...preLearner.proficiency,
      cefr_level: result.cefr_level,
      bilingual_ratio: result.ratio,
    },
    session_trajectory:
      `Placement conversation complete. Self-reported ` +
      `${ctx.markedCefrLevel ?? 'unknown'}; calibrated to ${result.cefr_level} ` +
      `over ${result.calibration_turns} turn(s) ` +
      `(${result.converged ? 'converged' : 'low-confidence estimate'}). ` +
      `Tenses sampled: ${tenses.size ? [...tenses].join(', ') : 'none'}. ` +
      `This is the learner's starting point — begin the first real session here.`,
  };

  const tutorCore: TutorCore = {
    ...preTutor,
    version: Math.max(1, (preTutor.version ?? 0) + 1),
    bilingual_ratio_target: result.ratio,
  };

  await saveCores(ctx.learnerId, learnerCore, tutorCore);

  await saveSession(ctx.sessionId, {
    ended_at: new Date(),
    transcript: ctx.fullTranscript,
    pre_cores: { learner: preLearner, tutor: preTutor },
    post_cores: { learner: learnerCore, tutor: tutorCore },
    compaction_log:
      `placement: self-reported ${ctx.markedCefrLevel ?? '?'} → ` +
      `calibrated ${result.cefr_level} ` +
      `(ratio ${result.ratio.toFixed(2)}, confidence ${result.confidence.toFixed(2)})`,
  });

  console.log(
    `[placement] session ${ctx.sessionId.slice(0, 8)} persisted: ` +
      `${ctx.markedCefrLevel ?? '?'} → ${result.cefr_level} ` +
      `(ratio ${result.ratio.toFixed(2)}, ${result.calibration_turns} turns)`,
  );

  return {
    result,
    preCores: { learner: preLearner, tutor: preTutor },
    postCores: { learner: learnerCore, tutor: tutorCore },
  };
}

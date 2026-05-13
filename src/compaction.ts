import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import { saveCores, saveSession, upsertCard, getDueCards } from './db/index.js';
import type { SessionContext } from './session-context.js';
import type { CompactionResult, LearnerCore, TutorCore } from './types.js';
import type { ControllerState } from './difficulty-controller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPACTION_PROMPT = readFileSync(
  join(__dirname, 'prompts', 'compaction-prompt.txt'),
  'utf-8',
);

const f = fsrs();

export interface CompactionOutcome {
  result: CompactionResult;
  preCores: { learner: LearnerCore; tutor: TutorCore };
  fsrsCreated: number;
  fsrsRated: number;
  durationMs: number;
}

/**
 * Run compaction on the session transcript. Calls Claude Sonnet with the
 * transcript and current cores, persists the evolved cores and FSRS updates
 * to the database, and saves the session row with pre/post snapshots.
 *
 * Returns the compaction result for display in the debug panel.
 */
export async function runCompaction(
  ctx: SessionContext,
  controllerState?: ControllerState,
): Promise<CompactionOutcome> {
  const startedAt = Date.now();

  const transcriptText = ctx.fullTranscript
    .map((t) => `[${t.role}] ${t.text}`)
    .join('\n');

  if (ctx.fullTranscript.length === 0) {
    throw new Error('Cannot compact an empty session');
  }

  const durationMin =
    (startedAt - ctx.sessionStartedAt.getTime()) / 1000 / 60;

  // Build the live-controller summary if we have one. This carries the session's
  // hard-won difficulty calibration into compaction so it can persist to tutor_core.
  const controllerSummary = controllerState
    ? `

<live_controller_state>
Final bilingual ratio target after this session: ${controllerState.current_ratio_target.toFixed(2)} (${Math.round(
        controllerState.current_ratio_target * 100,
      )}% English)
Final edge state: ${controllerState.edge_state}
Last edge directive: ${controllerState.last_edge_reason}
Last turn read: ${controllerState.last_turn_reason}

Use this as a strong signal for tutor_core.bilingual_ratio_target. The ratio above
reflects the live difficulty controller's adjustments across the session — prefer it
over the entering value unless the transcript strongly suggests overshooting.
</live_controller_state>`
    : '';

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
${JSON.stringify(ctx.learnerCore, null, 2)}
</existing_learner_core>

<existing_tutor_core>
${JSON.stringify(ctx.tutorCore, null, 2)}
</existing_tutor_core>

<session_transcript>
${transcriptText}
</session_transcript>

<session_metrics>
Turn count: ${ctx.turnCount}
Session duration: ${durationMin.toFixed(1)} minutes
</session_metrics>${controllerSummary}
        `.trim(),
      },
    ],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  const result = JSON.parse(clean) as CompactionResult;

  const preCores = {
    learner: ctx.learnerCore,
    tutor: ctx.tutorCore,
  };

  // Persist evolved cores
  await saveCores(ctx.learnerId, result.learner_core, result.tutor_core);

  // Save session with pre/post snapshots
  await saveSession(ctx.sessionId, {
    ended_at: new Date(),
    transcript: ctx.fullTranscript,
    pre_cores: preCores as never,
    post_cores: {
      learner: result.learner_core,
      tutor: result.tutor_core,
    },
    compaction_log: result.compaction_notes,
  });

  // Process FSRS updates
  let fsrsCreated = 0;
  let fsrsRated = 0;
  const existingByKey = new Map(
    (await getDueCards(ctx.learnerId)).map(
      (c: {
        item_key: string;
        item_type: string;
        item_context: string | null;
        due: Date;
        stability: number;
        difficulty: number;
        elapsed_days: number;
        scheduled_days: number;
        reps: number;
        lapses: number;
        state: number;
        last_review: Date | null;
      }) => [c.item_key, c],
    ),
  );

  for (const update of result.fsrs_updates ?? []) {
    if (update.action === 'create') {
      const card = createEmptyCard(new Date());
      await upsertCard(ctx.learnerId, {
        item_type: update.item_type ?? 'vocabulary',
        item_key: update.item_key,
        item_context: update.context ?? null,
        due: card.due,
        stability: card.stability,
        difficulty: card.difficulty,
        elapsed_days: card.elapsed_days,
        scheduled_days: card.scheduled_days,
        reps: card.reps,
        lapses: card.lapses,
        state: card.state,
        last_review: card.last_review ?? null,
      });
      fsrsCreated++;
    } else if (update.action === 'rate' && update.rating) {
      const existing = existingByKey.get(update.item_key);
      if (!existing) {
        // Rating a card that wasn't previously due — create fresh then rate
        const fresh = createEmptyCard(new Date());
        const rated = f.next(fresh, new Date(), Rating[update.rating]);
        await upsertCard(ctx.learnerId, {
          item_type: update.item_type ?? 'vocabulary',
          item_key: update.item_key,
          item_context: update.context ?? null,
          due: rated.card.due,
          stability: rated.card.stability,
          difficulty: rated.card.difficulty,
          elapsed_days: rated.card.elapsed_days,
          scheduled_days: rated.card.scheduled_days,
          reps: rated.card.reps,
          lapses: rated.card.lapses,
          state: rated.card.state,
          last_review: rated.card.last_review ?? null,
        });
      } else {
        const card = {
          due: new Date(existing.due),
          stability: existing.stability,
          difficulty: existing.difficulty,
          elapsed_days: existing.elapsed_days,
          scheduled_days: existing.scheduled_days,
          reps: existing.reps,
          lapses: existing.lapses,
          state: existing.state,
          last_review: existing.last_review
            ? new Date(existing.last_review)
            : undefined,
        };
        const rated = f.next(card as never, new Date(), Rating[update.rating]);
        await upsertCard(ctx.learnerId, {
          item_type: existing.item_type,
          item_key: update.item_key,
          item_context: existing.item_context,
          due: rated.card.due,
          stability: rated.card.stability,
          difficulty: rated.card.difficulty,
          elapsed_days: rated.card.elapsed_days,
          scheduled_days: rated.card.scheduled_days,
          reps: rated.card.reps,
          lapses: rated.card.lapses,
          state: rated.card.state,
          last_review: rated.card.last_review ?? null,
        });
      }
      fsrsRated++;
    }
  }

  const durationMs = Date.now() - startedAt;

  console.log(
    `[compaction] Session ${ctx.sessionId.slice(0, 8)} compacted in ${durationMs}ms. ` +
      `Notes: ${result.compaction_notes}`,
  );

  return { result, preCores, fsrsCreated, fsrsRated, durationMs };
}

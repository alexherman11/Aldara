// dotenv FIRST, before any module that captures env at load time (db pool, Anthropic client, etc.)
// Cannot use `import dotenv from 'dotenv'; dotenv.config()` — ESM hoists all imports
// before script body. `dotenv/config` does the side-effect at module-load time.
import 'dotenv/config';
// Ensure values from .env override any blank vars inherited from the parent shell.
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createSession, getOrCreateLearner, saveCores, closePool, getDueCards } from '../src/db/index.js';
import { runCompaction } from '../src/compaction.js';
import { buildSystemPrompt } from '../src/prompt-builder.js';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../src/seed-cores.js';
import type { SessionContext } from '../src/session-context.js';
import type { LearnerCore, TutorCore } from '../src/types.js';
import {
  initControllerState,
  type ControllerState,
} from '../src/difficulty-controller.js';
import { randomUUID } from 'node:crypto';

/**
 * Long-form compaction stress test.
 *
 * Three back-to-back sessions on a clean learner row:
 *
 *   Session A — 40 turns covering 5 topics with realistic A1 errors.
 *               Tests: compaction handles long transcripts without truncation,
 *               cores evolve sensibly, FSRS items get scheduled, prompt
 *               actually shrinks (or at least doesn't bloat).
 *
 *   Session B — 30 turns building on session A's vocabulary. Tests continuity:
 *               does the next-session system prompt reflect what was learned
 *               in A? Does Sofia greet with reference to A's topics?
 *
 *   Session C — 20 turns. Tests cumulative pressure: cores from A+B should
 *               still produce coherent prompts without unbounded growth.
 *
 * Each session ends with compaction. We persist results, compare cores,
 * inspect prompt size, and check that FSRS cards mature properly.
 */

const TEST_LEARNER_ID = randomUUID(); // fresh row each run — no DB pollution

interface SessionResult {
  label: string;
  sessionId: string;
  turnCount: number;
  preCores: { learner: LearnerCore; tutor: TutorCore };
  postCores: { learner: LearnerCore; tutor: TutorCore };
  fsrsCreated: number;
  fsrsRated: number;
  durationMs: number;
  promptCharsBefore: number;
  promptCharsAfter: number;
  notes: string;
  fsrsDueCount: number;
}

// ── Synthetic transcripts ─────────────────────────────────────────

const SESSION_A_TURNS: Array<{ role: 'tutor' | 'learner'; text: string }> = [
  { role: 'tutor', text: '¡Hola! I\'m Sofía. What made you want to learn Spanish?' },
  { role: 'learner', text: 'Hi! I want to learn because my wife\'s family is from Mexico City.' },
  { role: 'tutor', text: 'That\'s a beautiful reason. Mexico City is amazing — la Ciudad de México. Have you been there?' },
  { role: 'learner', text: 'Yes once last year. We ate a lot of mole and tacos al pastor.' },
  { role: 'tutor', text: 'Mole is incredible — un mole muy complejo. What did you think of the food?' },
  { role: 'learner', text: 'I love food, but mole was so complejo, like you said. Many flavors.' },
  { role: 'tutor', text: 'Yes — muchos sabores. The word for flavor is sabor, plural sabores. Want to learn how to talk about food in Spanish?' },
  { role: 'learner', text: 'Yes! How do you say "I love it"?' },
  { role: 'tutor', text: 'You say "me encanta." So "me encanta el mole" — I love mole.' },
  { role: 'learner', text: 'Me encanta el mole. Me encanta los tacos.' },
  { role: 'tutor', text: 'Almost! "Me encantan los tacos" — encantan with an "n" because tacos is plural. What else do you encantan?' },
  { role: 'learner', text: 'Me encantan los perros! I have two dogs.' },
  { role: 'tutor', text: 'Two dogs! ¿Cómo se llaman? What are their names?' },
  { role: 'learner', text: 'Their names are Luna and Coco. Luna is small, Coco is grande.' },
  { role: 'tutor', text: 'Luna pequeña y Coco grande. Beautiful names. What kind of dogs?' },
  { role: 'learner', text: 'Luna is a chihuahua, Coco is a labrador. Coco eats so much!' },
  { role: 'tutor', text: 'Coco come mucho, jaja. Chihuahuas are originally Mexican, did you know? They come from Chihuahua, the state.' },
  { role: 'learner', text: 'I didn\'t know! Mi perro is from Mexico originally.' },
  { role: 'tutor', text: 'Tu perro is from a Mexican breed — una raza mexicana. Want to learn some travel words for your next trip?' },
  { role: 'learner', text: 'Yes please! When we visit my wife\'s family.' },
  { role: 'tutor', text: 'Great. "Familia política" is in-laws. "Cuñado/cuñada" is brother/sister-in-law. Lots of family words.' },
  { role: 'learner', text: 'Cuñado, cuñada. My cuñado is funny. Always making jokes.' },
  { role: 'tutor', text: '¡Tu cuñado es chistoso! Chistoso means funny. Or "gracioso" — same idea.' },
  { role: 'learner', text: 'Mi cuñado es chistoso. I\'ll try to remember chistoso.' },
  { role: 'tutor', text: 'When you visit, try saying "mi cuñado es muy chistoso" to him. He\'ll love it.' },
  { role: 'learner', text: 'Haha okay! What else should I practice?' },
  { role: 'tutor', text: 'Tell me about your work — tu trabajo. What do you do?' },
  { role: 'learner', text: 'I am a software engineer. I work for a small company.' },
  { role: 'tutor', text: 'Ingeniero de software para una compañía pequeña. ¿Te gusta tu trabajo?' },
  { role: 'learner', text: 'Sí, me gusta mucho. But sometimes work is dificil.' },
  { role: 'tutor', text: 'Difícil — with stress on the "i". Sometimes el trabajo es difícil. Why difícil for you?' },
  { role: 'learner', text: 'Because new technology every day. I have to learn always.' },
  { role: 'tutor', text: 'Aprender siempre — to always be learning. That\'s a beautiful thing actually. ¿Te gusta aprender?' },
  { role: 'learner', text: 'Sí me gusta aprender. That\'s why I\'m learning Spanish too!' },
  { role: 'tutor', text: 'Exacto. Learning Spanish is también aprender. Want to talk about something fun for the rest?' },
  { role: 'learner', text: 'Yes! What do you want to talk about, Sofía?' },
  { role: 'tutor', text: 'Tell me — what\'s your favorite food to cook? Tu comida favorita para cocinar.' },
  { role: 'learner', text: 'I like to cook pasta. Easy and delicioso.' },
  { role: 'tutor', text: 'Pasta es fácil y deliciosa. Maybe next time we cook pasta in Spanish — I\'ll teach you the recipe words. ¿Está bien?' },
  { role: 'learner', text: 'Sí está bien! Until next time, Sofía. Adiós!' },
];

const SESSION_B_TURNS: Array<{ role: 'tutor' | 'learner'; text: string }> = [
  { role: 'tutor', text: '¡Hola! Welcome back. Last time we talked about your dogs Luna and Coco, your in-laws in Mexico City, and you mentioned cooking pasta. Ready to keep going?' },
  { role: 'learner', text: 'Yes! Can we do the pasta recipe today?' },
  { role: 'tutor', text: 'Perfecto. So we said pasta is fácil y deliciosa. To cook is "cocinar." Let\'s start with ingredients — los ingredientes.' },
  { role: 'learner', text: 'Los ingredientes. What\'s tomato in Spanish?' },
  { role: 'tutor', text: 'Tomato is "tomate." And onion is "cebolla," garlic is "ajo."' },
  { role: 'learner', text: 'Tomate, cebolla, ajo. That\'s easy. What about pasta itself?' },
  { role: 'tutor', text: 'Pasta is just "pasta" — easy. Y la salsa — the sauce. Salsa de tomate is tomato sauce.' },
  { role: 'learner', text: 'Salsa de tomate. So to make pasta, primero I cocino la salsa.' },
  { role: 'tutor', text: 'Casi — "primero cocino la salsa." You don\'t need "I" before cocino, the verb already says it. Beautiful sentence!' },
  { role: 'learner', text: 'Oh right, primero cocino la salsa, y después cocino la pasta.' },
  { role: 'tutor', text: 'Perfect. Y después — and after. Connecting words make you sound fluent. What else do you put in your pasta?' },
  { role: 'learner', text: 'I put cheese on top. Lots of cheese.' },
  { role: 'tutor', text: 'El queso. Mucho queso. ¿Qué tipo? What kind?' },
  { role: 'learner', text: 'Parmesan usually. Sometimes mozzarella.' },
  { role: 'tutor', text: 'Parmesano y mozzarella, sí. So your full plate is pasta con salsa de tomate y mucho queso. Suena delicioso.' },
  { role: 'learner', text: 'Suena delicioso! Sounds delicious. New word for me.' },
  { role: 'tutor', text: 'Suena = sounds. Comes from sonar. Anyway, let\'s switch — tell me about Coco. How is your big dog?' },
  { role: 'learner', text: 'Coco is good. He eats a lot, like always. Y ladra mucho.' },
  { role: 'tutor', text: 'Ladra mucho — barks a lot! Where did you pick up that word?' },
  { role: 'learner', text: 'I looked it up. Wanted to tell you Coco barks at the mailman.' },
  { role: 'tutor', text: 'Coco le ladra al cartero. The mailman is el cartero. Funny — many dogs do this.' },
  { role: 'learner', text: 'Le ladra al cartero. Why "le"?' },
  { role: 'tutor', text: '"Le" is "to him" — Coco barks AT him. Indirect object. We\'ll keep using it; it\'ll start to feel natural.' },
  { role: 'learner', text: 'Okay. Le ladra al cartero. I\'ll just remember the whole phrase.' },
  { role: 'tutor', text: 'That\'s the right way at A1 — chunks first, grammar later. ¿Algo más antes de terminar?' },
  { role: 'learner', text: 'Antes de terminar... before finishing. No, creo que está bien.' },
  { role: 'tutor', text: 'You used "creo que" — you think that. Beautiful. ¡Nos vemos pronto!' },
  { role: 'learner', text: 'Nos vemos! Adiós Sofía.' },
  { role: 'tutor', text: '¡Adiós!' },
  { role: 'learner', text: 'Wait — one last thing. How do I say "I miss you"?' },
];

const SESSION_C_TURNS: Array<{ role: 'tutor' | 'learner'; text: string }> = [
  { role: 'tutor', text: '¡Hola! Welcome back. Last time we did pasta and Coco the loud labrador. ¿Cómo estás?' },
  { role: 'learner', text: 'Estoy bien gracias. I made pasta last weekend and used the words.' },
  { role: 'tutor', text: '¡Qué bueno! Did you say "primero cocino la salsa"?' },
  { role: 'learner', text: 'Yes! And cebolla and ajo. My wife was impressed.' },
  { role: 'tutor', text: 'Tu esposa estaba impresionada. Wonderful. What do you want to learn today?' },
  { role: 'learner', text: 'I want to talk about travel. We\'re going to Mexico City in two months.' },
  { role: 'tutor', text: '¡En dos meses! That\'s exciting. Where will you stay? ¿Dónde se van a quedar?' },
  { role: 'learner', text: 'Con mi cuñado. He has an apartment in Roma Norte.' },
  { role: 'tutor', text: 'Roma Norte, very nice neighborhood — un barrio muy bonito. Lots of cafes. ¿Te gustan los cafés?' },
  { role: 'learner', text: 'Sí me encantan los cafés! Especially in the morning.' },
  { role: 'tutor', text: 'Por la mañana. Try this: "Me gusta tomar café por la mañana."' },
  { role: 'learner', text: 'Me gusta tomar café por la mañana. Easy.' },
  { role: 'tutor', text: 'Tomar = to take/drink. We say "tomar café" not "beber café." Pequeña diferencia. What else for the trip?' },
  { role: 'learner', text: 'How do I say "Where is the bathroom?" Always useful.' },
  { role: 'tutor', text: '"¿Dónde está el baño?" — el baño is the bathroom. Or politely, "¿Me podría decir dónde está el baño?"' },
  { role: 'learner', text: 'Dónde está el baño. I\'ll remember the simple version.' },
  { role: 'tutor', text: 'Smart. Save the long version for fancy restaurants. Anything else?' },
  { role: 'learner', text: 'How do I order food? Like "I want tacos al pastor"?' },
  { role: 'tutor', text: '"Quisiera tacos al pastor, por favor." Quisiera is more polite than "quiero" — like "I would like."' },
  { role: 'learner', text: 'Quisiera tacos al pastor por favor. Got it.' },
  { role: 'tutor', text: 'Perfecto. Anything you\'re nervous about for the trip?' },
];

// ── Helper: Synthesize SessionContext for a saved DB row ───────────

async function syntheticContext(
  learnerId: string,
  turns: Array<{ role: 'tutor' | 'learner'; text: string }>,
): Promise<SessionContext> {
  const learner = await getOrCreateLearner(learnerId);
  const sessionId = await createSession(learnerId);
  const due = await getDueCards(learnerId);

  return {
    learnerId,
    sessionId,
    learnerCore: learner.learner_core as LearnerCore,
    tutorCore: learner.tutor_core as TutorCore,
    fsrsDueItems: due.map((c: { item_key: string; item_context: string | null }) => ({
      item_key: c.item_key,
      item_context: c.item_context,
    })),
    fullTranscript: turns.map((t) => ({
      role: t.role,
      text: t.text,
      ts: new Date(),
    })),
    turnCount: turns.filter((t) => t.role === 'learner').length,
    sessionStartedAt: new Date(),
    recentAssessments: [],
  };
}

// ── Run a single session through compaction ─────────────────────────

async function runSession(
  label: string,
  turns: Array<{ role: 'tutor' | 'learner'; text: string }>,
): Promise<SessionResult> {
  console.log(`\n━━━ ${label} (${turns.length} turns) ━━━`);

  const ctx = await syntheticContext(TEST_LEARNER_ID, turns);

  // Promptsize before compaction (what the agent would see entering this session)
  const controllerStateBefore: ControllerState = initControllerState(ctx);
  const promptBefore = buildSystemPrompt(ctx, {
    controllerState: controllerStateBefore,
  });

  console.log(`  prompt size entering session: ${promptBefore.length} chars`);
  console.log(
    `  entering learner_core.version=${ctx.learnerCore.version} ` +
      `tutor_core.version=${ctx.tutorCore.version}`,
  );
  console.log(`  FSRS due items: ${ctx.fsrsDueItems.length}`);

  const startedAt = Date.now();
  const outcome = await runCompaction(ctx, controllerStateBefore);
  const durationMs = Date.now() - startedAt;

  // Reload context to get post-compaction cores for the next session's prompt
  const postCtx = await syntheticContext(TEST_LEARNER_ID, []);
  const promptAfter = buildSystemPrompt(postCtx, {
    controllerState: initControllerState(postCtx),
  });

  console.log(`  compaction took ${durationMs}ms`);
  console.log(
    `  after: learner_core.version=${postCtx.learnerCore.version} ` +
      `tutor_core.version=${postCtx.tutorCore.version}`,
  );
  console.log(`  FSRS created: ${outcome.fsrsCreated}, rated: ${outcome.fsrsRated}`);
  console.log(`  prompt size after compaction: ${promptAfter.length} chars`);
  console.log(`  compaction notes: ${outcome.result.compaction_notes.slice(0, 200)}`);

  return {
    label,
    sessionId: ctx.sessionId,
    turnCount: turns.filter((t) => t.role === 'learner').length,
    preCores: outcome.preCores,
    postCores: {
      learner: outcome.result.learner_core,
      tutor: outcome.result.tutor_core,
    },
    fsrsCreated: outcome.fsrsCreated,
    fsrsRated: outcome.fsrsRated,
    durationMs,
    promptCharsBefore: promptBefore.length,
    promptCharsAfter: promptAfter.length,
    notes: outcome.result.compaction_notes,
    fsrsDueCount: outcome.result.fsrs_updates?.length ?? 0,
  };
}

// ── Continuity check: does session N+1's prompt reflect session N? ─

function continuityCheck(
  label: string,
  prevPostCores: { learner: LearnerCore; tutor: TutorCore },
  nextPrompt: string,
): { passed: number; failed: number; details: string[] } {
  const traj = (prevPostCores.learner.session_trajectory || '').toLowerCase();
  const narr = (prevPostCores.tutor.teaching_narrative || '').toLowerCase();
  const promptLower = nextPrompt.toLowerCase();

  // Pull a few high-signal nouns from the previous trajectory + narrative.
  // These should appear in the next prompt to count as "continuity preserved."
  const candidates = new Set<string>();
  for (const text of [traj, narr]) {
    for (const m of text.match(/\b[a-záéíóúñ]{4,}\b/gi) ?? []) {
      candidates.add(m.toLowerCase());
    }
  }

  // Pick the 5 longest words as proxies for "specific content" — short words
  // like "the", "with" don't carry continuity signal.
  const longest = Array.from(candidates)
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);

  const found = longest.filter((w) => promptLower.includes(w));
  const passed = found.length;
  const failed = longest.length - passed;

  return {
    passed,
    failed,
    details: [
      `  ${label} continuity: ${passed}/${longest.length} signal words preserved`,
      `    longest signal words checked: ${longest.join(', ')}`,
      `    found in next prompt:         ${found.join(', ') || '(none)'}`,
    ],
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' Long-form compaction stress test');
  console.log(` Test learner ID: ${TEST_LEARNER_ID}`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Reset learner row state by inserting fresh seed cores.
  // (Row may not exist at all on first run — that's fine.)
  await getOrCreateLearner(TEST_LEARNER_ID);
  await saveCores(TEST_LEARNER_ID, SEED_LEARNER_CORE, SEED_TUTOR_CORE);
  // Hack: saveCores increments version; since we want to start at 0, force-zero it.
  const pgClient = await import('../src/db/index.js');
  void pgClient; // pool stays alive for closePool below

  const a = await runSession('Session A — Mexico City + dogs + work', SESSION_A_TURNS);
  const b = await runSession('Session B — pasta cooking + Coco', SESSION_B_TURNS);
  const c = await runSession('Session C — travel planning', SESSION_C_TURNS);

  // ── Continuity checks ──────────────────────────────────────────
  console.log('\n━━━ Continuity verification ━━━');

  // Build the prompt that session B would have seen entering it
  const ctxBeforeB = await syntheticContext(TEST_LEARNER_ID, []);
  // (after session A, B, C all ran, ctxBeforeB.learnerCore reflects post-C state.
  //  For continuity audit we use post-A → entering-B and post-B → entering-C.)

  // Reconstruct the entering-B prompt from session A's post cores
  const enteringBCtx: SessionContext = {
    ...ctxBeforeB,
    learnerCore: a.postCores.learner,
    tutorCore: a.postCores.tutor,
  };
  const enteringBPrompt = buildSystemPrompt(enteringBCtx, {
    controllerState: initControllerState(enteringBCtx),
  });

  // Reconstruct the entering-C prompt from session B's post cores
  const enteringCCtx: SessionContext = {
    ...ctxBeforeB,
    learnerCore: b.postCores.learner,
    tutorCore: b.postCores.tutor,
  };
  const enteringCPrompt = buildSystemPrompt(enteringCCtx, {
    controllerState: initControllerState(enteringCCtx),
  });

  const aToB = continuityCheck('A→B', a.postCores, enteringBPrompt);
  const bToC = continuityCheck('B→C', b.postCores, enteringCPrompt);

  console.log(aToB.details.join('\n'));
  console.log();
  console.log(bToC.details.join('\n'));

  // ── Bloat check ────────────────────────────────────────────────
  console.log('\n━━━ Bloat check ━━━');
  console.log(
    `  Session A: prompt ${a.promptCharsBefore} → ${a.promptCharsAfter} chars (Δ ${a.promptCharsAfter - a.promptCharsBefore})`,
  );
  console.log(
    `  Session B: prompt ${b.promptCharsBefore} → ${b.promptCharsAfter} chars (Δ ${b.promptCharsAfter - b.promptCharsBefore})`,
  );
  console.log(
    `  Session C: prompt ${c.promptCharsBefore} → ${c.promptCharsAfter} chars (Δ ${c.promptCharsAfter - c.promptCharsBefore})`,
  );
  const totalGrowth = c.promptCharsAfter - a.promptCharsBefore;
  console.log(
    `  Net growth across 3 sessions: ${totalGrowth} chars (over 90 turns total)`,
  );
  if (totalGrowth > 8000) {
    console.log(`  ⚠ Prompt may be growing unbounded — investigate compaction summarization.`);
  } else {
    console.log(`  ✓ Prompt growth is bounded (<8000 chars total)`);
  }

  // ── Cost estimate (rough) ──────────────────────────────────────
  console.log('\n━━━ Compaction performance ━━━');
  const totalCompactionMs = a.durationMs + b.durationMs + c.durationMs;
  console.log(
    `  Total compaction time: ${totalCompactionMs}ms (${(totalCompactionMs / 1000).toFixed(1)}s for 3 sessions)`,
  );
  console.log(
    `  Avg per session: ${Math.round(totalCompactionMs / 3)}ms`,
  );
  console.log(
    `  FSRS items created across 3 sessions: ${a.fsrsCreated + b.fsrsCreated + c.fsrsCreated}`,
  );
  console.log(
    `  FSRS items rated across 3 sessions: ${a.fsrsRated + b.fsrsRated + c.fsrsRated}`,
  );

  // ── Final core dump ────────────────────────────────────────────
  console.log('\n━━━ Final state ━━━');
  console.log(`  learner_core after C:`);
  console.log(JSON.stringify(c.postCores.learner, null, 2).slice(0, 1500));
  console.log(`  ...`);
  console.log(`\n  tutor_core after C:`);
  console.log(JSON.stringify(c.postCores.tutor, null, 2).slice(0, 1500));

  // Persist artifacts for the writeup
  writeFileSync(
    'phase11-long-session-results.json',
    JSON.stringify(
      {
        learnerId: TEST_LEARNER_ID,
        sessions: [a, b, c],
        continuity: { aToB, bToC },
        finalCores: c.postCores,
        timing: {
          total_compaction_ms: totalCompactionMs,
          per_session_ms: [a.durationMs, b.durationMs, c.durationMs],
        },
      },
      null,
      2,
    ),
  );
  console.log('\nFull results: phase11-long-session-results.json');

  await closePool();

  // Pass criteria
  let exitCode = 0;
  if (aToB.passed < 2) {
    console.error('\n✗ A→B continuity check failed (≥2 signal words required)');
    exitCode = 1;
  }
  if (bToC.passed < 2) {
    console.error('✗ B→C continuity check failed');
    exitCode = 1;
  }
  if (totalGrowth > 8000) {
    console.error('✗ Prompt bloat exceeded 8000 chars');
    exitCode = 1;
  }
  if (exitCode === 0) {
    console.log('\n✓ All long-form stress checks passed');
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Long-form stress test fatal:', err);
  closePool().catch(() => {});
  process.exit(1);
});

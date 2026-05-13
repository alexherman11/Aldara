import pg from 'pg';
import { SEED_LEARNER_CORE, SEED_TUTOR_CORE } from '../seed-cores.js';
import type { LearnerCore, TutorCore, SessionData } from '../types.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ── 1. getOrCreateLearner ──────────────────────────────────────────

export async function getOrCreateLearner(learnerId: string) {
  const existing = await pool.query(
    'SELECT * FROM learners WHERE id = $1',
    [learnerId],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO learners (id, learner_core, tutor_core, core_version)
     VALUES ($1, $2, $3, 0)
     RETURNING *`,
    [learnerId, JSON.stringify(SEED_LEARNER_CORE), JSON.stringify(SEED_TUTOR_CORE)],
  );

  return result.rows[0];
}

// ── 1b. Learner profile (signup data) ──────────────────────────────

export interface LearnerProfile {
  name?: string;
  email?: string;
  age?: number;
  native_lang?: string;
  daily_goal_minutes?: number;
  streak?: number;
  onboarded_at?: string;
  cefr_initial?: string;
}

/**
 * Create a new learner row with profile data captured at signup. Generates a
 * fresh UUID (we want learner ids server-side so the client can't collide
 * with an existing learner by spoofing the id field).
 *
 * If `email` is provided and already exists, returns the existing learner
 * instead — local dev resets the browser frequently, and we don't want
 * every signup to create yet another row.
 */
export async function createLearnerWithProfile(
  profile: LearnerProfile,
  cefrLevel: string = 'A1',
) {
  if (profile.email) {
    const existing = await pool.query(
      'SELECT * FROM learners WHERE email = $1',
      [profile.email],
    );
    if (existing.rows.length > 0) {
      // Update profile fields on the existing row so the latest signup wins.
      const updated = await pool.query(
        `UPDATE learners
         SET profile = $2, cefr_level = $3
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id, JSON.stringify(profile), cefrLevel],
      );
      return updated.rows[0];
    }
  }

  const result = await pool.query(
    `INSERT INTO learners (learner_core, tutor_core, core_version, profile, email, cefr_level)
     VALUES ($1, $2, 0, $3, $4, $5)
     RETURNING *`,
    [
      JSON.stringify(SEED_LEARNER_CORE),
      JSON.stringify(SEED_TUTOR_CORE),
      JSON.stringify(profile),
      profile.email ?? null,
      cefrLevel,
    ],
  );
  return result.rows[0];
}

export async function getLearner(learnerId: string) {
  const result = await pool.query(
    'SELECT * FROM learners WHERE id = $1',
    [learnerId],
  );
  return result.rows[0] ?? null;
}

export async function patchLearnerProfile(
  learnerId: string,
  patch: Partial<LearnerProfile>,
) {
  const result = await pool.query(
    `UPDATE learners
     SET profile = COALESCE(profile, '{}'::jsonb) || $2::jsonb
     WHERE id = $1
     RETURNING *`,
    [learnerId, JSON.stringify(patch)],
  );
  return result.rows[0] ?? null;
}

// ── 2. saveCores ───────────────────────────────────────────────────

export async function saveCores(
  learnerId: string,
  learnerCore: LearnerCore,
  tutorCore: TutorCore,
) {
  await pool.query(
    `UPDATE learners
     SET learner_core = $2, tutor_core = $3, core_version = core_version + 1
     WHERE id = $1`,
    [learnerId, JSON.stringify(learnerCore), JSON.stringify(tutorCore)],
  );
}

// ── 3. getDueCards ─────────────────────────────────────────────────

export async function getDueCards(learnerId: string) {
  const result = await pool.query(
    `SELECT * FROM fsrs_cards
     WHERE learner_id = $1 AND due <= now()
     ORDER BY due ASC
     LIMIT 8`,
    [learnerId],
  );
  return result.rows;
}

// ── 4. upsertCard ──────────────────────────────────────────────────

export async function upsertCard(
  learnerId: string,
  card: {
    item_type: string;
    item_key: string;
    item_context?: string | null;
    due: Date;
    stability: number;
    difficulty: number;
    elapsed_days: number;
    scheduled_days: number;
    reps: number;
    lapses: number;
    state: number;
    last_review: Date | null;
  },
) {
  await pool.query(
    `INSERT INTO fsrs_cards
       (learner_id, item_type, item_key, item_context,
        due, stability, difficulty, elapsed_days, scheduled_days,
        reps, lapses, state, last_review)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (learner_id, item_type, item_key) DO UPDATE SET
       item_context = EXCLUDED.item_context,
       due = EXCLUDED.due,
       stability = EXCLUDED.stability,
       difficulty = EXCLUDED.difficulty,
       elapsed_days = EXCLUDED.elapsed_days,
       scheduled_days = EXCLUDED.scheduled_days,
       reps = EXCLUDED.reps,
       lapses = EXCLUDED.lapses,
       state = EXCLUDED.state,
       last_review = EXCLUDED.last_review`,
    [
      learnerId,
      card.item_type,
      card.item_key,
      card.item_context ?? null,
      card.due,
      card.stability,
      card.difficulty,
      card.elapsed_days,
      card.scheduled_days,
      card.reps,
      card.lapses,
      card.state,
      card.last_review,
    ],
  );
}

// ── 5. saveSession ─────────────────────────────────────────────────

export async function saveSession(sessionId: string, data: SessionData) {
  await pool.query(
    `UPDATE sessions
     SET ended_at = $2, transcript = $3, pre_cores = $4, post_cores = $5, compaction_log = $6
     WHERE id = $1`,
    [
      sessionId,
      data.ended_at,
      JSON.stringify(data.transcript),
      JSON.stringify(data.pre_cores),
      JSON.stringify(data.post_cores),
      data.compaction_log,
    ],
  );
}

// ── 6. createSession ───────────────────────────────────────────────

export async function createSession(learnerId: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO sessions (learner_id) VALUES ($1) RETURNING id`,
    [learnerId],
  );
  return result.rows[0].id;
}

// ── Pool management ────────────────────────────────────────────────

export async function closePool() {
  await pool.end();
}

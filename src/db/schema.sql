-- Idempotent schema. Re-running this is safe.
--
-- Tables:
--   learners   — one row per user (the prototype runs single-user locally,
--                but the schema allows multi-user when we deploy)
--   sessions   — one row per conversation, with pre/post compaction snapshots
--   fsrs_cards — per-learner spaced-repetition cards (FSRS algorithm)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── learners ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS learners (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  cefr_level      TEXT DEFAULT 'A1',
  session_count   INTEGER DEFAULT 0,
  learner_core    JSONB DEFAULT '{}',
  tutor_core      JSONB DEFAULT '{}',
  core_version    INTEGER DEFAULT 0
);

-- Profile fields collected during signup. Stored as a JSONB blob so the
-- onboarding flow can evolve without further migrations. Canonical keys:
--   name, email, age, native_lang, daily_goal_minutes, streak,
--   onboarded_at, cefr_initial
ALTER TABLE learners ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}';

-- Denormalized email for quick lookup of the "current user" in single-user
-- local dev. Optional and unique-when-present.
ALTER TABLE learners ADD COLUMN IF NOT EXISTS email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_learners_email
  ON learners(email)
  WHERE email IS NOT NULL;

-- ── sessions ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID REFERENCES learners(id),
  started_at      TIMESTAMPTZ DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  transcript      JSONB DEFAULT '[]',
  pre_cores       JSONB,
  post_cores      JSONB,
  compaction_log  TEXT
);

-- ── fsrs_cards ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fsrs_cards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID REFERENCES learners(id),
  item_type       TEXT NOT NULL,
  item_key        TEXT NOT NULL,
  item_context    TEXT,
  due             TIMESTAMPTZ NOT NULL DEFAULT now(),
  stability       REAL DEFAULT 0,
  difficulty      REAL DEFAULT 0,
  elapsed_days    REAL DEFAULT 0,
  scheduled_days  REAL DEFAULT 0,
  reps            INTEGER DEFAULT 0,
  lapses          INTEGER DEFAULT 0,
  state           INTEGER DEFAULT 0,
  last_review     TIMESTAMPTZ,
  UNIQUE(learner_id, item_type, item_key)
);

CREATE INDEX IF NOT EXISTS idx_fsrs_due ON fsrs_cards(learner_id, due);

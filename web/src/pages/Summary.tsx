import React, { useMemo } from 'react';
import { useLocation } from 'wouter';
import {
  Clock,
  CheckCircle2,
  Sparkles,
  BookOpen,
  Repeat,
  TrendingUp,
} from 'lucide-react';
import { motion } from 'framer-motion';

// ── Types ─────────────────────────────────────────────────────────────
//
// Mirrors what src/agent.ts publishes from the end_session RPC. We keep our
// own shape rather than importing from the backend because the wire payload
// is JSON and we want loose tolerance for missing fields (older agent
// versions, partial compaction failures, etc.).

interface FsrsUpdate {
  action: 'create' | 'rate';
  item_type?: string;
  item_key: string;
  context?: string;
  rating?: 'Again' | 'Hard' | 'Good' | 'Easy';
}

interface LearnerCoreShape {
  proficiency?: {
    cefr_level?: string;
    bilingual_ratio?: number;
  };
  vocabulary?: {
    active_count?: number;
    passive_count?: number;
  };
  grammar?: {
    mastered?: string[];
    emerging?: string[];
    breakthroughs?: string[];
    frontier?: string;
  };
  pronunciation?: {
    overall_score?: number;
  };
  learning_profile?: {
    interests?: string[];
  };
}

interface TutorCoreShape {
  bilingual_ratio_target?: number;
  pacing?: {
    current_push?: string;
  };
}

interface CompactionResult {
  ok: boolean;
  error?: string;
  preCores?: {
    learner?: LearnerCoreShape;
    tutor?: TutorCoreShape;
  };
  postCores?: {
    learner?: LearnerCoreShape;
    tutor?: TutorCoreShape;
  };
  fsrsUpdates?: FsrsUpdate[];
  compactionNotes?: string;
  fsrsCreated?: number;
  fsrsRated?: number;
  durationMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

function readLastCompaction(): CompactionResult | null {
  try {
    const raw = sessionStorage.getItem('habla_last_compaction');
    return raw ? (JSON.parse(raw) as CompactionResult) : null;
  } catch {
    return null;
  }
}

type Growth = { headline: string; detail: string };

/**
 * Compare pre/post cores and extract up to three concrete growth signals the
 * learner will care about. We bias toward items that are real and measurable
 * (a CEFR jump, a new grammar mastery) over fuzzy ones, and fall back to the
 * Sofía-authored compactionNotes when there's nothing structural to surface.
 */
function deriveGrowth(result: CompactionResult): Growth[] {
  const pre = result.preCores?.learner;
  const post = result.postCores?.learner;
  const preTutor = result.preCores?.tutor;
  const postTutor = result.postCores?.tutor;
  const out: Growth[] = [];

  // 1. CEFR jump — the most motivating signal we have.
  if (
    pre?.proficiency?.cefr_level &&
    post?.proficiency?.cefr_level &&
    pre.proficiency.cefr_level !== post.proficiency.cefr_level
  ) {
    out.push({
      headline: `Level: ${pre.proficiency.cefr_level} → ${post.proficiency.cefr_level}`,
      detail: 'Sofía nudged your CEFR rating after this session.',
    });
  }

  // 2. New grammar masteries (set diff).
  const newMastered = listDiff(
    post?.grammar?.mastered ?? [],
    pre?.grammar?.mastered ?? [],
  );
  if (newMastered.length > 0) {
    out.push({
      headline:
        newMastered.length === 1
          ? `Mastered: ${newMastered[0]}`
          : `Mastered ${newMastered.length} grammar points`,
      detail:
        newMastered.length <= 3
          ? newMastered.join(' · ')
          : `${newMastered.slice(0, 3).join(' · ')}, +${newMastered.length - 3} more`,
    });
  }

  // 3. New breakthroughs (qualitatively big wins the LLM flagged).
  const newBreakthroughs = listDiff(
    post?.grammar?.breakthroughs ?? [],
    pre?.grammar?.breakthroughs ?? [],
  );
  if (newBreakthroughs.length > 0 && out.length < 3) {
    out.push({
      headline: 'Breakthrough moment',
      detail: newBreakthroughs.slice(0, 2).join(' · '),
    });
  }

  // 4. Bilingual-ratio shift — only flag a meaningful move (≥5 percentage points).
  const preRatio = pre?.proficiency?.bilingual_ratio;
  const postRatio = post?.proficiency?.bilingual_ratio;
  if (
    preRatio != null &&
    postRatio != null &&
    Math.abs(postRatio - preRatio) >= 0.05 &&
    out.length < 3
  ) {
    const deltaPct = Math.round((preRatio - postRatio) * 100);
    if (deltaPct > 0) {
      // English share fell → learner using more Spanish.
      out.push({
        headline: `Speaking ${deltaPct}% more Spanish`,
        detail: 'Your bilingual ratio shifted toward Spanish in this session.',
      });
    } else if (deltaPct < 0 && out.length < 3) {
      out.push({
        headline: `Leaning ${Math.abs(deltaPct)}% on English`,
        detail: 'You reached for English more — Sofía will scaffold harder next time.',
      });
    }
  }

  // 5. Pronunciation overall score climb (only flag positive moves of ≥3 points).
  const prePron = pre?.pronunciation?.overall_score;
  const postPron = post?.pronunciation?.overall_score;
  if (
    prePron != null &&
    postPron != null &&
    postPron - prePron >= 3 &&
    out.length < 3
  ) {
    out.push({
      headline: `Pronunciation up ${Math.round(postPron - prePron)} pts`,
      detail: `Now averaging ${Math.round(postPron)}/100.`,
    });
  }

  // 6. Sofía's next push — new pacing focus from the tutor core.
  const newPush = postTutor?.pacing?.current_push;
  if (
    newPush &&
    newPush !== preTutor?.pacing?.current_push &&
    out.length < 3
  ) {
    out.push({
      headline: "Sofía's next focus",
      detail: newPush,
    });
  }

  // 7. New grammar frontier (where Sofía is pushing next).
  if (
    post?.grammar?.frontier &&
    post.grammar.frontier !== pre?.grammar?.frontier &&
    out.length < 3
  ) {
    out.push({
      headline: 'New grammar frontier',
      detail: post.grammar.frontier,
    });
  }

  return out.slice(0, 3);
}

function listDiff(after: string[], before: string[]): string[] {
  const beforeSet = new Set(before.map((s) => s.toLowerCase().trim()));
  return after.filter((s) => !beforeSet.has(s.toLowerCase().trim()));
}

const RATING_TONE: Record<
  NonNullable<FsrsUpdate['rating']>,
  { label: string; color: string; bg: string }
> = {
  Easy: { label: 'Easy', color: 'hsl(140 60% 32%)', bg: 'hsl(140 60% 50% / 0.14)' },
  Good: { label: 'Good', color: 'hsl(160 50% 32%)', bg: 'hsl(160 50% 50% / 0.14)' },
  Hard: { label: 'Hard', color: 'hsl(38 80% 32%)', bg: 'hsl(38 90% 55% / 0.16)' },
  Again: { label: 'Again', color: 'hsl(0 65% 40%)', bg: 'hsl(0 75% 55% / 0.12)' },
};

// ── Component ────────────────────────────────────────────────────────

export default function Summary() {
  const [, setLocation] = useLocation();
  const result = useMemo(readLastCompaction, []);

  const newItems = (result?.fsrsUpdates ?? []).filter(
    (u) => u.action === 'create',
  );
  const practiced = (result?.fsrsUpdates ?? []).filter(
    (u) => u.action === 'rate',
  );
  const growth = result?.ok ? deriveGrowth(result) : [];

  // Headline picks the most exciting thing to lead with. CEFR jumps win,
  // then new vocab counts, then a generic line.
  const headline = useMemo(() => {
    if (!result?.ok) return null;
    const pre = result.preCores?.learner?.proficiency?.cefr_level;
    const post = result.postCores?.learner?.proficiency?.cefr_level;
    if (pre && post && pre !== post) {
      return `You leveled up to ${post}`;
    }
    if (newItems.length > 0) {
      return `You added ${newItems.length} new ${newItems.length === 1 ? 'item' : 'items'} today`;
    }
    if (practiced.length > 0) {
      return `You practiced ${practiced.length} ${practiced.length === 1 ? 'item' : 'items'}`;
    }
    return 'Nicely done';
  }, [result, newItems.length, practiced.length]);

  return (
    <div className="flex-1 flex flex-col bg-background overflow-y-auto">
      <div className="flex-1 flex flex-col max-w-md w-full mx-auto px-6 pt-12 pb-8">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-5"
            style={{ background: 'hsl(15 85% 52% / 0.15)' }}
          >
            <CheckCircle2
              className="w-8 h-8"
              style={{ color: 'hsl(15 85% 52%)' }}
            />
          </div>
          <h1 className="font-serif text-4xl text-foreground mb-2 leading-tight">
            Session Complete
          </h1>
          {headline && (
            <p className="text-base text-foreground/80">{headline}</p>
          )}
          {!result?.ok && (
            <p className="text-sm text-muted-foreground mt-1">
              {result?.error
                ? "Sofía couldn't compact this session, but you still spoke."
                : 'Great work today.'}
            </p>
          )}
        </motion.div>

        {/* Growth chips — three quick reads on how you changed. */}
        {growth.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="flex flex-col gap-2 mb-6"
            data-testid="growth-list"
          >
            {growth.map((g, i) => (
              <div
                key={i}
                className="bg-card border border-border rounded-xl px-4 py-3 flex items-start gap-3"
              >
                <TrendingUp
                  className="w-4 h-4 shrink-0 mt-0.5"
                  style={{ color: 'hsl(15 85% 52%)' }}
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {g.headline}
                  </p>
                  <p className="text-xs text-muted-foreground leading-snug mt-0.5">
                    {g.detail}
                  </p>
                </div>
              </div>
            ))}
          </motion.div>
        )}

        {/* New items you discovered. */}
        {newItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-card border border-border rounded-2xl p-5 mb-4 shadow-sm"
            data-testid="new-items"
          >
            <div className="flex items-center gap-2 mb-3">
              <BookOpen
                className="w-4 h-4"
                style={{ color: 'hsl(15 85% 52%)' }}
              />
              <h3 className="text-sm font-semibold text-foreground">
                {newItems.length === 1
                  ? 'New today'
                  : `${newItems.length} new today`}
              </h3>
            </div>
            <ul className="flex flex-col gap-2">
              {newItems.slice(0, 8).map((item, i) => (
                <li
                  key={i}
                  className="rounded-lg px-3 py-2 border"
                  style={{
                    background: 'hsl(28 85% 56% / 0.07)',
                    borderColor: 'hsl(28 85% 56% / 0.20)',
                  }}
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span
                      className="font-semibold text-foreground"
                      style={{ fontFamily: 'var(--app-font-serif)' }}
                    >
                      {item.item_key}
                    </span>
                    <span
                      className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                      style={{
                        background: 'hsl(28 85% 56% / 0.18)',
                        color: 'hsl(28 75% 40%)',
                      }}
                    >
                      {item.item_type || 'vocabulary'}
                    </span>
                  </div>
                  {item.context && (
                    <p className="text-xs text-muted-foreground italic mt-1 leading-snug">
                      “{item.context}”
                    </p>
                  )}
                </li>
              ))}
              {newItems.length > 8 && (
                <li className="text-xs text-muted-foreground italic pl-1">
                  +{newItems.length - 8} more in your deck.
                </li>
              )}
            </ul>
          </motion.div>
        )}

        {/* Items you came back to. */}
        {practiced.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-card border border-border rounded-2xl p-5 mb-4 shadow-sm"
            data-testid="practiced-items"
          >
            <div className="flex items-center gap-2 mb-3">
              <Repeat
                className="w-4 h-4"
                style={{ color: 'hsl(15 85% 52%)' }}
              />
              <h3 className="text-sm font-semibold text-foreground">
                Came back to
              </h3>
            </div>
            <ul className="flex flex-col gap-1.5">
              {practiced.slice(0, 8).map((item, i) => {
                const tone = item.rating ? RATING_TONE[item.rating] : null;
                return (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-muted/30"
                  >
                    <span
                      className="font-medium text-foreground truncate"
                      style={{ fontFamily: 'var(--app-font-serif)' }}
                    >
                      {item.item_key}
                    </span>
                    {tone && (
                      <span
                        className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md"
                        style={{ color: tone.color, background: tone.bg }}
                      >
                        {tone.label}
                      </span>
                    )}
                  </li>
                );
              })}
              {practiced.length > 8 && (
                <li className="text-xs text-muted-foreground italic pl-1 mt-1">
                  +{practiced.length - 8} more rated.
                </li>
              )}
            </ul>
          </motion.div>
        )}

        {/* Sofía's note — the LLM's narrative summary. */}
        {result?.ok && result.compactionNotes?.trim() && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="bg-card border border-border rounded-2xl p-5 mb-4 shadow-sm"
            data-testid="sofia-note"
          >
            <div className="flex items-center gap-2 mb-2">
              <Sparkles
                className="w-4 h-4"
                style={{ color: 'hsl(15 85% 52%)' }}
              />
              <h3 className="text-sm font-semibold text-foreground">
                Sofía's note
              </h3>
            </div>
            <p className="text-sm text-foreground/80 leading-relaxed">
              {result.compactionNotes.trim()}
            </p>
          </motion.div>
        )}

        {/* Empty / error state. */}
        {(!result?.ok ||
          (newItems.length === 0 &&
            practiced.length === 0 &&
            growth.length === 0 &&
            !result?.compactionNotes?.trim())) && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-card border border-border rounded-2xl p-6 mb-4 shadow-sm flex flex-col items-center text-center gap-2"
          >
            <Clock className="w-6 h-6" style={{ color: 'hsl(15 85% 52%)' }} />
            <p className="text-sm text-muted-foreground">
              {result?.error
                ? `Compaction reported: ${result.error}`
                : 'No compaction result captured — you may have ended the session before Sofía joined.'}
            </p>
            <p className="text-xs text-muted-foreground">
              Live pipeline state is in the Developer tab if you've enabled it.
            </p>
          </motion.div>
        )}

        {/* Footer stats + streak. */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-card border border-border rounded-2xl p-4 mb-6 flex items-center gap-3"
        >
          <span className="text-2xl">🔥</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">
              Streak going
            </p>
            <p className="text-xs text-muted-foreground">
              See you again tomorrow.
            </p>
          </div>
          {result?.durationMs != null && (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground opacity-70 shrink-0">
              compacted in {(result.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </motion.div>

        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          onClick={() => setLocation('/home')}
          className="w-full rounded-xl text-base font-semibold text-white"
          style={{
            height: 52,
            background:
              'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
            boxShadow: '0 4px 18px hsl(15 85% 52% / 0.30)',
          }}
          data-testid="btn-done"
        >
          Back to Home
        </motion.button>
      </div>
    </div>
  );
}

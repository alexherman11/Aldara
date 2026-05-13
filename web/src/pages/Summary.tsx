import React, { useMemo } from 'react';
import { useLocation } from 'wouter';
import { Clock, CheckCircle2, MessageSquare, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';

interface CompactionResult {
  ok: boolean;
  error?: string;
  preCores?: {
    learner_core?: Record<string, unknown>;
    tutor_core?: Record<string, unknown>;
  };
  postCores?: {
    learner?: Record<string, unknown>;
    tutor?: Record<string, unknown>;
  };
  fsrsUpdates?: unknown[];
  compactionNotes?: string;
  fsrsCreated?: number;
  fsrsRated?: number;
  durationMs?: number;
}

function readLastCompaction(): CompactionResult | null {
  try {
    const raw = sessionStorage.getItem('habla_last_compaction');
    return raw ? (JSON.parse(raw) as CompactionResult) : null;
  } catch {
    return null;
  }
}

function summarize(result: CompactionResult | null) {
  if (!result || !result.ok) return null;
  const fsrsAdded = result.fsrsCreated ?? 0;
  const fsrsRated = result.fsrsRated ?? 0;
  const notes = result.compactionNotes?.trim() || '';
  return { fsrsAdded, fsrsRated, notes, durationMs: result.durationMs };
}

export default function Summary() {
  const [, setLocation] = useLocation();
  const result = useMemo(readLastCompaction, []);
  const summary = summarize(result);

  return (
    <div className="flex-1 flex flex-col bg-background p-6 overflow-y-auto">
      <div className="flex-1 flex flex-col justify-center max-w-sm w-full mx-auto py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-6"
            style={{ background: 'hsl(15 85% 52% / 0.15)' }}
          >
            <CheckCircle2
              className="w-8 h-8"
              style={{ color: 'hsl(15 85% 52%)' }}
            />
          </div>
          <h1 className="font-serif text-4xl text-foreground mb-2">
            Session Complete
          </h1>
          <p className="text-muted-foreground">
            {result?.ok
              ? 'Sofía updated your cores in Postgres.'
              : result?.error
                ? "Sofía couldn't compact this session, but you still spoke."
                : 'Great work today.'}
          </p>
        </motion.div>

        {/* Compaction result card */}
        {summary && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-card border border-border rounded-2xl p-6 mb-5 shadow-md"
          >
            <div className="flex items-center gap-3 text-muted-foreground mb-5">
              <Sparkles className="w-5 h-5" style={{ color: 'hsl(15 85% 52%)' }} />
              <span className="font-semibold text-foreground">
                Compaction completed
              </span>
              {summary.durationMs != null && (
                <span className="text-xs">
                  ({(summary.durationMs / 1000).toFixed(1)}s)
                </span>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">
                  Spaced repetition
                </h3>
                <div
                  className="rounded-xl p-4 border"
                  style={{
                    background: 'hsl(28 85% 56% / 0.08)',
                    borderColor: 'hsl(28 85% 56% / 0.25)',
                  }}
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">New cards</span>
                    <span
                      className="font-semibold"
                      style={{ color: 'hsl(28 75% 55%)' }}
                    >
                      +{summary.fsrsAdded}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm mt-1">
                    <span className="text-muted-foreground">Rated</span>
                    <span
                      className="font-semibold"
                      style={{ color: 'hsl(28 75% 55%)' }}
                    >
                      {summary.fsrsRated}
                    </span>
                  </div>
                </div>
              </div>

              {summary.notes && (
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">
                    Sofía's note
                  </h3>
                  <p className="text-sm text-foreground/80 leading-relaxed">
                    {summary.notes}
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Fallback (no compaction yet) */}
        {!summary && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-card border border-border rounded-2xl p-6 mb-5 shadow-md flex flex-col items-center text-center gap-3"
          >
            <Clock
              className="w-6 h-6"
              style={{ color: 'hsl(15 85% 52%)' }}
            />
            <p className="text-sm text-muted-foreground">
              {result?.error
                ? `Compaction reported: ${result.error}`
                : 'No compaction result captured — you may have ended the session before Sofía joined.'}
            </p>
            <p className="text-xs text-muted-foreground">
              You can see live compaction logs and architecture in the Debug
              tab.
            </p>
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-card border border-border rounded-2xl p-4 mb-8 flex items-center gap-3"
        >
          <MessageSquare
            className="w-5 h-5 shrink-0"
            style={{ color: 'hsl(15 85% 52%)' }}
          />
          <div>
            <p className="text-sm font-semibold text-foreground">
              Streak going
            </p>
            <p className="text-xs text-muted-foreground">
              See you again tomorrow.
            </p>
          </div>
          <span className="ml-auto text-2xl">🔥</span>
        </motion.div>

        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
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

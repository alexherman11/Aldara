import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { patchLearner, patchStoredLearner, readStoredLearner } from '@/lib/api';

const GOALS = [
  { mins: 10, label: '10 min / day', desc: 'Light & consistent' },
  { mins: 15, label: '15 min / day', desc: 'Steady progress' },
  { mins: 20, label: '20 min / day', desc: 'Accelerate fast' },
];

export default function DailyGoal() {
  const [, setLocation] = useLocation();
  const [selected, setSelected] = useState<number | null>(15);
  const [saving, setSaving] = useState(false);

  const handleConfirm = async () => {
    if (!selected) return;
    const stored = readStoredLearner();
    if (!stored) {
      setLocation('/signup');
      return;
    }
    setSaving(true);
    try {
      await patchLearner(stored.id, { daily_goal_minutes: selected });
    } catch (err) {
      console.warn('Failed to patch learner profile:', err);
      // Don't block the onboarding flow on a backend hiccup — the local
      // cache will still reflect the choice and the user can keep moving.
    }
    patchStoredLearner({
      profile: { daily_goal_minutes: selected },
      onboarded: true,
    });
    setLocation('/home');
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 bg-background">
      <div className="mb-7" style={{ width: 110, height: 110 }}>
        <Orb state="idle" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-8"
      >
        <h1 className="font-serif text-3xl text-foreground mb-2">
          Set your daily goal
        </h1>
        <p className="text-muted-foreground text-sm">
          How much time will you speak with Sofía each day?
        </p>
      </motion.div>

      <div className="w-full max-w-sm flex flex-col gap-3 mb-10">
        {GOALS.map(({ mins, label, desc }, i) => {
          const isSelected = selected === mins;
          return (
            <motion.button
              key={mins}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 * i }}
              onClick={() => setSelected(mins)}
              className="w-full flex items-center justify-between px-5 py-4 rounded-2xl border-2 transition-all text-left"
              style={{
                borderColor: isSelected
                  ? 'hsl(15 85% 52%)'
                  : 'hsl(var(--border))',
                background: isSelected
                  ? 'hsl(15 85% 52% / 0.08)'
                  : 'hsl(var(--card))',
              }}
            >
              <div>
                <p
                  className="font-semibold text-base"
                  style={{
                    color: isSelected
                      ? 'hsl(15 70% 70%)'
                      : 'hsl(var(--foreground))',
                  }}
                >
                  {label}
                </p>
                <p className="text-sm text-muted-foreground mt-0.5">{desc}</p>
              </div>
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all"
                style={{
                  background: isSelected
                    ? 'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))'
                    : 'hsl(var(--muted))',
                }}
              >
                {isSelected && (
                  <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
                )}
              </div>
            </motion.button>
          );
        })}
      </div>

      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35 }}
        onClick={handleConfirm}
        disabled={!selected || saving}
        className="w-full max-w-sm rounded-xl text-base font-semibold text-white transition-opacity disabled:opacity-50"
        style={{
          height: 52,
          background: 'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
          boxShadow: '0 4px 18px hsl(15 85% 52% / 0.30)',
        }}
        data-testid="btn-confirm-goal"
      >
        {saving ? 'Saving…' : 'Start Learning →'}
      </motion.button>
    </div>
  );
}

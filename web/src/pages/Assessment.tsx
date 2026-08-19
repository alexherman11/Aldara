import React, { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { motion, AnimatePresence } from 'framer-motion';
import { readStoredLearner } from '@/lib/api';

const STAGES = [
  {
    title: 'Hola, ¿qué tal?',
    sub: 'Sofía is your patient, curious Spanish tutor.',
  },
  {
    title: 'Habla — no escribas.',
    sub: 'You talk, she listens, she corrects gently. No typing, no flashcards.',
  },
  {
    title: 'Una conversación a la vez.',
    sub: 'Your first session doubles as the assessment. She picks the level.',
  },
];

export default function Assessment() {
  const [, setLocation] = useLocation();
  const [stage, setStage] = useState(0);
  const stored = readStoredLearner();
  const name = stored?.profile?.name?.trim() || 'amigo';

  useEffect(() => {
    if (stage < STAGES.length - 1) {
      const t = setTimeout(() => setStage((s) => s + 1), 2600);
      return () => clearTimeout(t);
    }
  }, [stage]);

  return (
    <div
      className="flex-1 flex flex-col relative overflow-hidden"
      style={{
        background:
          'linear-gradient(160deg, hsl(38 30% 94%) 0%, hsl(28 22% 86%) 100%)',
      }}
    >
      <button
        onClick={() => setLocation('/daily-goal')}
        className="absolute top-10 right-6 z-20 text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
        data-testid="btn-skip"
      >
        Skip →
      </button>

      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <motion.div
          layoutId="dara-orb"
          style={{ width: 200, height: 200, marginBottom: 36 }}
          transition={{ layout: { duration: 1.0, ease: [0.22, 1, 0.36, 1] } }}
        >
          <Orb state="speaking" />
        </motion.div>

        <AnimatePresence mode="wait">
          <motion.div
            key={stage}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.35 }}
            className="max-w-md"
          >
            <h1 className="font-serif text-3xl md:text-4xl text-foreground mb-3">
              {stage === 0 ? `Hola, ${name}` : STAGES[stage].title}
            </h1>
            <p className="text-base text-muted-foreground">
              {STAGES[stage].sub}
            </p>
          </motion.div>
        </AnimatePresence>

        <div className="flex gap-2 mt-12">
          {STAGES.map((_, i) => (
            <div
              key={i}
              className="h-1 w-8 rounded-full transition-all"
              style={{
                background:
                  i <= stage ? 'hsl(15 85% 52%)' : 'hsl(15 85% 52% / 0.20)',
              }}
            />
          ))}
        </div>

        <button
          onClick={() => {
            if (stage < STAGES.length - 1) setStage((s) => s + 1);
            else setLocation('/daily-goal');
          }}
          className="mt-10 px-8 h-12 rounded-xl text-base font-semibold text-white"
          style={{
            background:
              'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
            boxShadow: '0 4px 18px hsl(15 85% 52% / 0.25)',
          }}
        >
          {stage < STAGES.length - 1 ? 'Continuar →' : 'Set my daily goal →'}
        </button>
      </div>
    </div>
  );
}

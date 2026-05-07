import React from 'react';
import { useLocation } from 'wouter';
import { Clock, CheckCircle2, MessageSquare } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Summary() {
  const [, setLocation] = useLocation();

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
            <CheckCircle2 className="w-8 h-8" style={{ color: 'hsl(15 85% 52%)' }} />
          </div>
          <h1 className="font-serif text-4xl text-foreground mb-2">Session Complete</h1>
          <p className="text-muted-foreground">Great work today.</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-card border border-border rounded-2xl p-6 mb-5 shadow-md"
        >
          <div className="flex items-center gap-3 text-muted-foreground mb-5">
            <Clock className="w-5 h-5" style={{ color: 'hsl(15 85% 52%)' }} />
            <span className="font-semibold text-foreground">8 min 24 sec</span>
            <span className="text-sm">spoken today</span>
          </div>

          <div className="space-y-5">
            <div>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">
                Corrections
              </h3>
              <div
                className="rounded-xl p-4 border"
                style={{
                  background: 'hsl(44 90% 52% / 0.08)',
                  borderColor: 'hsl(44 90% 52% / 0.25)',
                }}
              >
                <p className="text-sm text-muted-foreground line-through mb-1">
                  un pelicula de accion
                </p>
                <p
                  className="text-sm font-semibold flex items-center gap-2"
                  style={{ color: 'hsl(38 80% 65%)' }}
                >
                  <span className="text-xs">→</span> una película de acción
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">
                Words you used well
              </h3>
              <div className="flex flex-wrap gap-2">
                {['emocionante', 'fin de semana', 'amigos'].map((word) => (
                  <span
                    key={word}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium border"
                    style={{
                      background: 'hsl(28 85% 56% / 0.12)',
                      borderColor: 'hsl(28 85% 56% / 0.30)',
                      color: 'hsl(28 70% 65%)',
                    }}
                  >
                    {word}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">
                Dara's note
              </h3>
              <p className="text-sm text-foreground/80 leading-relaxed">
                Good use of past tense! Keep practicing article gender agreement — it's the most common area to improve at your level.
              </p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-card border border-border rounded-2xl p-4 mb-8 flex items-center gap-3"
        >
          <MessageSquare className="w-5 h-5 shrink-0" style={{ color: 'hsl(15 85% 52%)' }} />
          <div>
            <p className="text-sm font-semibold text-foreground">7-day streak</p>
            <p className="text-xs text-muted-foreground">Keep it going tomorrow!</p>
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
            background: 'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
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

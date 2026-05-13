import React from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { SettingsDrawer } from '@/components/SettingsDrawer';
import { motion } from 'framer-motion';

export default function Home() {
  const [, setLocation] = useLocation();
  const userStr = localStorage.getItem('lingua_user');
  const user = userStr ? JSON.parse(userStr) : { name: 'Amigo' };
  const dailyGoal = user.dailyGoal || 20;

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 pt-10 pb-2">
        <h1 className="font-serif text-2xl text-foreground">Hola, {user.name}</h1>
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-card"
          data-testid="streak-counter"
        >
          <span className="text-orange-400 text-sm">🔥</span>
          <span className="text-foreground text-sm font-semibold">{user.streak || 7}</span>
        </div>
      </div>

      {/* Orb — centered */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <motion.div
          layoutId="dara-orb"
          style={{ width: 240, height: 240 }}
          className="cursor-pointer"
          onClick={() => setLocation('/session')}
          whileTap={{ scale: 0.97 }}
          transition={{ layout: { duration: 1.2, ease: [0.22, 1, 0.36, 1] } }}
          data-testid="home-orb"
        >
          <Orb state="idle" />
        </motion.div>

        <p className="mt-5 text-xs tracking-[0.2em] uppercase" style={{ color: 'hsl(var(--muted-foreground) / 0.6)' }}>
          Tap to begin
        </p>
      </div>

      {/* Bottom: hamburger + progress bars */}
      <div className="px-6 pb-10 space-y-5">
        <div className="flex items-center justify-between mb-1">
          <SettingsDrawer />
        </div>

        {/* Progress — minutes spoken */}
        <div data-testid="progress-minutes">
          <div className="flex justify-between items-baseline mb-2">
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              Minutes spoken today
            </span>
            <span className="text-sm font-semibold text-foreground">12 / {dailyGoal}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'linear-gradient(90deg, hsl(15 85% 52%), hsl(28 85% 56%))' }}
              initial={{ width: 0 }}
              animate={{ width: `${Math.round((12 / dailyGoal) * 100)}%` }}
              transition={{ duration: 1.1, delay: 0.2, ease: 'easeOut' }}
            />
          </div>
        </div>

        {/* Progress — words learned */}
        <div data-testid="progress-words">
          <div className="flex justify-between items-baseline mb-2">
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              Words learned
            </span>
            <span className="text-sm font-semibold text-foreground">47 / 100</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'linear-gradient(90deg, hsl(28 85% 56%), hsl(44 90% 52%))' }}
              initial={{ width: 0 }}
              animate={{ width: '47%' }}
              transition={{ duration: 1.1, delay: 0.4, ease: 'easeOut' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

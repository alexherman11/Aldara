import React, { useState } from 'react';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';
import { Menu, User, TrendingUp, History, Pencil, ChevronRight } from 'lucide-react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';

type Tab = 'profile' | 'progress' | 'history';

const SKILL_BARS = [
  { label: 'Speaking', pct: 65, color: 'hsl(15 85% 52%)' },
  { label: 'Listening', pct: 55, color: 'hsl(25 90% 54%)' },
  { label: 'Vocabulary', pct: 70, color: 'hsl(38 90% 52%)' },
  { label: 'Grammar', pct: 45, color: 'hsl(8 80% 50%)' },
];

const MILESTONES = [
  { date: 'May 6, 2026', label: 'First session', level: 'A1', note: 'Completed intro assessment.' },
  { date: 'May 10, 2026', label: 'Week 1 check-in', level: 'A2', note: 'Improved verb conjugation.' },
  { date: 'May 20, 2026', label: 'Month checkpoint', level: 'B1', note: 'Held a 5-min conversation in Spanish.' },
];

function ProfileTab({ user }: { user: Record<string, string> }) {
  const initials = (user.name || 'U')
    .split(' ')
    .map((w: string) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="flex flex-col items-center pt-4 pb-2">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold text-white mb-3 shadow-lg"
          style={{ background: 'linear-gradient(135deg, hsl(15 85% 52%), hsl(40 90% 55%))' }}
        >
          {initials}
        </div>
        <p className="font-serif text-xl text-foreground">{user.name || '—'}</p>
        <p className="text-sm text-muted-foreground">{user.email || '—'}</p>
      </div>

      <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
        {[
          { label: 'Spanish Level', value: user.cefrLevel || 'A1' },
          { label: 'Native Language', value: user.nativeLang || '—' },
          { label: 'Learning', value: 'Spanish' },
          { label: 'Daily Goal', value: `${user.dailyGoal || 15} min / day` },
          { label: 'Current Streak', value: `${user.streak || 5} days 🔥` },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="text-sm font-semibold text-foreground">{value}</span>
          </div>
        ))}
      </div>

      <button
        className="flex items-center justify-center gap-2 w-full h-11 rounded-xl border-2 text-sm font-semibold transition-colors"
        style={{ borderColor: 'hsl(15 85% 52% / 0.30)', color: 'hsl(15 70% 65%)' }}
      >
        <Pencil className="w-4 h-4" />
        Edit Profile
      </button>
    </div>
  );
}

function ProgressTab({ user }: { user: Record<string, string> }) {
  const goal = parseInt(user.dailyGoal || '15');
  const minsThisWeek = 42;

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
        {[
          { label: 'Started Learning', value: 'May 2026' },
          { label: 'Initial Assessed Level', value: 'A1' },
          { label: 'Current Level', value: user.cefrLevel || 'B1' },
          { label: 'Total Speaking Time', value: '3h 22m' },
          { label: 'Sessions Completed', value: '14' },
          { label: 'Conversation Min This Week', value: `${minsThisWeek} / ${7 * goal}` },
          { label: 'Longest Streak', value: '12 days' },
          { label: 'Estimated Words Practiced', value: '340+' },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="text-sm font-semibold text-foreground">{value}</span>
          </div>
        ))}
      </div>

      <div className="bg-card border border-border rounded-2xl p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Skill Breakdown
        </p>
        <div className="flex flex-col gap-3">
          {SKILL_BARS.map(({ label, pct, color }) => (
            <div key={label}>
              <div className="flex justify-between items-baseline mb-1.5">
                <span className="text-sm text-foreground font-medium">{label}</span>
                <span className="text-xs text-muted-foreground font-semibold">{pct}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.9, ease: 'easeOut' }}
                  style={{ background: color }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        className="rounded-2xl p-4 border relative overflow-hidden"
        style={{ background: 'hsl(28 90% 55% / 0.08)', borderColor: 'hsl(28 90% 55% / 0.25)' }}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          Next Focus
        </p>
        <p className="text-sm font-medium" style={{ color: 'hsl(28 70% 65%)' }}>
          Past tense and longer sentence responses.
        </p>
      </div>
    </div>
  );
}

function HistoryTab() {
  return (
    <div className="flex flex-col gap-4 pb-8">
      <p className="text-sm text-muted-foreground pt-1">
        Milestone sessions check if your level has improved.
      </p>
      {MILESTONES.map((m, i) => (
        <motion.div
          key={m.label}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.07 }}
          className="bg-card border border-border rounded-2xl p-4 flex items-start gap-3"
        >
          <div
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-white mt-0.5"
            style={{ background: 'linear-gradient(135deg, hsl(15 85% 52%), hsl(35 90% 55%))' }}
          >
            {m.level}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-0.5">
              <p className="text-sm font-semibold text-foreground">{m.label}</p>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            </div>
            <p className="text-xs text-muted-foreground mb-1">{m.date}</p>
            <p className="text-sm" style={{ color: 'hsl(var(--foreground) / 0.7)' }}>{m.note}</p>
          </div>
        </motion.div>
      ))}
      <div className="text-center pt-2">
        <p className="text-xs text-muted-foreground">
          Next milestone session unlocks after 5 more conversations.
        </p>
      </div>
    </div>
  );
}

export function SettingsDrawer() {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>('profile');

  const raw = localStorage.getItem('lingua_user');
  const user: Record<string, string> = raw ? JSON.parse(raw) : {};

  const handleLogout = () => {
    localStorage.removeItem('lingua_user');
    setLocation('/signup');
  };

  const tabs: { id: Tab; label: string; Icon: typeof User }[] = [
    { id: 'profile', label: 'Profile', Icon: User },
    { id: 'progress', label: 'Progress', Icon: TrendingUp },
    { id: 'history', label: 'History', Icon: History },
  ];

  return (
    <Drawer direction="left">
      <DrawerTrigger asChild>
        <button
          className="p-2 -ml-2 text-muted-foreground hover:text-foreground transition-colors"
          data-testid="btn-menu"
        >
          <Menu className="w-5 h-5" />
        </button>
      </DrawerTrigger>

      <DrawerContent className="bg-background border-r border-border h-full w-[300px] rounded-none m-0 flex flex-col">
        <div className="shrink-0 px-5 pt-10 pb-3">
          <h2 className="font-serif text-xl text-foreground">Dara</h2>
          <p className="text-xs text-muted-foreground">Tu santuario de aprendizaje</p>
        </div>

        <div className="shrink-0 flex items-center gap-1 px-4 pb-3 border-b border-border">
          {tabs.map(({ id, label, Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="flex-1 flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-semibold transition-all"
                style={{
                  background: isActive ? 'hsl(15 85% 52% / 0.10)' : 'transparent',
                  color: isActive ? 'hsl(15 70% 65%)' : 'hsl(var(--muted-foreground))',
                }}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-4 pt-4" style={{ scrollbarWidth: 'thin' }}>
          {activeTab === 'profile' && <ProfileTab user={user} />}
          {activeTab === 'progress' && <ProgressTab user={user} />}
          {activeTab === 'history' && <HistoryTab />}
        </div>

        <div className="shrink-0 px-4 pb-8 pt-2 border-t border-border">
          <button
            onClick={handleLogout}
            className="w-full h-10 rounded-xl text-sm font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-destructive/50 transition-colors"
          >
            Sign out
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

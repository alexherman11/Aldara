import React, { useEffect, useState } from 'react';
import {
  Drawer,
  DrawerContent,
  DrawerTrigger,
} from '@/components/ui/drawer';
import {
  Menu,
  User,
  TrendingUp,
  Terminal,
  Pencil,
  RefreshCcw,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import {
  clearStoredLearner,
  getDebugConfig,
  getLearnerState,
  readStoredLearner,
  type DebugConfig,
  type LearnerState,
  type StoredLearner,
} from '@/lib/api';

type Tab = 'profile' | 'progress' | 'debug';

// ── Profile ───────────────────────────────────────────────────────────

function ProfileTab({ stored }: { stored: StoredLearner | null }) {
  const profile = stored?.profile ?? {};
  const initials = (profile.name || 'U')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="flex flex-col items-center pt-4 pb-2">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold text-white mb-3 shadow-lg"
          style={{
            background:
              'linear-gradient(135deg, hsl(15 85% 52%), hsl(40 90% 55%))',
          }}
        >
          {initials}
        </div>
        <p className="font-serif text-xl text-foreground">
          {profile.name || '—'}
        </p>
        <p className="text-sm text-muted-foreground">{profile.email || '—'}</p>
      </div>

      <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
        {[
          { label: 'Spanish Level', value: stored?.cefr_level || 'A1' },
          { label: 'Age', value: profile.age ? String(profile.age) : '—' },
          { label: 'Learning', value: 'Spanish' },
          {
            label: 'Daily Goal',
            value: `${profile.daily_goal_minutes ?? 15} min / day`,
          },
          {
            label: 'Current Streak',
            value: `${profile.streak ?? 1} day${(profile.streak ?? 1) === 1 ? '' : 's'} 🔥`,
          },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="flex items-center justify-between px-4 py-3"
          >
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="text-sm font-semibold text-foreground">{value}</span>
          </div>
        ))}
      </div>

      <button
        disabled
        className="flex items-center justify-center gap-2 w-full h-11 rounded-xl border-2 text-sm font-semibold transition-colors opacity-60"
        style={{
          borderColor: 'hsl(15 85% 52% / 0.30)',
          color: 'hsl(15 70% 65%)',
        }}
      >
        <Pencil className="w-4 h-4" />
        Edit Profile (soon)
      </button>
    </div>
  );
}

// ── Progress ──────────────────────────────────────────────────────────

function ProgressTab({ state }: { state: LearnerState | null }) {
  const sessions = state?.learner.session_count ?? 0;
  const cefr = state?.learner.cefr_level ?? 'A1';
  const cards = state?.fsrs_cards ?? [];
  const due = cards.filter(
    (c) => new Date(c.due).getTime() <= Date.now(),
  ).length;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
        {[
          { label: 'Sessions Completed', value: String(sessions) },
          { label: 'Current Level', value: cefr },
          {
            label: 'Core Version',
            value: `v${state?.learner.core_version ?? 0}`,
          },
          { label: 'FSRS Cards (total)', value: String(cards.length) },
          { label: 'FSRS Cards (due now)', value: String(due) },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="flex items-center justify-between px-4 py-3"
          >
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="text-sm font-semibold text-foreground">
              {value}
            </span>
          </div>
        ))}
      </div>

      {cards.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Items in rotation
          </p>
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {cards.slice(0, 20).map((c, i) => (
              <div
                key={i}
                className="bg-card border border-border rounded-lg px-3 py-2 text-xs flex items-center justify-between gap-3"
              >
                <span className="font-medium text-foreground truncate">
                  {c.item_key}
                </span>
                <span
                  className="shrink-0 px-1.5 py-0.5 rounded-md uppercase text-[10px] font-semibold tracking-wider"
                  style={{
                    background: 'hsl(28 85% 56% / 0.10)',
                    color: 'hsl(28 75% 55%)',
                  }}
                >
                  {c.item_type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {sessions === 0 && (
        <div
          className="rounded-2xl p-4 border text-sm"
          style={{
            background: 'hsl(28 90% 55% / 0.08)',
            borderColor: 'hsl(28 90% 55% / 0.25)',
            color: 'hsl(28 65% 45%)',
          }}
        >
          Once you finish your first conversation and compact it, Sofía writes
          your evolved cores into Postgres and seeds FSRS items — they'll
          appear here.
        </div>
      )}
    </div>
  );
}

// ── Debug (compaction architecture, agent config) ─────────────────────

function DebugTab({
  state,
  config,
  loading,
  onRefresh,
}: {
  state: LearnerState | null;
  config: DebugConfig | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const lastCompactionRaw =
    typeof window !== 'undefined'
      ? sessionStorage.getItem('habla_last_compaction')
      : null;
  let lastCompaction: unknown = null;
  try {
    if (lastCompactionRaw) lastCompaction = JSON.parse(lastCompactionRaw);
  } catch {
    /* ignore */
  }

  return (
    <div className="flex flex-col gap-4 pb-8">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Compaction architecture
        </p>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCcw
            className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </button>
      </div>

      <ArchitectureDiagram />

      {/* Live pipeline config */}
      <Section title="Pipeline">
        {config ? (
          <KvList
            rows={[
              ['STT', config.pipeline.stt],
              ['LLM', config.pipeline.llm],
              ['TTS', config.pipeline.tts],
              ['VAD', config.pipeline.vad],
              ['Pronunciation', config.pipeline.pronunciation],
              ['Compaction LLM', config.pipeline.compaction_llm],
              ['Scheduler', config.pipeline.scheduler],
            ]}
          />
        ) : (
          <Placeholder>Backend offline — start the server.</Placeholder>
        )}
      </Section>

      <Section title="LiveKit">
        {config ? (
          <KvList
            rows={[
              ['Server', config.livekit.url],
              ['Agent name', config.livekit.agent_name],
            ]}
          />
        ) : (
          <Placeholder>—</Placeholder>
        )}
      </Section>

      <Section title="Learner state">
        {state ? (
          <KvList
            rows={[
              ['Learner ID', state.learner.id],
              ['Core version', `v${state.learner.core_version}`],
              ['CEFR', state.learner.cefr_level],
              ['Sessions', String(state.learner.session_count)],
              [
                'Last session',
                state.last_session
                  ? `${new Date(state.last_session.started_at).toLocaleString()} (${state.last_session.transcript_length} turns)`
                  : '—',
              ],
            ]}
          />
        ) : (
          <Placeholder>No learner state yet — finish signup.</Placeholder>
        )}
      </Section>

      <Section title="Learner core (JSONB)">
        <pre className="text-[11px] leading-snug overflow-x-auto bg-muted/40 rounded-lg p-3 max-h-56 overflow-y-auto">
          {state ? JSON.stringify(state.learner.learner_core, null, 2) : '—'}
        </pre>
      </Section>

      <Section title="Tutor core (JSONB)">
        <pre className="text-[11px] leading-snug overflow-x-auto bg-muted/40 rounded-lg p-3 max-h-56 overflow-y-auto">
          {state ? JSON.stringify(state.learner.tutor_core, null, 2) : '—'}
        </pre>
      </Section>

      <Section title="Last compaction result">
        <pre className="text-[11px] leading-snug overflow-x-auto bg-muted/40 rounded-lg p-3 max-h-56 overflow-y-auto">
          {lastCompaction
            ? JSON.stringify(lastCompaction, null, 2)
            : 'No compaction yet this browser session.'}
        </pre>
      </Section>

      <Section title="Database">
        {config ? (
          <KvList
            rows={[
              ['Connection', config.db.url_masked || '—'],
              ['Record turns', config.env.record_turns ? 'on' : 'off'],
              [
                'LEARNER_ID env override',
                config.env.learner_override ? 'set (debug)' : 'unset',
              ],
            ]}
          />
        ) : (
          <Placeholder>—</Placeholder>
        )}
      </Section>
    </div>
  );
}

function ArchitectureDiagram() {
  return (
    <div className="bg-card border border-border rounded-2xl p-3">
      <pre
        className="text-[11px] leading-tight font-mono text-muted-foreground whitespace-pre"
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
{`           ┌────────────┐
 mic ────► │  Deepgram  │ ──► transcript
           └────────────┘
                  │
                  ▼
           ┌────────────┐
           │   GPT-4o   │ ◄── learner_core + tutor_core (JSONB)
           └────────────┘
                  │             plus FSRS due-cards
                  ▼
           ┌────────────┐
           │  Cartesia  │ ──► Sofía's voice
           └────────────┘

End session ─► Claude (Sonnet) compaction
   • diff cores  → save back to learners.{learner_core, tutor_core}
   • upsert FSRS → rate items via ts-fsrs, write fsrs_cards`}
      </pre>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </p>
      {children}
    </div>
  );
}

function KvList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between px-3 py-2 gap-3">
          <span className="text-xs text-muted-foreground">{k}</span>
          <span className="text-xs font-mono text-foreground text-right truncate">
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

// ── Drawer container ─────────────────────────────────────────────────

export function SettingsDrawer() {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const stored = readStoredLearner();

  const [state, setState] = useState<LearnerState | null>(null);
  const [config, setConfig] = useState<DebugConfig | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = React.useCallback(async () => {
    if (!stored) return;
    setLoading(true);
    try {
      const [s, c] = await Promise.allSettled([
        getLearnerState(stored.id),
        getDebugConfig(),
      ]);
      if (s.status === 'fulfilled') setState(s.value);
      if (c.status === 'fulfilled') setConfig(c.value);
    } finally {
      setLoading(false);
    }
  }, [stored]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSignOut = () => {
    clearStoredLearner();
    setLocation('/signup');
  };

  const tabs: { id: Tab; label: string; Icon: typeof User }[] = [
    { id: 'profile', label: 'Profile', Icon: User },
    { id: 'progress', label: 'Progress', Icon: TrendingUp },
    { id: 'debug', label: 'Debug', Icon: Terminal },
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

      <DrawerContent className="bg-background border-r border-border h-full w-[340px] rounded-none m-0 flex flex-col">
        <div className="shrink-0 px-5 pt-10 pb-3">
          <h2 className="font-serif text-xl text-foreground">Sofía</h2>
          <p className="text-xs text-muted-foreground">
            Tu santuario de aprendizaje
          </p>
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
                  background: isActive
                    ? 'hsl(15 85% 52% / 0.10)'
                    : 'transparent',
                  color: isActive
                    ? 'hsl(15 70% 65%)'
                    : 'hsl(var(--muted-foreground))',
                }}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            );
          })}
        </div>

        <div
          className="flex-1 overflow-y-auto px-4 pt-4"
          style={{ scrollbarWidth: 'thin' }}
        >
          {activeTab === 'profile' && <ProfileTab stored={stored} />}
          {activeTab === 'progress' && <ProgressTab state={state} />}
          {activeTab === 'debug' && (
            <DebugTab
              state={state}
              config={config}
              loading={loading}
              onRefresh={refresh}
            />
          )}
        </div>

        <div className="shrink-0 px-4 pb-8 pt-2 border-t border-border">
          <button
            onClick={handleSignOut}
            className="w-full h-10 rounded-xl text-sm font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-destructive/50 transition-colors"
          >
            Sign out
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

// Re-export so the rest of the app can mention motion without re-importing
// — keeps Home/Session imports tidy.
export { motion };

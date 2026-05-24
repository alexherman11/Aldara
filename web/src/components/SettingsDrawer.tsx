import React, { useEffect, useState, useSyncExternalStore } from 'react';
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
  RefreshCcw,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import {
  clearStoredLearner,
  getDebugConfig,
  getLearnerState,
  readStoredLearner,
  readTtsChoice,
  writeTtsChoice,
  TTS_OPTIONS,
  type DebugConfig,
  type LearnerState,
  type StoredLearner,
  type TtsChoice,
} from '@/lib/api';
import {
  devBus,
  onDevModeChange,
  readDevMode,
  writeDevMode,
  type DevSnapshot,
} from '@/lib/dev-bus';

type Tab = 'profile' | 'progress' | 'developer';

// ── Hooks ────────────────────────────────────────────────────────────

function useDevMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => readDevMode());
  useEffect(() => onDevModeChange((v) => setOn(v)), []);
  return [on, (next: boolean) => writeDevMode(next)];
}

function useDevSnapshot(): DevSnapshot {
  return useSyncExternalStore(
    (cb) => devBus.subscribe(cb),
    () => devBus.getSnapshot(),
    () => devBus.getSnapshot(),
  );
}

// ── Profile ───────────────────────────────────────────────────────────

function ProfileTab({
  stored,
  devMode,
  setDevMode,
}: {
  stored: StoredLearner | null;
  devMode: boolean;
  setDevMode: (on: boolean) => void;
}) {
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

      <SettingsToggleRow
        label="Developer mode"
        helper="Show pipeline internals, learner core JSON, and live conversation diagnostics."
        on={devMode}
        onChange={setDevMode}
        testId="toggle-dev-mode"
      />
    </div>
  );
}

function SettingsToggleRow({
  label,
  helper,
  on,
  onChange,
  testId,
}: {
  label: string;
  helper?: string;
  on: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl px-4 py-3 flex items-start justify-between gap-3">
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {helper && (
          <span className="text-xs text-muted-foreground mt-0.5 leading-snug">
            {helper}
          </span>
        )}
      </div>
      <button
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        data-testid={testId}
        className="shrink-0 relative w-11 h-6 rounded-full transition-colors"
        style={{
          background: on ? 'hsl(15 85% 52%)' : 'hsl(var(--muted))',
        }}
      >
        <span
          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
          style={{
            transform: on ? 'translateX(22px)' : 'translateX(2px)',
          }}
        />
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

// ── Developer (only shown when dev mode is on) ────────────────────────

function DeveloperTab({
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
  const snapshot = useDevSnapshot();
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

      <Disclosure title="Live session" defaultOpen>
        <LiveSession snapshot={snapshot} />
      </Disclosure>

      <Disclosure title="Pipeline & LiveKit">
        {config ? (
          <div className="flex flex-col gap-3">
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
            <VoiceSelectorInline />
            <KvList
              rows={[
                ['Server', config.livekit.url],
                ['Agent name', config.livekit.agent_name],
              ]}
            />
          </div>
        ) : (
          <Placeholder>Backend offline — start the server.</Placeholder>
        )}
      </Disclosure>

      <Disclosure title="Learner state">
        {state ? (
          <div className="flex flex-col gap-3">
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
            <JsonPre
              label="Learner core"
              value={state.learner.learner_core}
            />
            <JsonPre label="Tutor core" value={state.learner.tutor_core} />
          </div>
        ) : (
          <Placeholder>No learner state yet — finish signup.</Placeholder>
        )}
      </Disclosure>

      <Disclosure title="Last compaction & DB">
        <div className="flex flex-col gap-3">
          <JsonPre
            label="Last compaction result"
            value={lastCompaction ?? 'No compaction yet this browser session.'}
          />
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
        </div>
      </Disclosure>
    </div>
  );
}

function LiveSession({ snapshot }: { snapshot: DevSnapshot }) {
  const { room, agent, turns, lastPronunciation, ptt } = snapshot;

  if (!room.roomName && !agent && turns.length === 0) {
    return (
      <Placeholder>
        Open a session — agent state, recent turns, and pronunciation payloads
        will stream here in real time.
      </Placeholder>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <KvList
        rows={[
          ['Room', room.roomName || '—'],
          ['LiveKit URL', room.url || '—'],
          ['Agent identity', agent?.identity || '—'],
          [
            'Agent state',
            agent
              ? `${agent.state} (${msAgo(agent.ts)})`
              : '—',
          ],
          [
            'PTT',
            ptt.capturing
              ? `capturing (started ${msAgo(ptt.lastStart)})`
              : ptt.lastEnd
                ? `idle (ended ${msAgo(ptt.lastEnd)})`
                : 'idle',
          ],
        ]}
      />

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
          Recent turns (last {turns.length})
        </p>
        {turns.length === 0 ? (
          <Placeholder>No turns yet.</Placeholder>
        ) : (
          <div className="flex flex-col gap-1.5">
            {turns.map((t, i) => (
              <div
                key={i}
                className="bg-card border border-border rounded-lg px-3 py-2 text-xs flex items-start gap-2"
              >
                <span
                  className="shrink-0 font-semibold uppercase text-[10px] tracking-wider"
                  style={{
                    color:
                      t.role === 'tutor'
                        ? 'hsl(var(--muted-foreground))'
                        : 'hsl(15 70% 50%)',
                  }}
                >
                  {t.role === 'tutor' ? 'Sofía' : 'tú'}
                </span>
                <span className="text-foreground flex-1 break-words">
                  {t.text || <em className="opacity-50">…</em>}
                  {!t.final && <em className="opacity-50"> (interim)</em>}
                </span>
                {t.pronunciationScore != null && (
                  <span
                    className="shrink-0 text-[10px] font-semibold"
                    style={{ color: 'hsl(15 70% 45%)' }}
                  >
                    {Math.round(t.pronunciationScore)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <JsonPre
        label="Last pronunciation payload"
        value={lastPronunciation ?? 'None this session.'}
      />
    </div>
  );
}

function msAgo(ts: number | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 1000) return `${diff}ms ago`;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  return `${Math.round(diff / 60_000)}m ago`;
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

function Disclosure({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="group bg-card/40 border border-border rounded-xl overflow-hidden"
      open={defaultOpen}
    >
      <summary
        className="px-3 py-2 flex items-center justify-between cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        style={{ listStyle: 'none' }}
      >
        <span>{title}</span>
        <span className="text-[10px] opacity-60 group-open:rotate-90 transition-transform">
          ▶
        </span>
      </summary>
      <div className="px-3 pb-3 pt-1">{children}</div>
    </details>
  );
}

function JsonPre({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}
      </p>
      <pre className="text-[11px] leading-snug overflow-x-auto bg-muted/40 rounded-lg p-3 max-h-56 overflow-y-auto">
        {typeof value === 'string'
          ? value
          : JSON.stringify(value, null, 2)}
      </pre>
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

// Per-session voice/provider picker. The choice is persisted to localStorage
// and read by Session.tsx when it requests a LiveKit token — so it applies to
// the next session, not the one currently running (TTS is bound at the agent
// session's start).
function VoiceSelectorInline() {
  const [choice, setChoice] = useState<TtsChoice>(() => readTtsChoice());
  return (
    <div className="bg-card border border-border rounded-2xl p-3 flex flex-col gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Voice (TTS)
      </span>
      <select
        value={choice}
        onChange={(e) => {
          const v = e.target.value as TtsChoice;
          setChoice(v);
          writeTtsChoice(v);
        }}
        className="w-full h-9 rounded-lg border border-border bg-background px-2 text-xs font-mono text-foreground"
        data-testid="select-tts"
      >
        {TTS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-muted-foreground">
        Applies to your next session — start a new conversation to hear it.
      </p>
    </div>
  );
}

// ── Drawer container ─────────────────────────────────────────────────

export function SettingsDrawer() {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [devMode, setDevMode] = useDevMode();
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

  // If dev mode flips off while the developer tab is active, bounce back
  // to Profile so we don't get stuck on a hidden tab.
  useEffect(() => {
    if (!devMode && activeTab === 'developer') setActiveTab('profile');
  }, [devMode, activeTab]);

  const handleSignOut = () => {
    clearStoredLearner();
    setLocation('/signup');
  };

  const tabs: { id: Tab; label: string; Icon: typeof User }[] = [
    { id: 'profile', label: 'Profile', Icon: User },
    { id: 'progress', label: 'Progress', Icon: TrendingUp },
    ...(devMode
      ? [{ id: 'developer' as Tab, label: 'Developer', Icon: Terminal }]
      : []),
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

        <div className="shrink-0 flex items-stretch gap-6 px-5 border-b border-border">
          {tabs.map(({ id, label, Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="flex items-center gap-1.5 py-3 text-xs font-semibold uppercase tracking-wider transition-colors relative"
                style={{
                  color: isActive
                    ? 'hsl(15 70% 50%)'
                    : 'hsl(var(--muted-foreground))',
                }}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
                {isActive && (
                  <span
                    className="absolute left-0 right-0 -bottom-px h-0.5 rounded-full"
                    style={{ background: 'hsl(15 85% 52%)' }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div
          className="flex-1 overflow-y-auto px-5 pt-4"
          style={{ scrollbarWidth: 'thin' }}
        >
          {activeTab === 'profile' && (
            <ProfileTab
              stored={stored}
              devMode={devMode}
              setDevMode={setDevMode}
            />
          )}
          {activeTab === 'progress' && <ProgressTab state={state} />}
          {activeTab === 'developer' && devMode && (
            <DeveloperTab
              state={state}
              config={config}
              loading={loading}
              onRefresh={refresh}
            />
          )}
        </div>

        <div className="shrink-0 px-5 pb-8 pt-2 border-t border-border">
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

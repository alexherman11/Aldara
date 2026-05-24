// Tiny pub/sub the Developer tab subscribes to so it can show live session
// diagnostics (agent state, recent turns, pronunciation payloads, PTT state)
// without Session.tsx having to know about the drawer or vice versa.
//
// The bus is a no-op when nobody is listening — Session.tsx still calls
// `publish(...)` on every event, but it just touches an empty subscriber set.

export type DevTurn = {
  role: 'tutor' | 'learner';
  text: string;
  final: boolean;
  pronunciationScore?: number;
  ts: number;
};

export type DevPronunciation = {
  reference_text: string;
  recognized_text?: string;
  overall: {
    accuracy: number;
    fluency: number;
    completeness: number;
    pronunciation: number;
  };
  divergence: boolean;
  ts: number;
};

export type DevPtt = {
  capturing: boolean;
  lastStart?: number;
  lastEnd?: number;
};

export type DevAgentState = {
  identity: string | null;
  state: string;
  ts: number;
};

export type DevRoom = {
  roomName: string | null;
  url: string | null;
};

export type DevSnapshot = {
  room: DevRoom;
  agent: DevAgentState | null;
  turns: DevTurn[];
  lastPronunciation: DevPronunciation | null;
  ptt: DevPtt;
};

const EMPTY_SNAPSHOT: DevSnapshot = {
  room: { roomName: null, url: null },
  agent: null,
  turns: [],
  lastPronunciation: null,
  ptt: { capturing: false },
};

let snapshot: DevSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<(s: DevSnapshot) => void>();
const MAX_TURNS = 5;

function emit() {
  for (const fn of listeners) fn(snapshot);
}

export const devBus = {
  getSnapshot(): DevSnapshot {
    return snapshot;
  },
  subscribe(fn: (s: DevSnapshot) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  setRoom(room: DevRoom) {
    snapshot = { ...snapshot, room };
    emit();
  },
  setAgent(agent: DevAgentState) {
    snapshot = { ...snapshot, agent };
    emit();
  },
  recordTurn(turn: DevTurn) {
    // Coalesce streaming updates: if the most recent entry is the same role
    // and not-final, replace it instead of pushing a duplicate.
    const last = snapshot.turns[snapshot.turns.length - 1];
    let nextTurns: DevTurn[];
    if (last && last.role === turn.role && !last.final) {
      nextTurns = [...snapshot.turns.slice(0, -1), turn];
    } else {
      nextTurns = [...snapshot.turns, turn].slice(-MAX_TURNS);
    }
    snapshot = { ...snapshot, turns: nextTurns };
    emit();
  },
  setPronunciation(p: DevPronunciation) {
    // Attach the score to the matching learner turn if we can find it.
    const refKey = p.reference_text.trim().toLowerCase();
    const nextTurns = snapshot.turns.map((t) =>
      t.role === 'learner' && t.text.trim().toLowerCase() === refKey
        ? { ...t, pronunciationScore: p.overall.pronunciation }
        : t,
    );
    snapshot = {
      ...snapshot,
      lastPronunciation: p,
      turns: nextTurns,
    };
    emit();
  },
  setPtt(ptt: Partial<DevPtt>) {
    snapshot = { ...snapshot, ptt: { ...snapshot.ptt, ...ptt } };
    emit();
  },
  reset() {
    snapshot = EMPTY_SNAPSHOT;
    emit();
  },
};

// ── Dev-mode preference (persisted to localStorage) ───────────────────

const DEV_MODE_KEY = 'habla_dev_mode';
const DEV_MODE_EVENT = 'habla:dev-mode';

export function readDevMode(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(DEV_MODE_KEY) === '1';
}

export function writeDevMode(on: boolean): void {
  if (typeof window === 'undefined') return;
  if (on) window.localStorage.setItem(DEV_MODE_KEY, '1');
  else window.localStorage.removeItem(DEV_MODE_KEY);
  window.dispatchEvent(new CustomEvent(DEV_MODE_EVENT, { detail: on }));
}

export function onDevModeChange(fn: (on: boolean) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<boolean>).detail);
  window.addEventListener(DEV_MODE_EVENT, handler);
  return () => window.removeEventListener(DEV_MODE_EVENT, handler);
}

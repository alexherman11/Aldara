/**
 * Tiny client for the Express token-server. In dev, requests go through
 * Vite's /api proxy → http://127.0.0.1:3000. In prod (after `vite build`),
 * the token-server serves the same /api routes alongside the static SPA so
 * relative URLs work in both modes.
 */

export interface LearnerProfile {
  name?: string;
  email?: string;
  age?: number;
  native_lang?: string;
  daily_goal_minutes?: number;
  streak?: number;
  cefr_initial?: string;
  onboarded_at?: string;
}

export interface Learner {
  id: string;
  cefr_level: string;
  profile: LearnerProfile;
  session_count?: number;
  created_at?: string;
}

export interface TokenResponse {
  token: string;
  url: string;
  room: string;
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const resp = await fetch(path, { ...init, body, headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}${text ? ' — ' + text : ''}`);
  }
  return resp.json() as Promise<T>;
}

export function createLearner(
  profile: LearnerProfile,
  cefrLevel: string,
): Promise<Learner> {
  return request<Learner>('/api/learner', {
    method: 'POST',
    json: { profile, cefrLevel },
  });
}

export function getLearner(id: string): Promise<Learner> {
  return request<Learner>(`/api/learner/${encodeURIComponent(id)}`);
}

export function patchLearner(
  id: string,
  profile: Partial<LearnerProfile>,
): Promise<Learner> {
  return request<Learner>(`/api/learner/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: { profile },
  });
}

export interface LearnerState {
  learner: {
    id: string;
    cefr_level: string;
    session_count: number;
    core_version: number;
    profile: LearnerProfile;
    learner_core: Record<string, unknown>;
    tutor_core: Record<string, unknown>;
    created_at: string;
  };
  fsrs_cards: Array<{
    item_type: string;
    item_key: string;
    item_context: string | null;
    due: string;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    state: number;
    last_review: string | null;
  }>;
  last_session: {
    id: string;
    started_at: string;
    ended_at: string | null;
    pre_cores: Record<string, unknown> | null;
    post_cores: Record<string, unknown> | null;
    compaction_log: string | null;
    transcript_length: number;
  } | null;
}

export function getLearnerState(id: string): Promise<LearnerState> {
  return request<LearnerState>(`/api/learner/${encodeURIComponent(id)}/state`);
}

export interface DebugConfig {
  livekit: { url: string; agent_name: string };
  pipeline: {
    stt: string;
    llm: string;
    tts: string;
    vad: string;
    pronunciation: string;
    compaction_llm: string;
    scheduler: string;
  };
  db: { url_masked: string };
  env: { record_turns: boolean; learner_override: boolean };
}

export function getDebugConfig(): Promise<DebugConfig> {
  return request<DebugConfig>('/api/debug/config');
}

// ── TTS voice selection ───────────────────────────────────────────────

// Which voice/provider the agent renders Sofía with. Chosen in the Debug tab,
// passed to /api/token, and stamped into LiveKit dispatch metadata so the
// agent's createTts() picks it up. Takes effect on the next session started.
export const TTS_OPTIONS = [
  { value: 'cartesia', label: 'Cartesia — Sonic 3 (es)' },
  { value: 'openai', label: 'OpenAI — gpt-4o-mini-tts' },
  { value: 'google-flash', label: 'Google — Gemini 2.5 Flash TTS' },
  { value: 'google-pro', label: 'Google — Gemini 2.5 Pro TTS' },
  { value: 'inworld', label: 'Inworld — TTS-2' },
] as const;

export type TtsChoice = (typeof TTS_OPTIONS)[number]['value'];

// Mirrors TTS_PROVIDER in .env so the dropdown's initial value matches what
// the agent would use before any explicit pick.
export const DEFAULT_TTS: TtsChoice = 'openai';

const TTS_STORAGE_KEY = 'habla_tts';

export function readTtsChoice(): TtsChoice {
  try {
    const raw = localStorage.getItem(TTS_STORAGE_KEY);
    if (raw && TTS_OPTIONS.some((o) => o.value === raw)) {
      return raw as TtsChoice;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_TTS;
}

export function writeTtsChoice(choice: TtsChoice): void {
  try {
    localStorage.setItem(TTS_STORAGE_KEY, choice);
  } catch {
    /* ignore */
  }
}

export function getToken(opts: {
  learnerId: string;
  room?: string;
  identity?: string;
  tts?: string;
}): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set('learnerId', opts.learnerId);
  if (opts.room) params.set('room', opts.room);
  if (opts.identity) params.set('identity', opts.identity);
  if (opts.tts) params.set('tts', opts.tts);
  return request<TokenResponse>(`/api/token?${params.toString()}`);
}

// ── Local user store ──────────────────────────────────────────────────

// Single-user local dev keeps the learner id (returned from POST /api/learner)
// in localStorage so reload keeps you signed in. The id is the source of
// truth — profile fields stored alongside are a UI cache that gets refreshed
// from /api/learner/:id on app load.

const STORAGE_KEY = 'habla_learner';

export interface StoredLearner {
  id: string;
  profile: LearnerProfile;
  cefr_level: string;
  // Local-only UI hint — used by the onboarding flow to decide whether to
  // route a returning user past signup.
  onboarded?: boolean;
}

export function readStoredLearner(): StoredLearner | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'string') return parsed as StoredLearner;
    return null;
  } catch {
    return null;
  }
}

export function writeStoredLearner(s: StoredLearner): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function patchStoredLearner(patch: Partial<StoredLearner>): StoredLearner | null {
  const cur = readStoredLearner();
  if (!cur) return null;
  const next: StoredLearner = {
    ...cur,
    ...patch,
    profile: { ...cur.profile, ...(patch.profile ?? {}) },
  };
  writeStoredLearner(next);
  return next;
}

export function clearStoredLearner(): void {
  localStorage.removeItem(STORAGE_KEY);
}

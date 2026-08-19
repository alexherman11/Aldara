import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { dirname, join, resolve as resolvePath, isAbsolute } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createLearnerWithProfile,
  getLearner,
  getLearnerDebugState,
  patchLearnerProfile,
  type LearnerProfile,
} from './db/index.js';
import { TTS_CATALOG, resolveCatalogEntry } from './tts-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
const LIVEKIT_URL = process.env.LIVEKIT_URL!;
// Agent name to dispatch into web-view rooms. Matches the `agentName` set in
// src/agent.ts. Without this, the web view connects to a room with no agent —
// the scenario harness uses its own explicit dispatch, but the browser flow
// goes through here.
const SOFIA_AGENT_NAME = process.env.SOFIA_AGENT_NAME || 'sofia';

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
  console.error('Missing LIVEKIT_API_KEY, LIVEKIT_API_SECRET, or LIVEKIT_URL');
  process.exit(1);
}

// Convert wss:// → https:// for the dispatch REST endpoint
const LIVEKIT_HTTP_URL = LIVEKIT_URL.replace(/^wss?:\/\//, (m) =>
  m === 'wss://' ? 'https://' : 'http://',
);
const dispatchClient = new AgentDispatchClient(
  LIVEKIT_HTTP_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
);

const app = express();
app.use(express.json({ limit: '64kb' }));

// ── Learner endpoints (signup / profile) ─────────────────────────────

const ALLOWED_PROFILE_KEYS: Array<keyof LearnerProfile> = [
  'name',
  'email',
  'age',
  'native_lang',
  'daily_goal_minutes',
  'streak',
  'onboarded_at',
  'cefr_initial',
];

function sanitizeProfile(body: unknown): LearnerProfile {
  if (!body || typeof body !== 'object') return {};
  const src = body as Record<string, unknown>;
  const out: LearnerProfile = {};
  for (const k of ALLOWED_PROFILE_KEYS) {
    if (src[k] === undefined || src[k] === null) continue;
    // Light type coercion — the React signup form sends "age" as a string.
    if (k === 'age' || k === 'daily_goal_minutes' || k === 'streak') {
      const n = Number(src[k]);
      if (Number.isFinite(n)) (out as Record<string, unknown>)[k] = n;
    } else {
      (out as Record<string, unknown>)[k] = String(src[k]);
    }
  }
  return out;
}

app.post('/api/learner', async (req: Request, res: Response) => {
  try {
    const profile = sanitizeProfile(req.body?.profile ?? req.body);
    const cefrLevel = typeof req.body?.cefrLevel === 'string'
      ? req.body.cefrLevel
      : profile.cefr_initial || 'A1';

    const learner = await createLearnerWithProfile(profile, cefrLevel);
    res.json({
      id: learner.id,
      cefr_level: learner.cefr_level,
      profile: learner.profile,
      created_at: learner.created_at,
    });
  } catch (err) {
    console.error('[token-server] POST /api/learner failed:', err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/learner/:id', async (req: Request, res: Response) => {
  try {
    const learner = await getLearner(String(req.params.id));
    if (!learner) {
      res.status(404).json({ error: 'learner not found' });
      return;
    }
    res.json({
      id: learner.id,
      cefr_level: learner.cefr_level,
      profile: learner.profile,
      session_count: learner.session_count,
      created_at: learner.created_at,
    });
  } catch (err) {
    console.error('[token-server] GET /api/learner failed:', err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/learner/:id/state', async (req: Request, res: Response) => {
  try {
    const state = await getLearnerDebugState(String(req.params.id));
    if (!state) {
      res.status(404).json({ error: 'learner not found' });
      return;
    }
    res.json(state);
  } catch (err) {
    console.error('[token-server] GET /api/learner/:id/state failed:', err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/learner/:id', async (req: Request, res: Response) => {
  try {
    const patch = sanitizeProfile(req.body?.profile ?? req.body);
    const learner = await patchLearnerProfile(String(req.params.id), patch);
    if (!learner) {
      res.status(404).json({ error: 'learner not found' });
      return;
    }
    res.json({
      id: learner.id,
      cefr_level: learner.cefr_level,
      profile: learner.profile,
    });
  } catch (err) {
    console.error('[token-server] PATCH /api/learner failed:', err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── LiveKit token endpoint ───────────────────────────────────────────

// Token endpoint — also pre-dispatches the Sofía agent into the room so the
// browser doesn't have to wait/retry for an agent to materialize. The
// learnerId travels as dispatch metadata so the agent picks up the right
// Postgres row on connect (replaces the old hardcoded LEARNER_ID env var).
app.get('/api/token', async (req: Request, res: Response) => {
  const room = (req.query.room as string) || `habla-${Date.now()}`;
  const identity = (req.query.identity as string) || 'learner';
  const learnerId = (req.query.learnerId as string) || '';
  // Legacy single-string voice/provider id (cartesia | openai | google-flash |
  // google-pro | inworld). Kept for back-compat with older browser sessions —
  // the new picker uses ttsProvider+ttsVoice below.
  const tts = (req.query.tts as string) || '';
  // New paired voice/provider params from the Settings drawer picker. Validated
  // against TTS_CATALOG below; an invalid combination 400s so a typo in the
  // query string surfaces immediately instead of silently falling back to
  // Cartesia and leaving the user wondering why their voice didn't change.
  const ttsProviderRaw = (req.query.ttsProvider as string) || '';
  const ttsVoiceRaw = (req.query.ttsVoice as string) || '';
  let ttsProvider = '';
  let ttsVoice = '';
  if (ttsProviderRaw || ttsVoiceRaw) {
    const entry = resolveCatalogEntry(ttsProviderRaw, ttsVoiceRaw || undefined);
    if (!entry) {
      res.status(400).json({
        error:
          `Unknown TTS provider/voice combination: ` +
          `provider=${ttsProviderRaw || '∅'} voice=${ttsVoiceRaw || '∅'}. ` +
          `See /api/debug/config for the catalog.`,
      });
      return;
    }
    ttsProvider = entry.provider;
    ttsVoice = entry.voice;
  }
  // STT engine for this session — assemblyai (default), deepgram, or soniox. Picked
  // in the Settings drawer's Developer tab; passed through dispatch metadata
  // and consumed in agent.ts createStt(). Validated against a fixed allowlist
  // so an unrecognized value just falls back silently to the env default
  // rather than crashing session boot.
  const sttRaw = (req.query.stt as string) || '';
  const stt =
    sttRaw === 'assemblyai' || sttRaw === 'deepgram' || sttRaw === 'soniox'
      ? sttRaw
      : '';

  // Session mode — 'placement' for the post-signup calibration conversation,
  // anything else (or absent) is a normal tutoring session. Rides in dispatch
  // metadata so the agent picks the calibration controller + placement prompt.
  const mode = (req.query.mode as string) === 'placement' ? 'placement' : '';

  // Fire the dispatch BEFORE returning the token so by the time the browser
  // connects, LiveKit already has a pending dispatch waiting for this room.
  // Failure here doesn't block token issuance — surface a warning instead so
  // a misconfigured dispatch doesn't make the page un-loadable.
  try {
    const meta: Record<string, string> = {};
    if (learnerId) meta.learnerId = learnerId;
    if (tts) meta.tts = tts;
    if (ttsProvider) meta.ttsProvider = ttsProvider;
    if (ttsVoice) meta.ttsVoice = ttsVoice;
    if (stt) meta.stt = stt;
    if (mode) meta.mode = mode;
    const metadata = Object.keys(meta).length ? JSON.stringify(meta) : '';
    const d = await dispatchClient.createDispatch(room, SOFIA_AGENT_NAME, {
      metadata,
    });
    console.log(
      `[token-server] dispatched ${SOFIA_AGENT_NAME} → room ${room} ` +
        `(id=${d.id}, learnerId=${learnerId || '∅'}, ` +
        `ttsProvider=${ttsProvider || '∅'}, ttsVoice=${ttsVoice || '∅'}, ` +
        `legacy_tts=${tts || '∅'}, stt=${stt || '∅'}, mode=${mode || 'normal'})`,
    );
  } catch (err) {
    console.warn(`[token-server] dispatch failed for room ${room}:`, err);
  }

  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: identity,
    ttl: '1h',
  });

  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const jwt = await token.toJwt();
  res.json({ token: jwt, url: LIVEKIT_URL, room });
});

app.get('/api/livekit-url', (_req, res) => {
  res.json({ url: LIVEKIT_URL });
});

// ── Dictionary / translation proxy ───────────────────────────────────
//
// Powers the hover-to-translate feature on tutor bubbles. Server-side so:
//   1. We can swap providers later without touching the client.
//   2. Popular words can be cached in-memory across browsers.
//   3. No third-party rate-limit headers leak to the browser.
//
// Defaults are zero-config (MyMemory + Wiktionary + Tatoeba — all keyless).
// Adding DEEPL_API_KEY=… upgrades translation quality silently.

type CacheEntry<T> = { value: T; expires: number };
const dictCache = new Map<string, CacheEntry<unknown>>();
const DICT_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function cacheGet<T>(key: string): T | undefined {
  const hit = dictCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    dictCache.delete(key);
    return undefined;
  }
  // Move to the back of the Map's insertion order so eviction (which walks
  // keys oldest-first) drops cold entries before hot ones — real LRU, not FIFO.
  dictCache.delete(key);
  dictCache.set(key, hit);
  return hit.value as T;
}
function cacheSet<T>(key: string, value: T): void {
  if (dictCache.size > 5000) {
    // LRU eviction — drop the least-recently-used half when we hit the cap.
    // cacheGet re-inserts on hit, so the oldest keys here are the coldest.
    const drop = Math.floor(dictCache.size / 2);
    let i = 0;
    for (const k of dictCache.keys()) {
      dictCache.delete(k);
      if (++i >= drop) break;
    }
  }
  dictCache.set(key, { value, expires: Date.now() + DICT_CACHE_TTL_MS });
}

function normalizeWord(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/^[¿¡"'`(\[{.,!?;:]+|[.,!?;:"'`)\]}]+$/g, '')
    .trim()
    .toLowerCase();
}

async function translateViaDeepL(
  q: string,
  context: string,
): Promise<string | null> {
  const key = process.env.DEEPL_API_KEY;
  if (!key) return null;
  // DeepL Free uses api-free.deepl.com; Pro uses api.deepl.com. Free keys
  // end with `:fx` per their docs.
  const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const params = new URLSearchParams({
    text: q,
    source_lang: 'ES',
    target_lang: 'EN',
    ...(context ? { context } : {}),
  });
  const resp = await fetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(2500),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { translations?: Array<{ text?: string }> };
  return data.translations?.[0]?.text ?? null;
}

async function translateViaMyMemory(q: string): Promise<string | null> {
  const url =
    'https://api.mymemory.translated.net/get?' +
    new URLSearchParams({ q, langpair: 'es|en' }).toString();
  const resp = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    responseStatus?: number | string;
    responseData?: { translatedText?: string };
  };
  // MyMemory surfaces quota/validation failures as HTTP 200 with an uppercase
  // warning string in translatedText (e.g. "MYMEMORY WARNING: YOU USED ALL
  // AVAILABLE FREE TRANSLATIONS FOR TODAY"). Reject anything that isn't a
  // documented 200 so the caller falls back instead of caching the error.
  if (Number(data.responseStatus) !== 200) return null;
  return data.responseData?.translatedText ?? null;
}

app.get('/api/dict/translate', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').slice(0, 200);
  const context = String(req.query.context ?? '').slice(0, 500);
  if (!q.trim()) {
    res.status(400).json({ error: 'q is required' });
    return;
  }
  // Key off the full (already 500-capped) context — that's what DeepL sees for
  // word-sense disambiguation, so truncating here would collide two requests
  // that share a prefix but translate differently.
  const cacheKey = `tr:${q.toLowerCase()}::${context.toLowerCase()}`;
  const cached = cacheGet<{ translation: string; provider: string }>(cacheKey);
  if (cached) {
    res.json({ ...cached, cached: true });
    return;
  }
  try {
    let translation = await translateViaDeepL(q, context);
    let provider = 'deepl';
    if (!translation) {
      translation = await translateViaMyMemory(q);
      provider = 'mymemory';
    }
    if (!translation) {
      res.status(502).json({ error: 'translation provider returned nothing' });
      return;
    }
    const payload = { translation, provider };
    cacheSet(cacheKey, payload);
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.warn('[token-server] /api/dict/translate failed:', err);
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Pull Spanish-section definitions + examples from the English Wiktionary REST
// `definition` endpoint. The response is keyed by ISO 639-1 language codes
// ('es', 'en', …), not language names. Returns parsed HTML — we strip tags but
// keep ordering so the UI can show "noun: …, verb: …". Definitions only; no
// conjugation parsing.
interface WiktionarySense {
  partOfSpeech: string;
  language: string;
  definitions: Array<{ definition?: string; examples?: string[] }>;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // &amp; must decode LAST so double-encoded entities (&amp;lt;) survive as
    // their intended literal (&lt;) instead of collapsing an extra level.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWiktionarySenses(
  word: string,
): Promise<Array<{ partOfSpeech: string; definitions: string[]; examples: string[] }>> {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'AISpeaker-Habla/0.1' },
    signal: AbortSignal.timeout(2500),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as Record<string, WiktionarySense[]>;
  const es = data['es'] || [];
  return es.map((s) => ({
    partOfSpeech: s.partOfSpeech || 'other',
    definitions: (s.definitions || [])
      .map((d) => stripHtml(d.definition ?? ''))
      .filter(Boolean)
      .slice(0, 4),
    examples: (s.definitions || [])
      .flatMap((d) => (d.examples || []).map((e) => stripHtml(e)))
      .filter(Boolean)
      .slice(0, 3),
  }));
}

async function fetchTatoebaExamples(
  word: string,
): Promise<Array<{ es: string; en: string }>> {
  const url =
    'https://tatoeba.org/eng/api_v0/search?' +
    new URLSearchParams({
      from: 'spa',
      to: 'eng',
      query: word,
      orphans: 'no',
      unapproved: 'no',
      sort: 'relevance',
    }).toString();
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AISpeaker-Habla/0.1' },
    signal: AbortSignal.timeout(2500),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as {
    results?: Array<{ text?: string; translations?: Array<Array<{ text?: string; lang?: string }>> }>;
  };
  const out: Array<{ es: string; en: string }> = [];
  for (const r of (data.results || []).slice(0, 8)) {
    const es = r.text;
    const enTranslation = (r.translations || [])
      .flat()
      .find((t) => t.lang === 'eng' && t.text);
    if (es && enTranslation?.text) {
      out.push({ es, en: enTranslation.text });
      if (out.length >= 3) break;
    }
  }
  return out;
}

app.get('/api/dict/lookup', async (req: Request, res: Response) => {
  const raw = String(req.query.word ?? '').slice(0, 80);
  const word = normalizeWord(raw);
  if (!word) {
    res.status(400).json({ error: 'word is required' });
    return;
  }
  const cacheKey = `look:${word}`;
  const cached = cacheGet<unknown>(cacheKey);
  if (cached) {
    res.json({ ...(cached as object), cached: true });
    return;
  }
  try {
    const [senses, examples] = await Promise.all([
      fetchWiktionarySenses(word).catch(() => []),
      fetchTatoebaExamples(word).catch(() => []),
    ]);
    const payload = { word, senses, examples };
    cacheSet(cacheKey, payload);
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.warn('[token-server] /api/dict/lookup failed:', err);
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dev-only endpoint. Joins the named room as a service participant, performs
// the dev_inject_turn RPC on the Sofía agent, and disconnects. Gated by
// HABLA_DEV_INJECT=1 so prod servers refuse it. Used by the Playwright visual
// harness — the browser is already in the room as the learner, this is the
// "we typed for the learner" channel that skips the microphone entirely.
if (process.env.HABLA_DEV_INJECT === '1') {
  app.use(express.json({ limit: '8mb' })); // larger limit for inline WAV uploads
  app.post('/api/dev/inject-turn', async (req: Request, res: Response) => {
    const body = req.body as {
      roomName?: string;
      text?: string;
      recordingPath?: string; // absolute or repo-relative .wav path
      audioWavBase64?: string;
    };
    if (!body?.roomName || !body?.text) {
      return res.status(400).json({ ok: false, error: 'roomName and text are required' });
    }

    let recordingPathAbs: string | undefined;
    if (body.recordingPath) {
      const repoRoot = resolvePath(__dirname, '..');
      recordingPathAbs = isAbsolute(body.recordingPath)
        ? body.recordingPath
        : resolvePath(repoRoot, body.recordingPath);
      if (!existsSync(recordingPathAbs)) {
        return res
          .status(404)
          .json({ ok: false, error: `recording not found: ${recordingPathAbs}` });
      }
    }
    // RPC payload limit is ~15 KB so we never inline more than a tiny clip.
    const audioWavBase64 =
      !recordingPathAbs && body.audioWavBase64 && body.audioWavBase64.length < 10_000
        ? body.audioWavBase64
        : undefined;

    // Build a service-token with the right RPC grants and join the room as
    // a non-publishing participant. We never publish a track — this is just
    // a channel to invoke the agent's dev RPC.
    const injectorId = `dev-injector-${Math.random().toString(36).slice(2, 8)}`;
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: injectorId,
      name: 'dev-injector',
      ttl: '5m',
    });
    token.addGrant({
      roomJoin: true,
      room: body.roomName,
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
    });
    const jwt = await token.toJwt();

    const room = new Room();
    let agentIdentity: string | null = null;
    room.on(RoomEvent.ParticipantConnected, (p) => {
      if (p.attributes?.['lk.agent.state']) {
        agentIdentity = p.identity;
      }
    });

    try {
      await room.connect(LIVEKIT_URL, jwt);
      // Existing participants are already on the room; scan once after connect.
      for (const [, p] of room.remoteParticipants) {
        if (p.attributes?.['lk.agent.state']) {
          agentIdentity = p.identity;
          break;
        }
      }
      // Wait briefly for the agent to surface if it hasn't yet.
      const deadline = Date.now() + 8_000;
      while (!agentIdentity && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!agentIdentity) {
        await room.disconnect();
        return res
          .status(503)
          .json({ ok: false, error: 'agent not present in room within 8s' });
      }

      const rpcPayload = JSON.stringify({
        text: body.text,
        recordingPathAbs,
        audioWavBase64,
      });
      const rpcResp = await room.localParticipant!.performRpc({
        destinationIdentity: agentIdentity,
        method: 'dev_inject_turn',
        payload: rpcPayload,
        responseTimeout: 20_000,
      });
      await room.disconnect();
      const parsed = JSON.parse(rpcResp);
      return res.json({ ok: parsed.ok !== false, agent: parsed, agentIdentity });
    } catch (err) {
      try {
        await room.disconnect();
      } catch {
        /* swallow */
      }
      return res
        .status(500)
        .json({ ok: false, error: String(err).slice(0, 400) });
    }
  });
  console.log('[token-server] /api/dev/inject-turn enabled (HABLA_DEV_INJECT=1)');
}

// Exposes the live-system pieces the agent has wired up. Read at the time of
// the request; doesn't depend on a session being active.
app.get('/api/debug/config', (_req, res) => {
  // Resolve the server-side default TTS string from env so the dashboard can
  // tell the user what the agent will use when no per-session override is sent.
  const envProvider = (process.env.TTS_PROVIDER || 'cartesia').toLowerCase();
  let ttsLabel = 'cartesia sonic-3 (es)';
  if (envProvider === 'openai') {
    ttsLabel = `openai gpt-4o-mini-tts (voice=${process.env.OPENAI_TTS_VOICE || 'shimmer'})`;
  } else if (envProvider === 'google') {
    ttsLabel = `google gemini-2.5-flash-tts (voice=${process.env.GEMINI_TTS_VOICE || 'Aoede'})`;
  } else if (envProvider === 'google-flash' || envProvider === 'google-pro') {
    ttsLabel = `google ${envProvider === 'google-pro' ? 'gemini-2.5-pro-tts' : 'gemini-2.5-flash-tts'} (voice=${process.env.GEMINI_TTS_VOICE || 'Aoede'})`;
  } else if (envProvider === 'inworld') {
    ttsLabel = `inworld ${process.env.INWORLD_TTS_MODEL || 'inworld-tts-2'} (voice=${process.env.INWORLD_VOICE || 'Ashley'})`;
  }

  res.json({
    livekit: {
      url: LIVEKIT_URL,
      agent_name: SOFIA_AGENT_NAME,
    },
    pipeline: {
      stt: 'deepgram nova-3 (multi)',
      llm: 'openai gpt-4o',
      tts: ttsLabel,
      vad: 'silero',
      pronunciation:
        process.env.SPEECHACE_API_KEY
          ? 'speechace'
          : process.env.AZURE_SPEECH_KEY
            ? 'azure cognitive services'
            : 'segmented (local)',
      compaction_llm: 'anthropic claude (sonnet)',
      scheduler: 'ts-fsrs',
    },
    // Surfaced to the web app's Settings drawer so the voice picker can
    // render provider→voice dropdowns without hardcoding the list twice.
    tts: {
      catalog: TTS_CATALOG,
      server_default_provider: envProvider,
    },
    db: {
      url_masked: maskUrl(process.env.DATABASE_URL || ''),
    },
    env: {
      record_turns: process.env.RECORD_TURNS === '1',
      learner_override: !!process.env.LEARNER_ID,
    },
  });
});

function maskUrl(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return raw.replace(/:[^:@/]*@/, ':***@');
  }
}

// ── Static frontend (production) ─────────────────────────────────────

// In dev, Vite serves the frontend on :5173 and proxies /api to us. In prod
// (after `npm run build` inside web/), Vite emits to web/dist and we serve
// it. Falling back to web/ raw also works for the old vanilla HTML, but
// since we removed it the dist path is the only useful one.
const webDist = join(__dirname, '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback — wouter handles routing client-side, so any unmatched GET
  // that's NOT under /api should return the React shell.
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Token server running on http://localhost:${PORT}`);
  console.log(`LiveKit URL: ${LIVEKIT_URL}`);
  if (existsSync(webDist)) {
    console.log(`Serving built frontend from ${webDist}`);
  } else {
    console.log(`No web/dist found — start Vite separately on :5173 for dev`);
  }
});

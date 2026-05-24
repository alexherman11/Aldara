import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createLearnerWithProfile,
  getLearner,
  getLearnerDebugState,
  patchLearnerProfile,
  type LearnerProfile,
} from './db/index.js';

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
  // Voice/TTS provider picked in the web app's Debug-tab selector. Rides
  // along in dispatch metadata so the agent's createTts() honors it.
  const tts = (req.query.tts as string) || '';

  // Fire the dispatch BEFORE returning the token so by the time the browser
  // connects, LiveKit already has a pending dispatch waiting for this room.
  // Failure here doesn't block token issuance — surface a warning instead so
  // a misconfigured dispatch doesn't make the page un-loadable.
  try {
    const meta: Record<string, string> = {};
    if (learnerId) meta.learnerId = learnerId;
    if (tts) meta.tts = tts;
    const metadata = Object.keys(meta).length ? JSON.stringify(meta) : '';
    const d = await dispatchClient.createDispatch(room, SOFIA_AGENT_NAME, {
      metadata,
    });
    console.log(
      `[token-server] dispatched ${SOFIA_AGENT_NAME} → room ${room} (id=${d.id}, learnerId=${learnerId || '∅'}, tts=${tts || '∅'})`,
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

// Exposes the live-system pieces the agent has wired up. Read at the time of
// the request; doesn't depend on a session being active.
app.get('/api/debug/config', (_req, res) => {
  res.json({
    livekit: {
      url: LIVEKIT_URL,
      agent_name: SOFIA_AGENT_NAME,
    },
    pipeline: {
      stt: 'deepgram nova-3 (multi)',
      llm: 'openai gpt-4o',
      tts:
        (process.env.TTS_PROVIDER || 'cartesia').toLowerCase() === 'openai'
          ? `openai gpt-4o-mini-tts (voice=${process.env.OPENAI_TTS_VOICE || 'shimmer'})`
          : 'cartesia sonic-3 (es)',
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

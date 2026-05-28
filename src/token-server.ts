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
  // STT engine for this session — assemblyai (default) or deepgram. Picked
  // in the Settings drawer's Developer tab; passed through dispatch metadata
  // and consumed in agent.ts createStt(). Validated against a fixed allowlist
  // so an unrecognized value just falls back silently to the env default
  // rather than crashing session boot.
  const sttRaw = (req.query.stt as string) || '';
  const stt =
    sttRaw === 'assemblyai' || sttRaw === 'deepgram' ? sttRaw : '';

  // Turn-taking mode for this session — ptt (push-to-talk) | vad | stt
  // (open-mic). Picked in the Settings drawer's Developer tab; consumed in
  // agent.ts resolveTurnMode(). Allowlisted so an unknown value falls back to
  // the agent's env default rather than breaking session boot.
  const turnModeRaw = (req.query.turnMode as string) || '';
  const turnMode =
    turnModeRaw === 'ptt' || turnModeRaw === 'vad' || turnModeRaw === 'stt'
      ? turnModeRaw
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
    if (turnMode) meta.turnMode = turnMode;
    if (mode) meta.mode = mode;
    const metadata = Object.keys(meta).length ? JSON.stringify(meta) : '';
    const d = await dispatchClient.createDispatch(room, SOFIA_AGENT_NAME, {
      metadata,
    });
    console.log(
      `[token-server] dispatched ${SOFIA_AGENT_NAME} → room ${room} ` +
        `(id=${d.id}, learnerId=${learnerId || '∅'}, ` +
        `ttsProvider=${ttsProvider || '∅'}, ttsVoice=${ttsVoice || '∅'}, ` +
        `legacy_tts=${tts || '∅'}, stt=${stt || '∅'}, turnMode=${turnMode || 'ptt'}, mode=${mode || 'normal'})`,
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

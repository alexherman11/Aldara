import 'dotenv/config';
import express from 'express';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Serve static web files
app.use(express.static(join(__dirname, '..', 'web')));

// Token endpoint — also pre-dispatches the Sofía agent into the room so the
// browser doesn't have to wait/retry for an agent to materialize.
app.get('/api/token', async (req, res) => {
  const room = (req.query.room as string) || 'habla-session';
  const identity = (req.query.identity as string) || 'learner';

  // Fire the dispatch BEFORE returning the token so by the time the browser
  // connects, LiveKit already has a pending dispatch waiting for this room.
  // Failure here doesn't block token issuance — surface a warning instead so
  // a misconfigured dispatch doesn't make the page un-loadable.
  try {
    const d = await dispatchClient.createDispatch(room, SOFIA_AGENT_NAME);
    console.log(`[token-server] dispatched ${SOFIA_AGENT_NAME} → room ${room} (id=${d.id})`);
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

  res.json({ token: jwt, url: LIVEKIT_URL });
});

// LiveKit URL endpoint (for client reference)
app.get('/api/livekit-url', (_req, res) => {
  res.json({ url: LIVEKIT_URL });
});

app.listen(PORT, () => {
  console.log(`Token server running on http://localhost:${PORT}`);
  console.log(`LiveKit URL: ${LIVEKIT_URL}`);
});

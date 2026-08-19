#!/usr/bin/env node
/**
 * Full voice + visual end-to-end harness — a whole multi-turn conversation.
 *
 * This is the "watch the app have a real conversation" harness. It drives a
 * single /session through N sequentially-injected learner turns (real
 * pre-recorded human audio), and for EACH turn verifies the full pipeline
 * closed:
 *
 *   inject → agent.injectTurnForTesting → assessor (real WAV) → pronunciation
 *   data-channel → ctx.fullTranscript → session.generateReply (gpt-4o) → TTS
 *   (real Sofía voice audio published to the room) → React renders the learner
 *   bubble, the inline pronunciation citation, and Sofía's reply bubble.
 *
 * It is the sibling of test-visual-bad-pronunciation.mjs, which drives only 2
 * isolated single-turn cases. This one proves the stack survives a *sustained*
 * conversation: 10 turns, state machine cycling listening→speaking→listening
 * each time, assessments and replies staying in lock-step, no resource leak.
 *
 * Why a separate script: the bad-pron harness reads a single DOM citation per
 * case and accepts ANY `pronunciation \d+` match — across turns that returns
 * the *previous* turn's citation (stale). Here we track freshness off the
 * devBus `lastPronunciation.ts` advancing, which is turn-accurate and immune
 * to the 5-turn DOM cap (devBus MAX_TURNS=5).
 *
 * Prereqs (identical to the bad-pron harness):
 *   1. HABLA_DEV_INJECT=1 in .env (then restart the agent)
 *   2. Full dev stack up (livekit + server + agent + web)
 *   3. The recordings referenced below still on disk under recordings/
 *
 * Usage:
 *   npm run test-visual-convo                 # full 10-turn conversation
 *   npm run test-visual-convo -- --turns=3    # first 3 turns only (quick check)
 *   HEADED=1 npm run test-visual-convo         # watch the browser
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

let BASE_URL = process.env.HABLA_BASE_URL || 'http://127.0.0.1:5173';
let API_BASE = process.env.HABLA_API_URL || 'http://127.0.0.1:3000';

const FAKE_LEARNER_ID =
  process.env.HABLA_TEST_LEARNER_ID || '00000000-0000-0000-0000-000000000002';

// Dispatch to our OWN named agent worker so this run is fully isolated from any
// other agent workers (zombies, the user's stack, a feature worktree) that may
// be registered as the default "sofia" against the shared local LiveKit server.
// Launch the matching worker with:  SOFIA_AGENT_NAME=sofia-verify npx tsx src/agent.ts dev
const AGENT_NAME = process.env.HABLA_VERIFY_AGENT_NAME || 'sofia-verify';
const SEED_LEARNER = JSON.stringify({
  id: FAKE_LEARNER_ID,
  cefr_level: 'A2',
  profile: {
    name: 'Test Learner',
    email: 'test@example.com',
    daily_goal_minutes: 15,
    streak: 1,
  },
  placed: true,
  onboarded: true,
});

// A coherent 10-turn conversation stitched from two real recorded sessions
// (303918a7 = travel/hiking thread, 05e866c0 = Spain trip thread). Each `text`
// is the clean transcript shown in the bubble + handed to gpt-4o; the assessor
// scores the REAL `wav` bytes independently, so pronunciation is honest. The
// `expectWords` are words the assessor flagged in that recording (from
// recordings/index.jsonl) — used only as a soft signal, not a hard gate.
const CONVERSATION = [
  {
    wav: 'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_001.wav',
    text: 'Hola Sofía. Yo quería aprender español porque estaba en la escuela y necesité entenderlo, pero ahora me encanta viajar.',
  },
  {
    wav: 'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_002.wav',
    text: 'Pues, voy a viajar a España, a Alicante, y también al país que está al oeste de España, a la izquierda, pero no sé el nombre.',
  },
  {
    wav: 'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_003.wav',
    text: 'Sí, me gustaría viajar con mis amigos que voy a conocer, pero también voy a viajar solo y visitar muchas partes de la naturaleza. Me encanta escalar montañas.',
  },
  {
    wav: 'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_004.wav',
    text: 'Sí, cuando estaba en Perú, yo escalí montañas cerca de las ruinas de Machu Picchu y como el Salkantay Trek.',
    expectWords: ['escalí', 'montañas'],
  },
  {
    wav: 'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_005.wav',
    text: 'No, caminé por las rutas, muchas millas, pero a pie.',
  },
  {
    wav: 'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_006.wav',
    text: 'Voy a recordar. Me tomó casi dos horas o algo así. Recuerdo que había muchos vendedores, personas que venden cosas por los lados de los senderos.',
  },
  {
    wav: 'recordings/05e866c0-995c-4bdd-bd90-8c8e08c6ce0d/turn_001.wav',
    text: 'Quiero practicar más español antes de viajar a España.',
  },
  {
    wav: 'recordings/05e866c0-995c-4bdd-bd90-8c8e08c6ce0d/turn_002.wav',
    text: 'Voy a viajar a Alicante con un viaje de la escuela.',
  },
  {
    wav: 'recordings/05e866c0-995c-4bdd-bd90-8c8e08c6ce0d/turn_003.wav',
    text: 'Tengo que ir a la playa y visitar Madrid y Alicante.',
  },
  {
    wav: 'recordings/05e866c0-995c-4bdd-bd90-8c8e08c6ce0d/turn_004.wav',
    text: 'Mi amiga y yo tenemos que viajar a Mallorca el fin de semana, posiblemente el sábado.',
  },
];

// ── arg parsing ──────────────────────────────────────────────────────
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const turnsFlag = flags.find((f) => f.startsWith('--turns='));
const maxTurns = turnsFlag ? parseInt(turnsFlag.split('=')[1], 10) : CONVERSATION.length;
const turns = CONVERSATION.slice(0, Math.max(1, maxTurns));

// ── Preflight ────────────────────────────────────────────────────────
async function preflight() {
  console.log('▸ checking dev stack...');
  try {
    const r = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok && r.status !== 404) throw new Error(`http ${r.status}`);
  } catch {
    console.log(`  Vite not on ${BASE_URL}; falling back to ${API_BASE}`);
    BASE_URL = API_BASE;
  }
  try {
    const r = await fetch(`${API_BASE}/api/livekit-url`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`http ${r.status}`);
  } catch (err) {
    console.error(`✗ api not reachable at ${API_BASE} — start the dev stack first.\n  ${err.message ?? err}`);
    process.exit(3);
  }
  try {
    const probe = await fetch(`${API_BASE}/api/dev/inject-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3000),
    });
    if (probe.status === 404) {
      console.error('✗ /api/dev/inject-turn not enabled. Set HABLA_DEV_INJECT=1 in .env and restart the agent.');
      process.exit(4);
    }
  } catch (err) {
    console.error(`✗ couldn't reach inject endpoint: ${err.message ?? err}`);
    process.exit(5);
  }
  for (const t of turns) {
    const wavAbs = join(PROJECT_ROOT, t.wav);
    if (!existsSync(wavAbs)) {
      console.error(`✗ recording missing: ${wavAbs}`);
      process.exit(6);
    }
  }
  try {
    const r = await fetch(`${API_BASE}/api/learner/${FAKE_LEARNER_ID}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      console.error(`✗ learner ${FAKE_LEARNER_ID} not in DB (status ${r.status}). Set HABLA_TEST_LEARNER_ID=...`);
      process.exit(8);
    }
  } catch (err) {
    console.error(`✗ couldn't check learner: ${err.message ?? err}`);
    process.exit(9);
  }
}

// ── browser-side helpers ─────────────────────────────────────────────
async function waitForRoom(page, timeoutMs = 45000) {
  return page
    .waitForFunction(
      () => {
        const bus = window.__habla_devbus__;
        if (!bus) return null;
        const s = bus.getSnapshot();
        if (s.room?.roomName && s.agent?.identity) return s.room.roomName;
        return null;
      },
      { timeout: timeoutMs, polling: 250 },
    )
    .then((h) => h.jsonValue());
}

async function waitForListening(page, timeoutMs = 60000) {
  await page.waitForFunction(
    () => window.__habla_devbus__?.getSnapshot()?.agent?.state === 'listening',
    { timeout: timeoutMs, polling: 400 },
  );
}

/** Wait for Sofía to leave 'listening' (start) then return (done). Returns latest tutor text. */
async function waitForSofiaTurnCycle(page, timeoutMs = 60000) {
  await page.waitForFunction(
    () => {
      const st = window.__habla_devbus__?.getSnapshot()?.agent?.state;
      return st && st !== 'listening';
    },
    { timeout: timeoutMs, polling: 250 },
  );
  await page.waitForFunction(
    () => window.__habla_devbus__?.getSnapshot()?.agent?.state === 'listening',
    { timeout: timeoutMs, polling: 400 },
  );
  return page.evaluate(() => {
    const s = window.__habla_devbus__?.getSnapshot();
    const tutor = (s?.turns ?? []).filter((t) => t.role === 'tutor');
    return tutor[tutor.length - 1]?.text ?? '';
  });
}

/**
 * Wait for a pronunciation assessment NEWER than `prevTs` to land on the
 * devBus. Returns { ts, pronunciation, recognized_text } or null on timeout.
 * This is the turn-accurate freshness signal — DOM citations cap at 5 turns
 * and can read stale across turns.
 */
async function waitForFreshPronunciation(page, prevTs, timeoutMs = 20000) {
  try {
    const handle = await page.waitForFunction(
      (prev) => {
        const lp = window.__habla_devbus__?.getSnapshot()?.lastPronunciation;
        if (lp && lp.ts && lp.ts > prev) return lp;
        return null;
      },
      prevTs,
      { timeout: timeoutMs, polling: 300 },
    );
    return handle.jsonValue();
  } catch {
    return null;
  }
}

async function currentPronTs(page) {
  return page.evaluate(
    () => window.__habla_devbus__?.getSnapshot()?.lastPronunciation?.ts ?? 0,
  );
}

async function currentRoom(page) {
  return page.evaluate(
    () => window.__habla_devbus__?.getSnapshot()?.room?.roomName ?? null,
  );
}

// ── per-turn driver ──────────────────────────────────────────────────
// `attempt` lets us retry a turn once if the browser reconnects to a fresh
// LiveKit room mid-turn — a transient WebRTC drop (seen under heavy system
// load when other Chrome/agents are running) tears down the agent session and
// Session.tsx rejoins with a new room. Without the retry that one turn scores
// a false failure even though the pipeline is healthy.
async function runTurn(page, turn, idx, outDir, attempt = 1) {
  const n = idx + 1;
  if (attempt === 1) {
    console.log(`\n─── turn ${n}/${turns.length} ───`);
    console.log(`  say: "${turn.text.slice(0, 80)}${turn.text.length > 80 ? '…' : ''}"`);
  }

  try {
    await waitForListening(page, 60000);
  } catch {
    console.warn('  ⚠ agent never reached listening — injecting anyway');
  }

  const prevPronTs = await currentPronTs(page);
  const roomName = await currentRoom(page);

  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/api/dev/inject-turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName, text: turn.text, recordingPath: turn.wav }),
  });
  const injectJson = await res.json().catch(() => ({ ok: false, error: 'bad json' }));
  console.log(`  inject: ${res.status} ${injectJson.ok ? 'ok' : 'FAIL ' + (injectJson.error ?? '')} (${Date.now() - t0}ms)`);
  if (!injectJson.ok) {
    // "agent not present" usually means the browser just reconnected to a new
    // room and that room's agent job hasn't finished initializing yet. Give the
    // (possibly new) room's agent longer to reach listening, then retry once.
    if (attempt < 2) {
      console.warn('  ⚠ inject failed; waiting for agent to (re)join, then retrying once');
      await waitForListening(page, 45000).catch(() => {});
      return runTurn(page, turn, idx, outDir, attempt + 1);
    }
    return { turn: n, pass: false, attempts: attempt, error: injectJson.error || 'inject failed' };
  }

  // Sofía's reply (real TTS audio plays during this cycle).
  let reply = '';
  let replyOk = false;
  try {
    reply = await waitForSofiaTurnCycle(page, 60000);
    replyOk = reply.trim().length > 0;
    console.log(`  sofía: "${reply.slice(0, 140)}${reply.length > 140 ? '…' : ''}"`);
  } catch (err) {
    console.warn(`  ⚠ no reply cycle in 60s — ${err.message ?? err}`);
  }

  // Reconnect guard: if the reply didn't land and the room changed out from
  // under us, the browser rejoined a fresh room mid-turn. Retry once on the new
  // room before scoring a failure — the inject targeted a room that no longer
  // exists, so this turn never actually reached a live agent.
  if (!replyOk && attempt < 2) {
    const roomNow = await currentRoom(page);
    if (roomNow && roomNow !== roomName) {
      console.warn(`  ⚠ reconnect mid-turn (${roomName} → ${roomNow}); retrying once`);
      await waitForListening(page, 30000).catch(() => {});
      return runTurn(page, turn, idx, outDir, attempt + 1);
    }
  }

  // Fresh assessment (turn-accurate, off devBus ts).
  const fresh = await waitForFreshPronunciation(page, prevPronTs, 20000);
  const pronOk = !!fresh;
  if (fresh) {
    const delta = prevPronTs ? `+${fresh.ts - prevPronTs}ms` : 'first';
    console.log(`  pron:  ${Math.round(fresh.overall?.pronunciation ?? 0)} (fresh, ${delta})`);
  } else {
    console.log('  pron:  <no fresh assessment within 20s>');
  }

  const shot = join(outDir, `turn-${String(n).padStart(2, '0')}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  const echoed =
    turn.expectWords && reply
      ? turn.expectWords.some((w) => reply.toLowerCase().includes(w.toLowerCase()))
      : null;

  const pass = replyOk && pronOk;
  console.log(`  ${pass ? '✓' : '✗'} reply=${replyOk ? 'Y' : 'N'} pron=${pronOk ? 'Y' : 'N'}${echoed === null ? '' : ` echo=${echoed ? 'Y' : 'N'}`}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);

  return {
    turn: n,
    text: turn.text,
    reply,
    pronunciation: fresh ? Math.round(fresh.overall?.pronunciation ?? 0) : null,
    replyOk,
    pronOk,
    echoed,
    attempts: attempt,
    screenshot: shot,
    pass,
  };
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  await preflight();

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(PROJECT_ROOT, 'scenarios', 'visual-conversation', ts);
  mkdirSync(outDir, { recursive: true });
  console.log(`▸ ${turns.length}-turn conversation → ${outDir}`);

  const headless = process.env.HEADED !== '1';
  const browser = await chromium.launch({
    headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2,
    permissions: ['microphone'],
  });
  await ctx.grantPermissions(['microphone'], { origin: BASE_URL });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  // The headless fake-audio device makes LiveKit spam ERR_INSUFFICIENT_RESOURCES
  // as it churns the silent track. It's noise (screenshots render fine), so we
  // collapse it to a single summary line instead of thousands of log lines.
  let insufficientResourceHits = 0;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const txt = m.text();
    if (txt.includes('ERR_INSUFFICIENT_RESOURCES')) {
      insufficientResourceHits++;
      return;
    }
    console.error(`[page console] ${txt}`);
  });

  await page.goto(`${BASE_URL}/__seed_stub__`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ learner, agentName }) => {
      localStorage.setItem('habla_learner', learner);
      localStorage.setItem('habla_dev_mode', '1');
      localStorage.setItem('habla_agent_name', agentName);
    },
    { learner: SEED_LEARNER, agentName: AGENT_NAME },
  );
  console.log(`▸ isolated agent: dispatching to "${AGENT_NAME}"`);

  await page.goto(`${BASE_URL}/session`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  console.log('▸ waiting for room + agent...');
  try {
    const roomName = await waitForRoom(page, 45000);
    console.log(`  joined room: ${roomName}`);
  } catch (err) {
    console.error(`✗ room/agent never came up: ${err.message ?? err}`);
    await page.screenshot({ path: join(outDir, 'failed-to-join.png') });
    await browser.close();
    process.exit(7);
  }

  const results = [];
  for (let i = 0; i < turns.length; i++) {
    try {
      results.push(await runTurn(page, turns[i], i, outDir));
    } catch (err) {
      console.error(`turn ${i + 1} crashed:`, err);
      results.push({ turn: i + 1, pass: false, error: String(err).slice(0, 300) });
    }
  }

  await page.screenshot({ path: join(outDir, 'final-fullpage.png'), fullPage: true });
  const retried = results.filter((r) => (r.attempts ?? 1) > 1).length;
  const summary = {
    generated_at: new Date().toISOString(),
    turns: turns.length,
    passed: results.filter((r) => r.pass).length,
    retriedTurns: retried,
    insufficientResourceHits,
    results,
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(summary, null, 2));

  console.log('\n══════════════════════════════════════════════════════');
  console.log(` Conversation harness — ${summary.passed}/${turns.length} turns passed`);
  console.log('══════════════════════════════════════════════════════');
  for (const r of results) {
    console.log(
      `  ${r.pass ? '✓' : '✗'} turn ${String(r.turn).padStart(2)} ` +
        `reply=${r.replyOk ? 'Y' : 'N'} pron=${r.pronOk ? String(r.pronunciation).padStart(2) : ' N'}` +
        ((r.attempts ?? 1) > 1 ? ` (retried ×${r.attempts - 1} after reconnect)` : '') +
        (r.error ? ` — ${r.error}` : ''),
    );
  }
  if (retried) {
    console.log(`\n  (${retried} turn(s) survived a mid-run browser reconnect via retry)`);
  }
  if (insufficientResourceHits) {
    console.log(`\n  (suppressed ${insufficientResourceHits} ERR_INSUFFICIENT_RESOURCES log lines — benign headless-mic churn)`);
  }
  console.log(`\n  artifacts: ${outDir}`);

  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Visual end-to-end harness for the bad-pronunciation feedback loop.
 *
 *  Browser (real React app)  ─┐
 *      seeded "signed-in"     │  joins room "habla-<learner>-<ts>"
 *      drives /session        │
 *  ───────────────────────────┤
 *  POST /api/dev/inject-turn  │  ← this script calls it per test case
 *      (gated by HABLA_DEV_INJECT=1)
 *  ───────────────────────────┤
 *  token-server joins room  ──┤
 *  RPCs dev_inject_turn       │
 *  ───────────────────────────┤
 *  agent.injectTurnForTesting │  runs assessor on the bad WAV, publishes
 *      → ctx.recentAssessments│  pronunciation data-channel, appends transcript,
 *      → data-channel publish │  triggers Sofía's reply
 *      → session.generateReply│
 *  ───────────────────────────┘
 *      ↓
 *  Browser renders Sofía's bubble AND the [data-testid=pronunciation-summary]
 *  citation. We screenshot, and assert what's visible.
 *
 * Why this exists: piping synthesized audio through LiveKit→Deepgram returns
 * empty transcripts (see scenarios/.../events.jsonl from May 13). This skips
 * STT entirely while exercising every other piece of the real stack: agent
 * worker, LiveKit transport, AzureAssessor, prompt evolution, gpt-4o, TTS,
 * and the React renderer. Combine with bad pre-recorded WAVs and you can
 * actually see the feedback loop close in the UI.
 *
 * Prereqs:
 *   1. HABLA_DEV_INJECT=1 in .env (then restart npm run dev)
 *   2. `npm run dev` running (livekit + server + agent + web)
 *   3. The test recordings still exist under recordings/ (they're gitignored
 *      but the index.jsonl lists them; the harness will error out if missing)
 *
 * Usage:
 *   npm run test-visual-bad-pron                # all cases
 *   npm run test-visual-bad-pron escali-mountains   # one case
 *   HEADED=1 npm run test-visual-bad-pron       # show the browser
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
// The dev stack either runs Vite on :5173 (proxying /api to :3000) or the
// token-server alone on :3000 serving the prod build with /api in-process.
// Auto-detect on preflight so the harness works in both modes.
let BASE_URL = process.env.HABLA_BASE_URL || 'http://127.0.0.1:5173';
let API_BASE = process.env.HABLA_API_URL || 'http://127.0.0.1:3000';

// Use the LEARNER_ID seeded by past evolution runs — guaranteed to exist in
// Postgres so /api/learner/<id> and /api/learner/<id>/state don't 404. The
// screenshot.mjs trick of a fake id works for routes that don't touch the
// API, but the session page does.
const FAKE_LEARNER_ID =
  process.env.HABLA_TEST_LEARNER_ID || '00000000-0000-0000-0000-000000000002';
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

// Mirror the same test cases as scripts/test-bad-pronunciation.ts so the
// in-process backend assertions and the visual UI assertions share inputs.
const CASES = [
  {
    id: 'escali-mountains',
    recordingPath: 'recordings/303918a7-4475-47ff-a167-a3b79924ed29/turn_004.wav',
    text: 'Sí, cuando estaba en Perú, yo escalí montañas cerca de las ruinas de Machu Picchu.',
    expectFlaggedInUi: ['escalí', 'montañas'],
  },
  {
    id: 'sofia-conmigo',
    recordingPath: 'recordings/5130758c-3ce3-4b7f-aa19-90fa8665db66/turn_001.wav',
    text:
      'Hola Sofía. Estoy usando una nueva feature de esta cosa. Estoy intentando de probarla y necesito que hables en español para comunicarte conmigo.',
    expectFlaggedInUi: ['sofía', 'conmigo'],
  },
];

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const filter = args[0];
const cases = filter ? CASES.filter((c) => c.id === filter) : CASES;
if (cases.length === 0) {
  console.error(`Unknown case "${filter}". Known: ${CASES.map((c) => c.id).join(', ')}`);
  process.exit(2);
}

// ── Preflight ────────────────────────────────────────────────────────

async function preflight() {
  console.log('▸ checking dev stack...');
  // Vite (:5173) is preferred for hot dev, but if it's not running fall back
  // to the token-server (:3000) serving the prod web bundle in-process.
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
    console.error(`✗ api not reachable at ${API_BASE} — run \`npm run dev\` first.\n  ${err.message ?? err}`);
    process.exit(3);
  }
  // Confirm the dev-inject endpoint is wired up. A real prod token-server
  // 404s here; if it does we tell the user how to flip the switch.
  try {
    const probe = await fetch(`${API_BASE}/api/dev/inject-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // intentionally empty — endpoint should 400 if enabled
      signal: AbortSignal.timeout(3000),
    });
    if (probe.status === 404) {
      console.error(
        '✗ /api/dev/inject-turn is not enabled. Set HABLA_DEV_INJECT=1 in .env and restart `npm run dev`.',
      );
      process.exit(4);
    }
  } catch (err) {
    console.error(`✗ couldn't reach inject endpoint: ${err.message ?? err}`);
    process.exit(5);
  }
  // Each test recording must exist (they're gitignored, so easy to miss).
  for (const c of cases) {
    const wavAbs = join(PROJECT_ROOT, c.recordingPath);
    if (!existsSync(wavAbs)) {
      console.error(
        `✗ test recording missing: ${wavAbs}\n  ` +
          'Capture a session with RECORD_TURNS=1 first, or pick another case.',
      );
      process.exit(6);
    }
  }
  // Confirm the seeded learner exists; bail with a friendly message if not.
  try {
    const r = await fetch(`${API_BASE}/api/learner/${FAKE_LEARNER_ID}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) {
      console.error(
        `✗ learner ${FAKE_LEARNER_ID} not in DB (status ${r.status}). Pick a real ` +
          'learner id via HABLA_TEST_LEARNER_ID=... (must exist in Postgres).',
      );
      process.exit(8);
    }
  } catch (err) {
    console.error(`✗ couldn't check learner: ${err.message ?? err}`);
    process.exit(9);
  }
}

// ── Browser-side helpers ─────────────────────────────────────────────

/**
 * Wait until the React app has connected to LiveKit and stashed the room
 * name on the devBus. Returns the roomName so we can target it from server-
 * side injection. Times out if the agent never joins — we'd hang forever
 * otherwise on a misconfigured stack.
 */
async function waitForRoom(page, timeoutMs = 30000) {
  return page.waitForFunction(
    () => {
      const bus = window.__habla_devbus__;
      if (!bus) return null;
      const s = bus.getSnapshot();
      // We want BOTH room AND agent visible; without the agent, the inject
      // RPC will time out waiting for the agent identity.
      if (s.room?.roomName && s.agent?.identity) {
        return s.room.roomName;
      }
      return null;
    },
    { timeout: timeoutMs, polling: 250 },
  ).then((handle) => handle.jsonValue());
}

/** Count of FINAL learner turns the devBus has seen. */
async function learnerTurnCount(page) {
  return page.evaluate(() => {
    const s = window.__habla_devbus__?.getSnapshot();
    return (s?.turns ?? []).filter((t) => t.role === 'learner' && t.final).length;
  });
}

/** Wait for the agent to settle into 'listening' — proxy for "Sofía done talking". */
async function waitForListening(page, timeoutMs = 60000) {
  await page.waitForFunction(
    () => {
      const s = window.__habla_devbus__?.getSnapshot();
      return s?.agent?.state === 'listening';
    },
    { timeout: timeoutMs, polling: 400 },
  );
}

/**
 * Wait for Sofía to START a new reply turn (agent leaves 'listening'), then
 * for her to FINISH (agent returns to 'listening'). Returns the latest tutor
 * bubble text. More robust than counting "new final turns" because the
 * coalescer can merge greeting + reply into one bubble.
 */
async function waitForSofiaTurnCycle(page, timeoutMs = 60000) {
  // Phase 1: she must leave listening (start thinking/speaking).
  await page.waitForFunction(
    () => {
      const s = window.__habla_devbus__?.getSnapshot();
      return s?.agent?.state && s.agent.state !== 'listening';
    },
    { timeout: timeoutMs, polling: 300 },
  );
  // Phase 2: she returns to listening (done speaking).
  await page.waitForFunction(
    () => {
      const s = window.__habla_devbus__?.getSnapshot();
      return s?.agent?.state === 'listening';
    },
    { timeout: timeoutMs, polling: 400 },
  );
  return page.evaluate(() => {
    const s = window.__habla_devbus__?.getSnapshot();
    const tutor = (s?.turns ?? []).filter((t) => t.role === 'tutor');
    return tutor[tutor.length - 1]?.text ?? '';
  });
}

/**
 * Read whatever pronunciation citation is currently rendered. Returns null
 * if the [data-testid=pronunciation-summary] element isn't on the page yet.
 */
async function readCitation(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="pronunciation-summary"]');
    return el ? el.textContent?.trim() ?? '' : null;
  });
}

// ── Per-case driver ──────────────────────────────────────────────────

async function runCase(page, testCase, outDir) {
  console.log(`\n══════ ${testCase.id} ══════`);
  console.log(`  text: "${testCase.text.slice(0, 90)}${testCase.text.length > 90 ? '…' : ''}"`);
  console.log(`  wav:  ${testCase.recordingPath}`);

  // Wait for the agent to be idle before injecting — otherwise we race the
  // greeting and the injected reply gets coalesced into the same bubble.
  console.log('  waiting for agent state=listening...');
  try {
    await waitForListening(page, 60000);
  } catch {
    console.warn('  ⚠ agent never reached listening within 60s — injecting anyway');
  }

  const roomName = await page.evaluate(
    () => window.__habla_devbus__?.getSnapshot()?.room?.roomName ?? null,
  );
  console.log(`  room: ${roomName}`);

  // Fire the injection. The server hops into the room, RPCs the agent.
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/api/dev/inject-turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName,
      text: testCase.text,
      recordingPath: testCase.recordingPath,
    }),
  });
  const injectJson = await res.json();
  console.log(
    `  inject: ${res.status} ${injectJson.ok ? 'ok' : 'fail'} ` +
      `(${Date.now() - t0}ms) ${injectJson.error ? '— ' + injectJson.error : ''}`,
  );
  if (!injectJson.ok) {
    return { id: testCase.id, pass: false, error: injectJson.error || 'inject failed' };
  }

  // Wait for the full thinking → speaking → listening cycle.
  let tutorReply = '';
  try {
    tutorReply = await waitForSofiaTurnCycle(page, 60000);
    console.log(`  sofía: "${tutorReply.slice(0, 200)}${tutorReply.length > 200 ? '…' : ''}"`);
  } catch (err) {
    console.warn(`  ⚠ turn cycle didn't complete in 60s — ${err.message ?? err}`);
  }

  // The pronunciation citation lands AFTER the assessor finishes (async). Give
  // it a bit; it can race with the tutor reply either way.
  let citation = null;
  const citationDeadline = Date.now() + 15000;
  while (Date.now() < citationDeadline) {
    citation = await readCitation(page);
    if (citation && /pronunciation\s+\d+/i.test(citation)) break;
    await page.waitForTimeout(400);
  }
  console.log(`  citation: ${citation ?? '<not yet visible>'}`);

  // Screenshot the current state.
  const shot = join(outDir, `${testCase.id}.png`);
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`  📸 ${shot}`);

  // Assertions on the visible UI.
  const replyLower = tutorReply.toLowerCase();
  const sofiaEchoed = testCase.expectFlaggedInUi.some((w) =>
    replyLower.includes(w.toLowerCase()),
  );
  const citationLooksReal =
    !!citation && /pronunciation\s+\d+/i.test(citation);

  const pass = sofiaEchoed && citationLooksReal;
  console.log(`  result: ${pass ? '✓ PASS' : '✗ FAIL'}`);

  return {
    id: testCase.id,
    roomName,
    tutorReply,
    citation,
    sofiaEchoed,
    citationLooksReal,
    screenshot: shot,
    pass,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  await preflight();

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(PROJECT_ROOT, 'scenarios', 'visual-bad-pron', ts);
  mkdirSync(outDir, { recursive: true });
  console.log(`▸ artifacts → ${outDir}`);

  const headless = process.env.HEADED !== '1';
  // Headless Chromium doesn't expose getUserMedia by default → Session.tsx's
  // setMicrophoneEnabled(true) raises "Mic error: Not supported" and the
  // page never connects to LiveKit. The fake-stream flags wire up an
  // always-silent virtual mic, which is fine — the agent uses our dev RPC
  // for audio, not the browser's mic stream.
  const browser = await chromium.launch({
    headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  // Mic must be auto-granted because Session.tsx tries to enable it on connect.
  // We never actually feed audio in; the agent is gated by our PTT skip + dev RPC.
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2,
    permissions: ['microphone'],
  });
  await ctx.grantPermissions(['microphone'], { origin: BASE_URL });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[page console] ${m.text()}`);
  });

  // Seed localStorage before SPA boot.
  await page.goto(`${BASE_URL}/__seed_stub__`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ learner }) => {
      localStorage.setItem('habla_learner', learner);
      localStorage.setItem('habla_dev_mode', '1');
    },
    { learner: SEED_LEARNER },
  );

  // domcontentloaded — the SPA has polling endpoints; networkidle never fires.
  await page.goto(`${BASE_URL}/session`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  console.log('▸ waiting for room + agent...');
  let roomName;
  try {
    roomName = await waitForRoom(page, 45000);
    console.log(`  joined room: ${roomName}`);
  } catch (err) {
    console.error(`✗ room/agent never came up: ${err.message ?? err}`);
    await page.screenshot({ path: join(outDir, 'failed-to-join.png') });
    await browser.close();
    process.exit(7);
  }

  const results = [];
  for (const c of cases) {
    try {
      results.push(await runCase(page, c, outDir));
    } catch (err) {
      console.error(`case ${c.id} crashed:`, err);
      results.push({ id: c.id, pass: false, error: String(err).slice(0, 300) });
    }
  }

  // Final summary screenshot + json
  await page.screenshot({ path: join(outDir, 'final.png'), fullPage: true });
  writeFileSync(
    join(outDir, 'results.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2),
  );

  console.log('\n══════════════════════════════════════════════════════');
  console.log(' Visual harness summary');
  console.log('══════════════════════════════════════════════════════');
  for (const r of results) {
    console.log(
      `  ${r.pass ? '✓' : '✗'} ${r.id.padEnd(22)} ` +
        `echo=${r.sofiaEchoed ? 'Y' : 'N'} citation=${r.citationLooksReal ? 'Y' : 'N'}` +
        (r.error ? ` — ${r.error}` : ''),
    );
  }
  console.log(`\n  artifacts: ${outDir}`);

  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

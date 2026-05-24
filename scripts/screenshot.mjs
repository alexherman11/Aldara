#!/usr/bin/env node
/**
 * Playwright-driven screenshot of the local web app for Claude Code agents.
 *
 * Usage:
 *   npm run screenshot -- --route=/session
 *   npm run screenshot -- --route=/session --seed=signed-in
 *   npm run screenshot -- --route=/session --seed=signed-in,dev-mode --selector="[data-testid=btn-menu]"
 *
 * Flags:
 *   --route=<path>         Route under http://127.0.0.1:5173 (default: /)
 *   --seed=<preset[,…]>    Comma list of state presets to apply via localStorage
 *                          before the SPA boots. See SEEDS below.
 *   --selector=<css>       Wait for this selector to be visible before capturing.
 *   --click=<css>          After load, click this selector before capturing. May be
 *                          passed multiple times (clicked in order, 300ms between each).
 *   --wait=<ms>            Extra wait after load (default: 600).
 *   --out=<path>           PNG output path. Defaults to .claude/screenshots/<ts>-<slug>.png.
 *   --full-page            Capture full scroll height. Default: viewport only.
 *   --viewport=<WxH>       Viewport size. Default: 412x892 (mobile portrait — matches the app).
 *   --base-url=<url>       Override the dev server URL. Default: auto-probe 5173..5180.
 *                          Useful when a worktree's vite landed on a non-default port.
 *   --inject-session       Stub a fake LiveKit session into window.__habla_devbus__
 *                          AFTER navigation, so the Developer-tab "Live Session" panel
 *                          renders its populated branch (room, agent, two turns) instead
 *                          of the empty-state placeholder. Required when verifying any
 *                          change inside the non-empty LiveSession render path — a real
 *                          headless capture can't join a LiveKit room.
 *
 * Exits non-zero with a helpful message if no dev server is reachable on the
 * probed ports. Does NOT start the dev stack — run `npm run dev` or
 * `npm run dev-stack -- up web` first.
 *
 * The output PNG path is printed as the LAST line of stdout so callers can grep it.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ── seed presets (localStorage entries applied before page boot) ────────
// Keep these in sync with web/src/lib/api.ts + dev-bus.ts storage keys.
//
// Use the REAL seeded learner id (matches test-visual-bad-pronunciation.mjs and
// the post-`test-evolution` Postgres seed). A fake id like ...aaa would 404 on
// /api/learner/<id>, which spams the console and breaks routes that hit /api
// (notably /session, /home). Override via HABLA_TEST_LEARNER_ID env if you
// want a different fixture.
const REAL_LEARNER_ID = process.env.HABLA_TEST_LEARNER_ID || '00000000-0000-0000-0000-000000000002';
const SEEDS = {
  // Drops a "signed-in" learner with onboarding flags set so /session
  // and /home don't bounce to /signup or /placement. Uses the real seeded id
  // so /api/learner/<id> resolves.
  'signed-in': {
    habla_learner: JSON.stringify({
      id: REAL_LEARNER_ID,
      cefr_level: 'A2',
      profile: { name: 'Test Learner', email: 'test@example.com', daily_goal_minutes: 15, streak: 1 },
      placed: true,
      onboarded: true,
    }),
  },
  // Opens the Developer tab in the Settings drawer.
  'dev-mode': { habla_dev_mode: '1' },
  // Picks the OpenAI TTS option so the drawer voice row renders something.
  'tts-openai': { habla_tts: 'openai' },
};

// ── arg parsing ─────────────────────────────────────────────────────────
// `--click` is the only repeatable flag; collected into an array so multiple
// occurrences click in order (e.g. open drawer then switch tab). Everything
// else is single-value (last write wins, which is fine for those).
// Bare boolean flags (no `=value`) — must be enumerated so parseArgs treats
// them as flags rather than silently dropping them.
const BARE_FLAGS = new Set(['full-page', 'inject-session']);

function parseArgs(argv) {
  const out = { click: [] };
  for (const arg of argv.slice(2)) {
    const bare = arg.match(/^--([a-z-]+)$/);
    if (bare && BARE_FLAGS.has(bare[1])) { out[bare[1]] = true; continue; }
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) {
      console.error(`⚠️  ignoring unrecognized arg "${arg}". Bare flags: ${[...BARE_FLAGS].map((f) => '--' + f).join(', ')}. Otherwise use --name=value.`);
      continue;
    }
    if (m[1] === 'click') out.click.push(m[2]);
    else out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv);
const clickSelectors = args.click; // array, possibly empty
// Git Bash on Windows (MSYS) auto-translates POSIX-looking absolute args into
// Windows paths under its install prefix — `--route=/signup` arrives here as
// `C:/Program Files/Git/signup`. Detect and recover, so callers can write the
// natural form without setting MSYS_NO_PATHCONV.
function normalizeRoute(raw) {
  if (!raw) return '/';
  const mangled = raw.match(/^[A-Za-z]:[/\\]Program Files[/\\]Git[/\\](.*)$/);
  if (mangled) return '/' + mangled[1].replace(/\\/g, '/');
  if (!raw.startsWith('/')) return '/' + raw;
  return raw;
}
const route = normalizeRoute(args.route);
const seedKeys = (args.seed ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const selector = args.selector ?? null;
const extraWait = Number(args.wait ?? 600);
const viewport = (() => {
  const v = args.viewport ?? '412x892';
  const [w, h] = v.split('x').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    console.error(`bad --viewport "${v}", expected WxH`);
    process.exit(2);
  }
  return { width: w, height: h };
})();

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slugBase = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
const outPath = args.out
  ? resolve(repoRoot, args.out)
  : join(repoRoot, '.claude', 'screenshots', `${ts}-${slugBase}.png`);
mkdirSync(dirname(outPath), { recursive: true });

// ── preflight: find OUR vite server (not a random HTTP server) ──────────
// Multiple worktrees can have vite running on 5173..5180; harnesses and stray
// servers can also be on those ports. We need to find one that actually serves
// our SPA — heuristic: GET / returns 200 AND the response contains the SPA
// shell markers `<div id="root">` and the vite client script. Any port that
// returns 404 or random HTML is rejected.
function looksLikeOurApp(html) {
  return html.includes('<div id="root"') && html.includes('/@vite/client');
}

async function probeOne(url) {
  try {
    const r = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ok: false, why: `http ${r.status}` };
    const body = await r.text();
    if (!looksLikeOurApp(body)) return { ok: false, why: `not our SPA (${body.length}B, no #root or vite client)` };
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err.message ?? String(err) };
  }
}

async function probeBaseUrl() {
  if (args['base-url']) {
    const u = args['base-url'].replace(/\/+$/, '');
    const r = await probeOne(u);
    if (r.ok) return u;
    console.error(`❌ --base-url ${u} doesn't look like our app: ${r.why}`);
    process.exit(3);
  }
  // Probe both vite (5173..5180) and the token-server prod-bundle mode (:3000)
  // — when web is built and served by Express, the SPA is on :3000 directly.
  // See docs/testing-without-mic.md for the two stack modes.
  const ports = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 3000];
  const tried = [];
  for (const port of ports) {
    const u = `http://127.0.0.1:${port}`;
    const r = await probeOne(u);
    tried.push(`${port}: ${r.ok ? 'OK' : r.why}`);
    if (r.ok) {
      if (port !== 5173) console.error(`ℹ️  using ${u} (5173 didn't match; another worktree or prod-bundle mode?)`);
      return u;
    }
  }
  console.error(`❌ no AISpeaker SPA found on 5173..5180 or 3000. Launch one:`);
  console.error(`   Bash(command: "npm run dev --prefix web", run_in_background: true)`);
  console.error(`   or pass --base-url=http://127.0.0.1:<port>`);
  console.error(`   probes:\n     ${tried.join('\n     ')}`);
  process.exit(3);
}

const baseUrl = await probeBaseUrl();

// ── unknown seed names = hard fail, not silent ──────────────────────────
for (const k of seedKeys) {
  if (!(k in SEEDS)) {
    console.error(`❌ unknown seed preset "${k}". Known: ${Object.keys(SEEDS).join(', ')}`);
    process.exit(2);
  }
}

// ── drive playwright ────────────────────────────────────────────────────
// `--use-fake-*` are required for /session: Session.tsx calls
// setMicrophoneEnabled(true) on connect; without these flags Chromium's
// getUserMedia denies and the SPA shows "Mic error" instead of mounting.
// See docs/testing-without-mic.md "Headless Chromium has no microphone".
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
await ctx.grantPermissions(['microphone'], { origin: baseUrl });
const page = await ctx.newPage();

// Pipe console errors to our stderr so test failures show up in the screenshot stdout.
// Filter the known noise floor:
//   • /api/* 404 storms when token-server is down or learner id is fake
//   • ERR_INSUFFICIENT_RESOURCES storms from Session.tsx's mic-permission retry
//     loop in Chromium under load (benign — see docs/testing-without-mic.md)
// Both collapse into single summary lines so real errors stay readable.
page.on('pageerror', (e) => console.error(`[page] error: ${e.message}`));
let resource404Count = 0;
let resourceErrCount = 0;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (/Failed to load resource.*404/.test(text)) { resource404Count++; return; }
  if (/ERR_INSUFFICIENT_RESOURCES|net::ERR_/.test(text)) { resourceErrCount++; return; }
  console.error(`[page] console.error: ${text}`);
});

// localStorage must be seeded AFTER navigating to an origin (about:blank has no LS).
// Strategy: hit the origin once with a barebones HTML stub, write LS, then navigate.
if (seedKeys.length > 0) {
  await page.goto(`${baseUrl}/__seed_stub__`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((kvs) => {
    for (const [k, v] of Object.entries(kvs)) localStorage.setItem(k, v);
  }, Object.assign({}, ...seedKeys.map((k) => SEEDS[k])));
}

const url = `${baseUrl}${route}`;
const navStarted = Date.now();
// `domcontentloaded` instead of `networkidle` — the app fires several /api
// calls on mount that may 404 when token-server is down; networkidle waits up
// to 15s for those to settle. DOMContentLoaded fires once the SPA shell is
// parsed, then --wait gives React time to render.
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch((err) => {
  console.error(`❌ navigation to ${url} failed: ${err.message}`);
});

if (selector) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: 5000 }); }
  catch { console.error(`⚠️  selector "${selector}" did not appear within 5s — capturing anyway`); }
}

// Inject a fake LiveKit session into the dev bus AFTER clicks open the drawer
// and switch to the Developer tab. Why after-clicks: LiveSession only mounts
// when activeTab=='developer'; injecting BEFORE the mount populates the
// snapshot but the component then subscribes to a snapshot whose initial
// state was already read by useSyncExternalStore as EMPTY before React schedules
// the next paint. Injecting AFTER the mount triggers emit() while a listener is
// attached, which re-renders the populated branch. Uses window.__habla_devbus__
// exposed by web/src/lib/dev-bus.ts.
async function injectSession() {
  try {
    await page.waitForFunction(
      () => !!(window).__habla_devbus__,
      { timeout: 5000 },
    );
  } catch {
    console.error(`⚠️  --inject-session: window.__habla_devbus__ never appeared (dev-bus not imported on this route?)`);
    return;
  }
  await page.evaluate(() => {
    const bus = (window).__habla_devbus__;
    const now = Date.now();
    bus.setRoom({ roomName: 'screenshot-stub-room', url: 'ws://stub:7880' });
    bus.setAgent({ identity: 'sofia-stub', state: 'listening', ts: now - 5000 });
    bus.recordTurn({ role: 'tutor', text: '¿Cómo estás hoy?', final: true, ts: now - 4500 });
    bus.recordTurn({ role: 'learner', text: 'Bien, gracias.', final: true, ts: now - 2000 });
    bus.setPtt({ capturing: false, lastEnd: now - 1500 });
  });
}

for (const sel of clickSelectors) {
  try {
    await page.click(sel, { timeout: 3000 });
    await page.waitForTimeout(300);
  } catch (err) {
    console.error(`⚠️  click "${sel}" failed: ${err.message}`);
  }
}

if (args['inject-session']) {
  await injectSession();
  // Let the React subscription pick up the emit() and re-render.
  await page.waitForTimeout(400);
  // Debug aid: confirm the snapshot is still populated at screenshot time —
  // Session.tsx can stomp our injected room when its real LiveKit join
  // succeeds. If we see empty-state in the PNG, this log says why.
  const finalSnap = await page.evaluate(() => {
    const s = (window).__habla_devbus__?.getSnapshot();
    return { roomName: s?.room?.roomName, agent: s?.agent?.identity, turns: s?.turns?.length };
  });
  console.error(`[inject] snapshot at capture: room=${finalSnap.roomName ?? 'null'} agent=${finalSnap.agent ?? 'null'} turns=${finalSnap.turns}`);
}

if (extraWait > 0) await page.waitForTimeout(extraWait);

// Post-nav sanity check: if the SPA mounted nothing, surface that loudly so
// callers don't get fooled by a blank-but-successful screenshot. The previous
// failure mode was capturing an all-white image because the page server was
// some other tool that happened to be on the probed port.
const sanity = await page.evaluate(() => {
  const root = document.querySelector('#root');
  return {
    title: document.title,
    bodyTextLen: (document.body?.innerText ?? '').length,
    rootChildren: root ? root.children.length : 0,
    hasRoot: !!root,
  };
});
if (!sanity.hasRoot || sanity.rootChildren === 0) {
  console.error(`⚠️  page rendered with empty/missing #root — likely the dev server is wrong or the SPA crashed during boot. title="${sanity.title}", bodyTextLen=${sanity.bodyTextLen}`);
}

await page.screenshot({ path: outPath, fullPage: !!args['full-page'] });
const elapsedMs = Date.now() - navStarted;
await browser.close();

if (resource404Count > 0) console.error(`(${resource404Count} resource 404s suppressed — token-server likely down or learner id doesn't resolve)`);
if (resourceErrCount > 0) console.error(`(${resourceErrCount} net::ERR_* suppressed — typically Chromium's getUserMedia retry loop, benign)`);
console.error(`📸 captured ${url} (${elapsedMs}ms) → ${outPath}`);
// stdout: just the path, easy for callers to grab the last line
console.log(outPath);

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
 *   --click=<css>          After load, click this selector before capturing.
 *   --wait=<ms>            Extra wait after load (default: 600).
 *   --out=<path>           PNG output path. Defaults to .claude/screenshots/<ts>-<slug>.png.
 *   --full-page            Capture full scroll height. Default: viewport only.
 *   --viewport=<WxH>       Viewport size. Default: 412x892 (mobile portrait — matches the app).
 *
 * Exits non-zero with a helpful message if the dev server isn't listening on 5173.
 * Does NOT start the dev stack — run `npm run dev` or `npm run dev-stack -- up` first.
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
const FAKE_LEARNER_ID = '00000000-0000-0000-0000-000000000aaa';
const SEEDS = {
  // Drops a fake "signed-in" learner with onboarding flags set so /session
  // and /home don't bounce to /signup or /placement.
  'signed-in': {
    habla_learner: JSON.stringify({
      id: FAKE_LEARNER_ID,
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
function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (arg === '--full-page') { out.fullPage = true; continue; }
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv);
const route = args.route ?? '/';
const seedKeys = (args.seed ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const selector = args.selector ?? null;
const clickSelector = args.click ?? null;
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

// ── preflight: dev server reachable? ────────────────────────────────────
const baseUrl = 'http://127.0.0.1:5173';
try {
  // Vite returns 200 on /; if it 404s on a SPA route that's fine — just need TCP+HTTP.
  const r = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
  if (!r.ok && r.status !== 404) throw new Error(`http ${r.status}`);
} catch (err) {
  console.error(`❌ dev server not reachable at ${baseUrl} — run \`npm run dev\` or \`npm run dev-stack -- up\` first`);
  console.error(`   underlying error: ${err.message ?? err}`);
  process.exit(3);
}

// ── unknown seed names = hard fail, not silent ──────────────────────────
for (const k of seedKeys) {
  if (!(k in SEEDS)) {
    console.error(`❌ unknown seed preset "${k}". Known: ${Object.keys(SEEDS).join(', ')}`);
    process.exit(2);
  }
}

// ── drive playwright ────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// Pipe console errors to our stderr so test failures show up in the screenshot stdout.
page.on('pageerror', (e) => console.error(`[page] error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.error(`[page] console.error: ${m.text()}`);
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
await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch((err) => {
  console.error(`❌ navigation to ${url} failed: ${err.message}`);
});

if (selector) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: 5000 }); }
  catch { console.error(`⚠️  selector "${selector}" did not appear within 5s — capturing anyway`); }
}

if (clickSelector) {
  try { await page.click(clickSelector, { timeout: 3000 }); }
  catch (err) { console.error(`⚠️  click "${clickSelector}" failed: ${err.message}`); }
}

if (extraWait > 0) await page.waitForTimeout(extraWait);

await page.screenshot({ path: outPath, fullPage: !!args.fullPage });
const elapsedMs = Date.now() - navStarted;
await browser.close();

console.error(`📸 captured ${url} (${elapsedMs}ms) → ${outPath}`);
// stdout: just the path, easy for callers to grab the last line
console.log(outPath);

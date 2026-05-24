#!/usr/bin/env node
/**
 * Stop hook: typecheck the web app if any of its source files changed during
 * this turn. Silent on success; prints tsc errors on failure so the model sees
 * them and can fix on the next turn.
 *
 * Why a Stop hook (not PostToolUse): tsc --noEmit takes a few seconds. Running
 * it after every Edit would tax interactive latency. Running once at end of
 * turn is the sweet spot — the agent already considers the turn "done" and is
 * about to hand back to the user, so a few-second pause is acceptable and the
 * error surface point is correct ("you said you were done but ts is broken").
 *
 * Skips itself entirely if no web/src/**\/*.{ts,tsx} files have changed since
 * the last successful run (sentinel mtime at .claude/.last-typecheck-web).
 */
import { readdirSync, statSync, existsSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const SENTINEL = join(repoRoot, '.claude', '.last-typecheck-web');
const WEB_SRC = join(repoRoot, 'web', 'src');

// Recursively collect .ts/.tsx files under web/src
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && (extname(e.name) === '.ts' || extname(e.name) === '.tsx')) out.push(p);
  }
  return out;
}

const sentinelMtime = existsSync(SENTINEL) ? statSync(SENTINEL).mtimeMs : 0;
const files = walk(WEB_SRC);
const changed = files.filter((f) => statSync(f).mtimeMs > sentinelMtime);

if (changed.length === 0) {
  // Nothing touched — exit silent. Don't update sentinel; lets the next true
  // change still trigger a check even if no files were touched between turns.
  process.exit(0);
}

const r = spawnSync('npm', ['run', '--silent', 'typecheck', '--prefix', 'web'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  // Allow up to 30s — fresh tsc with no cache can be slow on this codebase.
  timeout: 30_000,
});

if (r.status === 0) {
  // Stamp the sentinel only on success so any failing turn keeps re-triggering
  // until the model fixes it.
  try { closeSync(openSync(SENTINEL, 'w')); } catch { /* ignore */ }
  process.exit(0);
}

// Surface a concise error excerpt — tsc output can be long, head it.
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
const lines = out.split('\n').filter((l) => l.trim().length > 0);
const errorLines = lines.filter((l) => /error\s+TS\d+:/i.test(l));
const sample = (errorLines.length > 0 ? errorLines : lines).slice(0, 30);
console.log(`⚠️  web typecheck failed after this turn — ${changed.length} file(s) changed`);
console.log(sample.join('\n'));
if (lines.length > sample.length) {
  console.log(`  … ${lines.length - sample.length} more line(s). Run \`npm run typecheck --prefix web\` for the full output.`);
}
// Exit 0 so the hook doesn't block Claude — we just want the message surfaced.
process.exit(0);

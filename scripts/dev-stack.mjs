#!/usr/bin/env node
/**
 * Manage the local dev stack (livekit, server, agent, web).
 *
 * Why: the project's `npm run dev` script runs the 4 processes under
 * `concurrently`, which interleaves stdout and dies as a unit. For Claude-driven
 * iteration we want them detached with per-process logs, a kill-just-the-agent
 * path (agent.ts is tsx and has no HMR), and a single source of truth for "is
 * the stack up?".
 *
 * Usage:
 *   npm run dev-stack -- up                # start whichever processes aren't running
 *   npm run dev-stack -- status            # ports + PIDs + last log lines, table view
 *   npm run dev-stack -- down              # kill everything we started
 *   npm run dev-stack -- restart-agent     # kill+respawn just the agent (most common loop)
 *   npm run dev-stack -- tail <name> [N]   # tail .<name>.log (N defaults to 60)
 *
 * State is tracked in .claude/.dev-stack.pids.json — gitignored. Per-process
 * logs go to .<name>.log at repo root (already gitignored by `*.log`).
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, writeFileSync, openSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const STATE_DIR = join(repoRoot, '.claude');
const STATE_FILE = join(STATE_DIR, '.dev-stack.pids.json');

// One row per managed process. `port` may be 0 (no listening port — match by pid only).
const PROCESSES = [
  { name: 'livekit', port: 7880, cmd: 'node',  args: ['scripts/start-livekit.mjs'] },
  { name: 'server',  port: 3000, cmd: 'npx',   args: ['tsx', 'src/token-server.ts'] },
  { name: 'agent',   port: 0,    cmd: 'npx',   args: ['tsx', 'src/agent.ts', 'dev'] },
  { name: 'web',     port: 5173, cmd: 'npm',   args: ['run', 'dev', '--prefix', 'web'] },
];

function readState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function probePort(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = createConnection({ host: '127.0.0.1', port, timeout: 800 });
    const done = (ok) => { sock.removeAllListeners(); sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function logPath(name) { return join(repoRoot, `.${name}.log`); }

function spawnProc(p) {
  const fd = openSync(logPath(p.name), 'a');
  // Note the start time so `status` can show how long it's been running.
  const child = spawn(p.cmd, p.args, {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', fd, fd],
    shell: process.platform === 'win32', // npm/npx on win32 are .cmd scripts
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  child.unref();
  return child.pid;
}

async function cmdUp() {
  const state = readState();
  const results = [];
  for (const p of PROCESSES) {
    const existing = state[p.name];
    const alive = existing?.pid && isAlive(existing.pid);
    const portUp = await probePort(p.port);
    if (alive && (p.port === 0 || portUp)) {
      results.push({ name: p.name, action: 'already-up', pid: existing.pid });
      continue;
    }
    // If port is taken by something we didn't start, refuse rather than spawn a doomed dup.
    if (!alive && p.port && portUp) {
      results.push({ name: p.name, action: 'port-busy', pid: null, hint: `:${p.port} held by another process` });
      continue;
    }
    const pid = spawnProc(p);
    state[p.name] = { pid, startedAt: Date.now() };
    results.push({ name: p.name, action: 'spawned', pid });
  }
  writeState(state);
  // Give the processes a moment to bind ports before reporting status.
  await new Promise((r) => setTimeout(r, 1500));
  await printStatus(results);
}

async function cmdDown() {
  const state = readState();
  for (const p of PROCESSES) {
    const ent = state[p.name];
    if (!ent?.pid) continue;
    try { process.kill(ent.pid); console.log(`  killed ${p.name} (pid ${ent.pid})`); }
    catch (err) { console.log(`  could not kill ${p.name} (pid ${ent.pid}): ${err.message}`); }
    delete state[p.name];
  }
  writeState(state);
}

async function cmdRestartAgent() {
  const state = readState();
  const ent = state.agent;
  if (ent?.pid && isAlive(ent.pid)) {
    try { process.kill(ent.pid); console.log(`  killed agent (pid ${ent.pid})`); }
    catch (err) { console.log(`  agent kill failed: ${err.message}`); }
  }
  const agentProc = PROCESSES.find((p) => p.name === 'agent');
  const pid = spawnProc(agentProc);
  state.agent = { pid, startedAt: Date.now() };
  writeState(state);
  console.log(`  spawned agent (pid ${pid}) — tail .agent.log for boot`);
}

async function printStatus(actionRows) {
  const state = readState();
  const rows = [];
  for (const p of PROCESSES) {
    const ent = state[p.name];
    const alive = ent?.pid ? isAlive(ent.pid) : false;
    const portUp = await probePort(p.port);
    const ageMs = ent?.startedAt ? Date.now() - ent.startedAt : 0;
    const ageStr = ent?.startedAt ? `${Math.floor(ageMs / 1000)}s ago` : '—';
    const action = actionRows?.find((r) => r.name === p.name);
    rows.push({
      name: p.name,
      pid: ent?.pid ?? '—',
      alive: alive ? '✓' : '✗',
      port: p.port || '—',
      portUp: p.port ? (portUp ? '✓' : '✗') : '—',
      started: ageStr,
      action: action?.action ?? '',
      hint: action?.hint ?? '',
    });
  }
  // Pretty-print.
  const w = (k, min) => Math.max(min, ...rows.map((r) => String(r[k]).length));
  const widths = { name: w('name', 7), pid: w('pid', 6), alive: w('alive', 5), port: w('port', 5), portUp: w('portUp', 7), started: w('started', 9), action: w('action', 10), hint: 0 };
  const header = ['name','pid','alive','port','portUp','started','action','hint'].map((k) => k.padEnd(widths[k])).join('  ');
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const r of rows) {
    console.log(['name','pid','alive','port','portUp','started','action','hint'].map((k) => String(r[k]).padEnd(widths[k])).join('  '));
  }
}

function cmdTail(name, n) {
  if (!name) { console.error('usage: dev-stack tail <name> [N]'); process.exit(2); }
  const path = logPath(name);
  if (!existsSync(path)) { console.error(`no log at ${path}`); process.exit(3); }
  const lines = Number(n ?? 60);
  const body = readFileSync(path, 'utf8').split('\n');
  console.log(body.slice(-lines).join('\n'));
  const st = statSync(path);
  console.error(`── tail ${lines} of ${path} (${st.size} bytes)`);
}

const [, , subcmd, ...rest] = process.argv;
const cmd = (subcmd || 'status').toLowerCase();
try {
  if (cmd === 'up') await cmdUp();
  else if (cmd === 'down') await cmdDown();
  else if (cmd === 'restart-agent') await cmdRestartAgent();
  else if (cmd === 'status') await printStatus();
  else if (cmd === 'tail') cmdTail(rest[0], rest[1]);
  else {
    console.error(`unknown subcommand "${cmd}". Known: up | down | status | restart-agent | tail <name> [N]`);
    process.exit(2);
  }
} catch (err) {
  console.error(`dev-stack failed: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
}

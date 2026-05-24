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
 *   npm run dev-stack -- up                # start whichever processes aren't already up
 *   npm run dev-stack -- up web            # start just `web` (and only if not up)
 *   npm run dev-stack -- up web server     # start a subset
 *   npm run dev-stack -- status            # ports + PIDs + last log lines, table view
 *   npm run dev-stack -- down              # kill everything we started
 *   npm run dev-stack -- restart-agent     # kill+respawn just the agent (most common loop)
 *   npm run dev-stack -- tail <name> [N]   # tail .<name>.log (N defaults to 60)
 *
 * Selective `up` is the right default when another agent or worktree owns part
 * of the stack — e.g. they're running their own agent worker on port 7880 and
 * you only need vite for a screenshot. `up` without args is convenient but can
 * collide (spawning a 2nd agent worker registers as a duplicate sofia dispatcher
 * and LiveKit will round-robin between them — usually not what you want).
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
// `portRange` lists additional ports to probe for an existing instance — used by
// `web` because vite cycles through 5173..5180 when worktrees collide on the
// primary port. The first port in the range that responds wins.
const PROCESSES = [
  { name: 'livekit', port: 7880, cmd: 'node',  args: ['scripts/start-livekit.mjs'] },
  { name: 'server',  port: 3000, cmd: 'npx',   args: ['tsx', 'src/token-server.ts'] },
  { name: 'agent',   port: 0,    cmd: 'npx',   args: ['tsx', 'src/agent.ts', 'dev'] },
  { name: 'web',     port: 5173, cmd: 'npm',   args: ['run', 'dev', '--prefix', 'web'],
    portRange: [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180] },
];

function knownNames() { return PROCESSES.map((p) => p.name); }

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

/** Return the first reachable port in the process's port range (or its primary), or 0. */
async function findActivePort(p) {
  const ports = p.portRange ?? (p.port ? [p.port] : []);
  for (const port of ports) {
    if (await probePort(port)) return port;
  }
  return 0;
}

function logPath(name) { return join(repoRoot, `.${name}.log`); }

/**
 * Print the exact Bash invocation an agent should use to launch a process.
 *
 * Why this is a "print, don't spawn" pattern: the Claude Code harness sandboxes
 * each Bash tool call's process tree. Anything we spawn from inside a tool
 * call — even `detached: true` + `unref()` — dies when the Bash invocation
 * returns. The only way to keep vite/agent/server alive across multiple tool
 * calls is to launch them via `Bash(..., run_in_background: true)`, which
 * the harness tracks as a long-lived background task.
 *
 * So this script's job is to TELL the agent the right command; the agent has
 * to actually issue the Bash call.
 */
function launchHint(p) {
  const cmdline = `${p.cmd} ${p.args.join(' ')}`;
  return [
    `  To start "${p.name}" so it survives across tool calls, run:`,
    ``,
    `    Bash(command: "${cmdline}", run_in_background: true)`,
    ``,
    `  via Claude Code's Bash tool (NOT this dev-stack script — anything spawned`,
    `  inside a sandboxed Bash invocation is reaped when that call returns).`,
  ].join('\n');
}

async function cmdUp(filter) {
  const targets = filter && filter.length > 0
    ? PROCESSES.filter((p) => filter.includes(p.name))
    : PROCESSES;
  if (filter && filter.length > 0) {
    const unknown = filter.filter((n) => !knownNames().includes(n));
    if (unknown.length > 0) {
      console.error(`unknown process name(s): ${unknown.join(', ')}. Known: ${knownNames().join(', ')}`);
      process.exit(2);
    }
  }
  console.log(`dev-stack "up" doesn't spawn processes itself — it prints the`);
  console.log(`right invocation. (See the comment above launchHint() in dev-stack.mjs`);
  console.log(`for why.) For each requested process:\n`);
  for (const p of targets) {
    const activePort = await findActivePort(p);
    if (p.port && activePort) {
      console.log(`◆ ${p.name}: already responding on :${activePort} — nothing to do.\n`);
      continue;
    }
    if (p.port === 0) {
      console.log(`◆ ${p.name}: no port to probe — assume not running.`);
    } else {
      console.log(`◆ ${p.name}: nothing on :${p.port}.`);
    }
    console.log(launchHint(p));
    console.log('');
  }
}

async function cmdDown() {
  // We don't manage PIDs anymore (see launchHint comment). Use the harness's
  // KillShell tool to stop background Bash invocations the agent started, or
  // kill matched PIDs by command line on Windows via tasklist.
  console.log(`dev-stack doesn't manage processes itself, so it can't stop them.`);
  console.log(`To stop a background Bash invocation you started, use the`);
  console.log(`harness's KillShell tool with the shell ID returned by run_in_background.`);
  console.log(``);
  console.log(`To kill all matching processes on Windows, manually:`);
  for (const p of PROCESSES) {
    if (p.cmd === 'npx' || p.cmd === 'npm' || p.cmd === 'node') {
      const pattern = p.args.slice(-2).join(' ');
      console.log(`  ${p.name}: PowerShell -c "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match '${pattern}' } | Stop-Process -Force"`);
    }
  }
}

async function cmdRestartAgent() {
  console.log(`To restart the agent without HMR:`);
  console.log(``);
  console.log(`  1. Stop the running agent (KillShell on its background ID, or`);
  console.log(`     PowerShell-kill the node.exe whose CommandLine matches \`src/agent.ts\`).`);
  console.log(`  2. Then:\n`);
  const agentProc = PROCESSES.find((p) => p.name === 'agent');
  console.log(launchHint(agentProc));
}

async function printStatus(actionRows) {
  const state = readState();
  const rows = [];
  for (const p of PROCESSES) {
    const ent = state[p.name];
    const alive = ent?.pid ? isAlive(ent.pid) : false;
    const activePort = await findActivePort(p);
    const ownedByUs = alive;
    // Status legend:
    //   managed  — we spawned it and the PID is still alive
    //   external — port is held by something (another worktree, audio agent,
    //              your background-Bash launch, or even a process we spawned
    //              and lost track of — we can't tell who)
    //   down     — no PID and no port responding
    //   —        — no port to probe (only `agent`) AND we don't track a live PID
    // "dead" was a previous status for "we recorded a PID, that PID is gone,
    // and no port responds." We collapsed it into either external (if port up)
    // or down (if not) — the practical question is "is something responding?"
    let status;
    if (ownedByUs) status = 'managed';
    else if (activePort) status = 'external';
    else if (p.port === 0) status = '—';
    else status = 'down';
    const portStr = activePort
      ? (activePort === p.port ? String(activePort) : `${activePort} (≠${p.port})`)
      : (p.port ? `${p.port} ✗` : '—');
    const ageMs = ent?.startedAt ? Date.now() - ent.startedAt : 0;
    const ageStr = ownedByUs && ent?.startedAt ? `${Math.floor(ageMs / 1000)}s ago` : '—';
    const action = actionRows?.find((r) => r.name === p.name);
    rows.push({
      name: p.name,
      status,
      pid: ent?.pid ?? '—',
      port: portStr,
      started: ageStr,
      action: action?.action ?? '',
      hint: action?.hint ?? '',
    });
  }
  const w = (k, min) => Math.max(min, ...rows.map((r) => String(r[k]).length));
  const cols = ['name','status','pid','port','started','action','hint'];
  const widths = Object.fromEntries(cols.map((k) => [k, k === 'hint' ? 0 : w(k, k.length)]));
  const header = cols.map((k) => k.padEnd(widths[k])).join('  ');
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const r of rows) {
    console.log(cols.map((k) => String(r[k]).padEnd(widths[k])).join('  '));
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
  if (cmd === 'up') await cmdUp(rest);
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

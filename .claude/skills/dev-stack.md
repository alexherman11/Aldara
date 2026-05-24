---
name: dev-stack
description: Inspect the 4-process local dev stack (livekit, token-server, agent, web) — status, log tails, and the recommended launch invocations. The Claude Code harness reaps anything spawned inside a sandboxed Bash call, so this script PRINTS the right `Bash(..., run_in_background: true)` commands rather than spawning processes itself.
---

# dev-stack

Wraps `scripts/dev-stack.mjs`. Reports on (and helps you launch) the local dev stack: `livekit`, `server`, `agent`, `web`.

## How processes actually run here

The Claude Code harness reaps the process tree of each Bash invocation when it returns. So **anything you `spawn(...)` inside `npm run dev-stack` dies the moment the script exits**, even with `detached:true + unref()`. The only way to keep vite/agent/server alive across multiple tool calls is to launch them yourself via:

```
Bash(command: "<launch-cmd>", run_in_background: true)
```

`dev-stack up [name]` is therefore a **print-only helper** — it tells you the exact invocation, then you (the agent) issue the Bash call.

## Why not just `npm run dev`?

- `concurrently` ties the 4 processes together — can't restart just one
- stdout is interleaved across processes — hard to grep
- It dies when your Bash invocation ends (see above)
- The agent process (`tsx src/agent.ts`) has no HMR; you'll relaunch it constantly

## Commands

```bash
npm run dev-stack -- status           # table: status, pid, port, age — actually probes ports
npm run dev-stack -- up               # PRINTS the Bash commands you should run (does not spawn)
npm run dev-stack -- up web           # same, scoped to one process
npm run dev-stack -- tail agent 100   # tail .agent.log (default 60 lines) — only useful when something is writing there
npm run dev-stack -- tail web         # any of: livekit, server, agent, web
npm run dev-stack -- down             # PRINTS the kill commands (PowerShell, since we don't own PIDs)
npm run dev-stack -- restart-agent    # PRINTS the kill+relaunch commands
```

## Status legend

- `external` — the port is held by something — could be your own background Bash, another worktree, or the audio agent. Status can't tell who.
- `down` — primary port is free, nothing listening
- `—` — process has no port (only `agent`)

For "managed" tracking, rely on the harness's background-shell list — that's the only authoritative source of "did I start this?" here.

The `port` column shows the actual port found. If our app shifted (e.g. `5174 (≠5173)` for vite when 5173 is taken by another worktree), the screenshot tool will auto-discover.

## What it tracks

Process | Port | What
--------|------|-----
livekit | 7880 | Self-hosted LiveKit server (`scripts/start-livekit.mjs`)
server  | 3000 | Express token-server (`src/token-server.ts`)
agent   |  —   | LiveKit agent worker (`src/agent.ts`) — no port; presence inferred from PID
web     | 5173 | Vite dev server (`web/`)

State: `.claude/.dev-stack.pids.json` (gitignored).
Logs: `.<name>.log` at repo root (gitignored).

## Common loop for UI changes

```bash
# 1. Status check — is web actually reachable?
npm run dev-stack -- status

# 2. If web is "down", launch it via background Bash:
#    Bash(command: "npm run dev --prefix web", run_in_background: true)
#    (`npm run dev-stack -- up web` prints this same command for you.)

# 3. Make your edit, screenshot to verify (see /screenshot skill)
npm run screenshot -- --route=/session --seed=signed-in,dev-mode --inject-session \
  --click="[data-testid=btn-menu]" --click="button:has-text('DEVELOPER')"

# 4. If you edited src/agent.ts, kill+relaunch agent (no HMR):
#    KillShell the agent's background ID, then:
#    Bash(command: "npx tsx src/agent.ts dev", run_in_background: true)
npm run dev-stack -- tail agent 60     # confirm clean boot
```

## Gotchas

- **`up` doesn't spawn — it prints.** See "How processes actually run here" above. This is intentional, not a bug.
- **Status can't distinguish "your background Bash" from "audio agent's processes" from "another worktree's vite".** They all show as `external`. Track your own with the harness's background-shell list.
- **`agent` has no port.** Status can't probe it; you have to look at log output or `tasklist`.
- **The script does NOT manage Postgres.** If `setup-db` hasn't run, the server will boot but learner endpoints will 500. Run `npm run setup-db` once per fresh DB.
- **Logs only fill if the process is actually running and writing to them.** With background-Bash launches, output goes wherever the harness piped it (its own task output file), NOT to `.<name>.log`. The `tail` subcommand only sees the log files filled by the legacy `dev-stack up` spawn path, so it's mostly useful for old logs left from prior `npm run dev` sessions.

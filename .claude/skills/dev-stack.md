---
name: dev-stack
description: Start, stop, inspect, or restart the 4-process local dev stack (livekit, token-server, agent, web). Use this instead of `npm run dev` whenever you need detached processes you can probe and restart individually — especially when iterating on src/agent.ts which has no HMR.
---

# dev-stack

Wraps `scripts/dev-stack.mjs`. Owns the local dev stack as 4 detached processes with per-process logs and a single PID file. Replaces ad-hoc `npm run dev` for any agent-driven workflow.

## Why not just `npm run dev`?

- `concurrently` ties the 4 processes together — can't restart just one
- stdout is interleaved across processes — hard to grep
- killing it doesn't always reap children on Windows
- The agent process (`tsx src/agent.ts`) has no HMR; you'll restart it constantly. `dev-stack restart-agent` is the fast path.

## Commands

```bash
npm run dev-stack -- up               # spawn whichever processes aren't running
npm run dev-stack -- status           # table of: pid, alive?, port, portUp?, age, last action
npm run dev-stack -- down             # kill everything we started
npm run dev-stack -- restart-agent    # kill+respawn ONLY the agent
npm run dev-stack -- tail agent 100   # tail .agent.log (default 60 lines)
npm run dev-stack -- tail server      # any of: livekit, server, agent, web
```

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
# 1. Ensure stack is up
npm run dev-stack -- status            # any ✗ in alive/portUp?
npm run dev-stack -- up                # bring up missing ones

# 2. Make your edit, then screenshot to verify (see /screenshot skill)
npm run screenshot -- --route=/session --seed=signed-in

# 3. If you edited src/agent.ts, restart it (no HMR)
npm run dev-stack -- restart-agent
npm run dev-stack -- tail agent 60     # confirm clean boot
```

## When to use the underlying tool directly vs this skill

- **Use this skill** for "is the stack up?", "restart the agent", "did the agent boot cleanly?"
- **Skip it** if you're already inside `npm run dev` and seeing all 4 streams interleaved (interactive dev). The skill targets *automation* loops where each process needs to be addressable individually.

## Gotchas

- The skill refuses to spawn a process if its port is already held by something else (e.g., a stray `npm run dev` from another shell). `dev-stack down` first, then `up`.
- `agent` has no port — "alive" is determined purely by PID being reachable via `kill(pid, 0)`. If the agent process crashed and the OS reaped it, status will show `alive=✗` and `up` will respawn it.
- On Windows, `npm`/`npx` resolve to `.cmd` scripts; the script handles this with `shell: true` on win32 only. Don't expect process names to match `node` in Task Manager — look for child `node.exe` processes.
- The script does NOT manage Postgres. If `setup-db` hasn't run, the server will boot but learner endpoints will 500. Run `npm run setup-db` once per fresh DB.

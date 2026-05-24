# AISpeaker / Habla — agent guide

Voice-AI Spanish tutor. Cascaded pipeline: STT → LLM (Sofía, gpt-4o) → TTS, over LiveKit. React/Vite frontend, Express token-server, Postgres for learner profiles. The agent layer also runs side-channel classifiers (Claude Haiku) and async compaction (Claude Sonnet).

## Project-local tooling — USE THESE

The repo ships with skills and subagents that exist *specifically* to make agent-driven iteration cheap. Default to them.

### Skills (invoke from main thread)

- **`/screenshot`** — Drives headless Chromium against the local web app, returns a PNG path you can `Read`. Use it any time you've changed UI code. Supports localStorage seeds (`signed-in`, `dev-mode`, `tts-openai`) to skip past onboarding. See `.claude/skills/screenshot.md`.
- **`/dev-stack`** — Manages the 4-process dev stack (`livekit`, `server`, `agent`, `web`) as *detached* processes with per-process logs. Use `npm run dev-stack -- status` before any UI work; `npm run dev-stack -- restart-agent` after editing `src/agent.ts` (no HMR). See `.claude/skills/dev-stack.md`.

### Subagents (delegate via the Agent tool)

- **`frontend-explorer`** — Read-only investigator that owns the web tree's structure (router, pages, state layers, the two parallel devBus-vs-RPC data paths). Use for "where does X live in the UI?" questions to save context. Returns ≤300-word focused reports.
- **`verify-ui`** — After a UI change, drives `/screenshot` against affected routes, reads the PNGs itself, returns a verdict. Use when you've claimed a UI change is done and want closure without burning main-thread context.

### Hooks (automatic)

- **Stop hook** runs `npm run typecheck --prefix web` at end of turn, **only if** any `web/src/**/*.{ts,tsx}` changed since the last successful run. Silent on success; surfaces tsc errors so you fix them next turn. See `scripts/hook-typecheck-web.mjs`.

## The canonical loops

**Pure-frontend change (TSX, no agent edits):**
1. Make the edit
2. `npm run screenshot -- --route=<affected> --seed=signed-in[,dev-mode]`
3. `Read` the PNG
4. Done. Stop hook will surface any TS error you missed.

**Backend change (src/agent.ts, src/prompts/*, src/pronunciation/*):**
1. Make the edit
2. `npm run dev-stack -- restart-agent`
3. `npm run dev-stack -- tail agent 60` — confirm clean boot
4. If audio-driven verification matters, hand to the audio agent. Otherwise screenshot the dev panel to confirm the new state surfaces.

**"Where does X live?" before editing:**
- Delegate to `frontend-explorer` (web) instead of grepping yourself when the answer needs ≥3 reads.

## Layout cheat-sheet

```
src/                     TS backend
├── agent.ts             LiveKit agent worker — Sofía's brain. NO HMR.
├── token-server.ts      Express. Issues LiveKit tokens, owns learner CRUD.
├── prompts/             Sofía persona, placement persona, compaction prompt
├── prompt-builder.ts    Assembles the per-turn system prompt
├── difficulty-controller.ts   Per-turn + edge-check classifier (Haiku)
├── pronunciation/       Factory: noop|speechace|azure|segmented
├── stt/                 Factory: assemblyai|deepgram|openai
├── compaction.ts        Post-session core diff (Sonnet)
└── db/                  pg client + learner CRUD

web/src/
├── App.tsx              wouter router
├── pages/               Signup, Placement, DailyGoal, Home, Session, Summary
├── components/
│   ├── SettingsDrawer.tsx       Profile/Progress/Developer tabs
│   ├── TtsSettings.tsx          New paired provider+voice picker
│   ├── PlacementCalibrationBar.tsx
│   ├── Orb.tsx · Waveform.tsx
│   └── ui/                      shadcn — only 7 modules are kept (drawer, input, label, select, toast, toaster, tooltip)
└── lib/
    ├── api.ts           HTTP RPC client + localStorage helpers
    ├── dev-bus.ts       In-memory pub/sub between Session.tsx ⇄ Developer tab

scripts/                 Test suites + tooling
├── screenshot.mjs       /screenshot skill backend
├── dev-stack.mjs        /dev-stack skill backend
├── hook-typecheck-web.mjs   Stop-hook entrypoint
├── run-unit-tests.ts    `npm test` — Layer 1 offline suites only
└── scenario-harness*.ts Live-stack scripted-learner harnesses
```

## Gotchas

- **`npm install` needs `--legacy-peer-deps`** for any agent-plugin change — `@livekit/agents` core is pinned at 1.2.6 but plugins float to 1.2.8. Without the flag, install fails silently with exit 0 and your package never lands.
- **`src/agent.ts` has no HMR.** Edits to agent, prompts, controller, pronunciation, compaction all require `dev-stack restart-agent`. Vite handles the rest.
- **`.env.example` documents the canonical env vars** — `STT_PROVIDER`, `PRONUNCIATION_PROVIDER`, `SEGMENTED_STT`, `SOFIA_AGENT_NAME`, all the TTS keys. Missing values silently fall back to defaults; check `.env.example` if a feature isn't picking up your config.
- **Two parallel "live session" data paths** in the dev panel: `debug_snapshot` RPC (polled by the scenario harness) and `devBus` (consumed by SettingsDrawer's Developer tab). Don't confuse them; SettingsDrawer uses devBus.
- **Layer 1 vs Layer 2 tests.** `npm test` runs only the offline suites listed in `scripts/run-unit-tests.ts`. Anything that hits Anthropic/OpenAI/Deepgram/Azure/Cartesia/Postgres is NOT in `npm test` and must be invoked directly via `tsx scripts/<name>.ts`. To add a suite to `npm test`, it must be fully offline.
- **Stop hook can be skipped.** If you genuinely don't want the typecheck this turn (e.g., you're mid-refactor and intentionally leaving things broken for the next turn), the hook will still run but its output is informational only — it doesn't block. Just keep going.
- **Historical docs live in `docs/archive/`** (phase11/12/13 plans + results, habla prototype/v2 plans, PROMPTS, pronunciation-research). The living architecture doc is `PIPELINE_ARCH.md` at the root.

## Don't

- Don't run `npm run dev` for automation — use `dev-stack up`. The former ties processes together so you can't restart individually.
- Don't add screenshots/PNGs to git — `.claude/screenshots/` is gitignored.
- Don't widen `tsx` script invocations into `npm test` unless they're truly offline. Layer 1's whole point is that it runs without network.

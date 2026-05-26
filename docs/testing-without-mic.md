# Testing Habla without a microphone

How Claude (or any human) can drive the app end-to-end — including the
pronunciation feedback loop — without speaking into a mic. Written 2026‑05‑23
after a few previous attempts hit dead ends on the LiveKit synth-audio path.

## TL;DR

```bash
# 1. Backend-only smoke test (~30s, no browser, no LiveKit) — fastest signal
npm run test-bad-pron

# 2. Full visual end-to-end (~60s/case, real React UI, real agent worker)
npm run test-visual-bad-pron               # all cases
npm run test-visual-bad-pron escali-mountains   # one case
HEADED=1 npm run test-visual-bad-pron      # watch it run in a browser

# 3. The in-process conversation simulator (LLM + controller + prompts, no audio)
npx tsx scripts/scenario-harness-direct.ts
```

Prereqs: `npm run dev` running (livekit + server + agent + web) and
`HABLA_DEV_INJECT=1` in `.env`.

## Why the obvious path doesn't work

`scripts/scenario-harness.ts` exists and tries to do the natural thing:
synthesize learner speech with Cartesia/OpenAI TTS, publish it as an audio
track through LiveKit, let the agent's Deepgram STT transcribe it. **This is
broken.** Audio reaches the room (peak amplitudes look right), the agent
state machine ticks correctly, but Deepgram returns empty transcripts on
synthesized speech routed through LiveKit's Opus path. The agent ends up
responding to silence — see `scenarios/first-session-warm-up/1778711160379/
events.jsonl` for the smoking gun: every turn shows
`recognized_text=""` and `last_turn_reason="Learner provided no response."`

Don't try to fix this unless you have several hours and a Wireshark setup.
The three working paths below sidestep it entirely.

## The three working harnesses

### 1. `scenario-harness-direct.ts` — in-process conversation simulator

Drives `evaluateTurn`, `buildSystemPrompt`, `runCompaction` directly with
text turns. No LiveKit, no audio, no browser. Fastest possible feedback for
conversation logic, difficulty controller, prompt evolution, FSRS compaction.

Already existed; previous Claudes forgot. Header comment claims "100%
reliable, covers everything except the live audio path itself" — still true.

**Use when:** iterating on the conversation, controller, prompts, or
compaction. Don't reach for the visual harness for these — this is 10× faster.

### 2. `scripts/test-bad-pronunciation.ts` — pronunciation feedback loop, backend only

Picks pre-recorded bad-pronunciation WAVs out of `recordings/` (real human
audio captured via `RECORD_TURNS=1` in past live sessions), runs the
`SegmentedAssessor` (Deepgram → Azure) live, drops the assessment into a
synthetic `SessionContext`, rebuilds the prompt, and calls gpt‑4o for
Sofía's reply. Asserts: assessor flagged the expected words, prompt
contains the pronunciation section, Sofía's reply echoes the flagged word
back cleanly.

3 anchor cases (escalí/montañas, Sofía/conmigo, visitar). Add new ones by
appending to `CASES` with `{ recordingPath, mustFlagWords, expectSofiaToEcho }`.

**Use when:** tuning the assessor → prompt → LLM portion of the
pronunciation feedback loop. Already caught one real defect: the
`sofia-conmigo` case, where the assessor + prompt do their job but gpt‑4o
paraphrases the user instead of modeling flagged words back. That's the
regression target for a future iteration.

### 3. `scripts/test-visual-bad-pronunciation.mjs` — full visual end-to-end

Real Playwright Chromium, real React frontend, real LiveKit room, real
agent worker, real assessor, real LLM, real TTS — only thing skipped is
STT. Drives a complete session per case:

1. Seeds a signed-in learner in localStorage, opens `/session`.
2. Reads the live room name from `window.__habla_devbus__`.
3. Calls `POST /api/dev/inject-turn { roomName, text, recordingPath }`.
4. The token-server joins the room as a service participant and RPCs the
   agent with `dev_inject_turn`.
5. The agent runs the same `injectTurnForTesting(text, wav)` path: pushes
   transcript, publishes a `dev_inject_bubble` data-channel message so the
   UI renders a learner bubble, kicks off the assessor (publishes
   `pronunciation` data-channel when done), calls `session.generateReply`.
6. The browser shows the learner bubble, the citation, and Sofía's reply
   exactly as it would in a real session.
7. Playwright waits for `agent.state==='listening'` (Sofía done talking),
   screenshots, asserts.

Artifacts: `scenarios/visual-bad-pron/<timestamp>/<case>.png`,
`final.png`, `results.json`.

**Use when:** verifying the UI renders the feedback correctly, or doing a
visual regression sweep across many cases. Also the only path that
exercises the agent-worker process, RPC plumbing, data-channel topics, and
React renderer together.

## Architecture diagram

```
                Playwright (real Chromium)
                       │
                       │ seeds localStorage, /session
                       ▼
              ┌────────────────────┐
              │  React app (:3000  │
              │   prod bundle, or  │
              │   :5173 Vite dev)  │
              └────────┬───────────┘
                       │ joins LiveKit room
                       ▼
                ┌──────────────┐    ┌──────────────────────┐
                │  LiveKit     │◄───┤  Agent worker        │
                │  (:7880)     │    │  (HABLA_DEV_INJECT=1)│
                └──────┬───────┘    └─────┬────────────────┘
                       │                  │
                       │ RPC injection    │ dev_inject_turn RPC
                       ▼                  │
              POST /api/dev/inject-turn   │
              ┌─────────────────────────┐ │
              │  token-server (:3000)   │─┘
              │  joins room as svc      │
              └────────┬────────────────┘
                       │
                       │ Disk read (RPC payload < 15 KB)
                       ▼
              recordings/<session>/turn_NN.wav
              (real human bad pronunciation)
```

## How the audio path is "faked" — important to understand

The agent's `injectTurnForTesting` does what `onUserTurnCompleted` does
during a real PTT turn:

| Real turn                          | Injected turn                              |
| ---------------------------------- | ------------------------------------------ |
| Browser captures PTT audio         | (skipped — no mic)                         |
| LiveKit ships Opus frames          | (skipped)                                  |
| Agent's STT decodes → text         | Caller provides text directly              |
| `flushTurnFrames()` → PcmChunk[]   | `wavToChunk(wav)` from disk                |
| `ctx.fullTranscript.push(...)`     | same                                       |
| `kickOffDifficultyEval()`          | same                                       |
| `kickOffPronunciationAssessment()` | same — runs assessor on the disk WAV       |
| (STT publishes transcript segment) | `publishData('dev_inject_bubble', ...)`    |
| `session` auto-replies after commit| `session.generateReply({ userInput })`     |

The assessor sees the **same WAV bytes** a live mic would have produced
(because it's a real recording from a live session). So scoring is honest;
this isn't a test fixture you can game.

## Gotchas you will hit (and what to do)

### LiveKit RPC payloads max out around 15 KB

So you cannot ship the WAV inline through the RPC. Current solution: pass
an absolute filesystem path, agent reads it. Fine because everything is
local. If you ever need cross-machine injection, push the WAV to a shared
blob (S3, etc.) and pass the URL, or chunk it through `publishData`.

### `lp.publishTranscription` panics on empty trackSid

The rtc-node FFI's `publishTranscription` Rust-panics if `trackSid` is `''`,
killing the whole agent process. **Don't go down this road** — use the
existing `dev_inject_bubble` data-channel topic instead. Session.tsx's
handler at the `dev_inject_bubble` topic renders a bubble exactly like a
real learner transcription would.

### Headless Chromium has no microphone

Session.tsx calls `setMicrophoneEnabled(true)` on connect; without fake
media flags the page shows "Mic error: Not supported" and never joins the
room. The visual harness already passes
`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. If you
spin up Playwright in a different script, copy those flags.

### "Mic error" / `ERR_INSUFFICIENT_RESOURCES` storms

That's Chromium failing on `getUserMedia` and the SPA spamming retries.
99% of the time the fix is the fake media flags above. The other 1% is the
seeded learner not existing in Postgres — that triggers a 404 polling loop.

### Use a real seeded learner id, not a fake one

`screenshot.mjs` uses `00000000-0000-0000-0000-000000000aaa` (a fake id
that never resolves). That works for routes that don't talk to `/api`. The
session page does — pick a learner that actually exists. The visual
harness defaults to `00000000-0000-0000-0000-000000000002` (the seeded
"hiking+cooking" learner from `test-evolution.ts`). Override via
`HABLA_TEST_LEARNER_ID=...`.

### The dev stack might be on :5173 (Vite) OR :3000 (prod-bundle Express)

Both modes work; visual harness auto-detects on preflight. Vite gives hot
reload; Express serves the built `web/dist`. If you edit web files and
forget to rebuild, your changes won't be visible in :3000 mode —
`npm run build --prefix web`.

### tsx watch picks up file edits, but not env-var changes

`HABLA_DEV_INJECT=1` is read once at process startup. If you flip it on,
restart `npm run dev`. The tsx watcher's auto-reload re-runs `import` but
preserves `process.env` from the parent shell — so it'll still see whatever
was there when concurrently spawned it.

### React coalesces same-role bubble chunks

A "tutor turn count" increment fires per-bubble, not per-reply. If the
greeting and a reply land back-to-back, they merge into one bubble and
counters don't advance the way you'd expect. The visual harness already
handles this by waiting for `agent.state === 'listening'` (Sofía finished
talking) instead of "new tutor turn appeared."

### Multiple dev-stack instances fight over :3000

If you `npm run dev` twice (e.g. across worktrees), `tsx watch` happily
runs N watchers and only one wins the port. Symptoms: server seems dead,
then alive, then dead, with no clean error. `netstat -ano | grep :3000` to
find the survivor; kill the duplicate tsx watchers.

## How to extend

### Add a new bad-pronunciation case

1. Record yourself (or anyone) saying the bad version once, with
   `RECORD_TURNS=1` in `.env`. The agent dumps each turn to
   `recordings/<sessionId>/turn_NN.{wav,json}` plus updates
   `recordings/index.jsonl`.
2. Pick one that flagged the words you want; copy its path.
3. Add a `CASES` entry to both `test-bad-pronunciation.ts` AND
   `test-visual-bad-pronunciation.mjs`. Keep them aligned — the backend
   harness is the cheap pre-check, the visual harness is the gold standard.

### Test multi-turn flows

The current visual harness drives one session with N injected turns. The
agent state machine handles them in sequence (each waits for the previous
to finish). Add the turns as additional `CASES` array entries or refactor
to a single test with N turns. The session is preserved across cases as
long as you don't reload the page.

### Test the *good* pronunciation path

Same scaffolding works in reverse: feed a recording with high scores
(e.g. `recordings/0e348b5b-.../turn_002.wav` — pron 87) and assert the
prompt does NOT contain a `Pronunciation flags` section, Sofía does not
model anything back, and the citation shows score >85.

### Add audio-side coverage if/when the synth-audio LiveKit path gets fixed

The pieces are already there. `scripts/scenario-harness.ts` synthesizes via
Cartesia/OpenAI and publishes to LiveKit. The block is on the Deepgram-
via-Opus side, not on us. If a future LiveKit Agents release lets us push
PCM directly to STT (bypassing track encode/decode), or if Deepgram fixes
its synth-speech VAD, that harness becomes the audio-pipeline test. Until
then, treat `test-visual-bad-pronunciation` as the audio test — it uses
**real** captured audio, just not via the LiveKit room.

## Hidden levers worth knowing about

| Env var                    | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `HABLA_DEV_INJECT=1`       | Enables `/api/dev/inject-turn` + agent's `dev_inject_turn` RPC |
| `RECORD_TURNS=1`           | Agent dumps every PTT turn to `recordings/<session>/`. Grows fast on long sessions; rotate. |
| `HABLA_TEST_LEARNER_ID`    | Visual harness reads this for the seeded learner id   |
| `HABLA_BASE_URL`           | Override web app URL (default auto-detects :5173 or :3000) |
| `HABLA_API_URL`            | Override token-server URL (default :3000)             |
| `HEADED=1`                 | Visual harness shows the browser                      |
| `SCENARIO_LEARNER_TTS=openai` | scenario-harness.ts only — force OpenAI TTS when Cartesia credits are out |

## Wired-together "full test" recipe

For a regression-style sweep before any non-trivial change:

```bash
# Smoke
npx tsx scripts/scenario-harness-direct.ts        # ~17s — conversation sanity
npm run test-bad-pron                              # ~30s — pron-feedback sanity

# Visual
HEADED=1 npm run test-visual-bad-pron              # ~3 min — visual regression
```

If all three pass, you have high confidence in: conversation logic,
difficulty controller, prompt evolution, FSRS compaction, pronunciation
assessor, prompt-builder pronunciation section, gpt‑4o feedback behavior,
LiveKit transport, agent-worker RPC plumbing, data-channel topics, and the
React rendering of bubbles + inline citations + summary scores.

The only thing left untested is the actual live STT path. Live-test that
manually with a real mic if it's load-bearing for the change.

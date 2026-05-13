# Phase 11 — End-to-End Test Plan

Goal: take the prototype + Phase 6/7 work from "builds clean" to "verified working in a real browser session against live providers." Layered so failures localize: each layer's tests presuppose every layer below it is green.

---

## Stack under test

```
Browser (web/)
  ↓ WebRTC
LiveKit Cloud (lingua-ghti7l62.livekit.cloud, US West B)
  ↓ jobs
Agent worker (src/agent.ts, npm run agent dev)
  ├─ Deepgram Nova-3 (STT, multi)
  ├─ OpenAI gpt-4o (LLM)
  ├─ Cartesia Sonic-3 (TTS, es)
  ├─ Anthropic Claude Haiku (difficulty controller)
  ├─ Anthropic Claude Sonnet (compaction)
  └─ Azure Speech (pronunciation, es-MX)
Postgres (DATABASE_URL)
  ├─ learners
  ├─ sessions
  └─ fsrs_cards
Token server (src/token-server.ts, npm run server)
  ├─ static web/
  └─ /api/token
```

Process layout when running: two long-lived processes (`server`, `agent dev`) plus one browser tab.

---

## Layer 0 — Build & type checks

```bash
npm run build
```

Pass criteria: `tsc` exits 0, `dist/` populated with `agent.js`, `compaction.js`, `pronunciation/*.js`, etc. No new TS errors introduced by Phase 6/7 code.

Already verified: ✅

---

## Layer 1 — Unit/contract tests

Each script is fully self-contained, exits 0 on success, and tests one module in isolation. Run them in this order; later layers presuppose earlier layers are green.

| Script | What it covers | Live deps |
|---|---|---|
| `npx tsx scripts/test-wav.ts` | RIFF/WAVE header, PCM round-trip, multi-chunk concat, duration math | none |
| `npx tsx scripts/test-pronunciation-pipeline.ts` | Assessor factory, NoOp shape, `formatAnnotation` thresholding, error paths for Azure/SpeechAce constructors | none |
| `npx tsx scripts/test-prompt-builder.ts` | System prompt assembly with controller state + pronunciation annotations | none |
| `npx tsx scripts/test-difficulty-controller.ts` | Per-turn delta classification (coasting / edge / overwhelmed scenarios) | Anthropic |
| `npx tsx scripts/test-difficulty-drift.ts` | Multi-turn ratio drift bounds (±0.05/turn cap, hold within [0,1]) | Anthropic |
| `npx tsx scripts/test-controller-compaction-handoff.ts` | Controller deltas survive compaction handoff into next session | Anthropic |
| `npx tsx scripts/test-compaction.ts` | Synthetic session → Sonnet compaction → core diff + FSRS updates | Anthropic |
| `npx tsx scripts/test-evolution.ts` | Multi-session evolution of cores | Anthropic + Postgres |
| `npx tsx scripts/test-dynamic-session.ts` | End-to-end dynamic prompt rebuild loop without LiveKit | Anthropic |

Pass criteria: every script prints `RESULT: N passed, 0 failed` and exits 0.

---

## Layer 2 — Pre-flight (live providers reachable)

```bash
npx tsx scripts/test-preflight.ts
```

Validates env vars, Postgres connection + schema + learner row, LiveKit URL reachability, Azure token issuance. **Do not proceed if any check fails** — every later layer assumes these are green.

Already verified: ✅ (19/19 passed)

---

## Layer 3 — Live Azure pronunciation pipeline

```bash
npx tsx scripts/test-azure-assess-live.ts
```

Synthesizes a Spanish phrase via Cartesia at 16 kHz mono PCM, wraps as WAV, hands to `AzureAssessor.assess()` with `language: 'es-MX'`. Verifies provider name, recognized text non-empty, overall accuracy ≥80, word count matches, every word has phoneme-level scores, latency <10s.

Already verified: ✅ (7/7 passed; accuracy 96.0, latency ~1.2s)

**Caveat**: TTS audio is "perfect" — high scores prove the pipeline is wired, not that Azure is sensitive to learner errors. Real sensitivity test happens in Layer 5 with a human speaker.

**Known issue**: Azure returns empty phoneme symbol labels (only scores) for `es-MX`. Tracked but not blocking — scores alone are actionable for Sofía's response.

---

## Layer 4 — Stack bring-up smoke

Two terminals (or background jobs):

```bash
# T1
npm run server      # listens :3000, serves web/, exposes /api/token

# T2
npm run agent dev   # registers as worker with LiveKit Cloud
```

### Pass criteria
- T1 logs `Token server running on http://localhost:3000` and `LiveKit URL: wss://lingua-ghti7l62.livekit.cloud`
- T2 logs `registered worker` with a non-empty `id` and a `server_info.region`
- `curl -s http://localhost:3000/api/token | jq -e '.token and .url'` exits 0
- No errors in either log over 30s of idle

Already verified: ✅ (token server returns valid JWT; agent registered as `AW_XE4tPwUfbjfT` in `US West B`)

### Known fix recipe
- **Missing native binding** (`@livekit/rtc-ffi-bindings-win32-x64-msvc`): `npm install @livekit/rtc-ffi-bindings-<platform>-<arch>-<abi>@<rtc-ffi-bindings version> --no-save`. Already applied for win32-x64.

---

## Layer 5 — Manual end-to-end browser session

This is the only layer that requires a human. Cannot be automated without a real microphone and a Spanish speaker.

### Setup
1. Both processes from Layer 4 still running.
2. Open `http://localhost:3000/` in Chrome (mic permission must be granted; Safari has WebRTC quirks worth re-testing later).
3. Open DevTools → Console. Keep an eye on the agent worker log too.

### Protocol — Session 1 (cold start)
1. **Connect**: click "Connect". Verify:
   - Web UI status changes to "Connected"
   - Agent log: `Sofia is ready and waiting for a learner.`
   - Sofía produces an audible Spanish greeting within ~3s
   - Debug panel populates: `pronunciation.provider = "azure"`, controller state visible, FSRS due items list
2. **Three pronunciation turns**: hold push-to-talk, say each in turn (release between):
   - `"Hola, me llamo [your name]"`
   - `"Tengo treinta años y vivo en Estados Unidos"`
   - `"Quiero aprender español para viajar a México"`
3. **Per turn, verify**:
   - Web UI shows your transcript line within ~1.5s of release
   - Sofía replies in mixed Spanish/English (initial bilingual_ratio ≈ 0.85 for A1)
   - Agent log shows `[pronunciation] turn N (X.XXs) via azure: accuracy=NN pronunciation=NN` within ~2s of turn end
   - Debug panel `pronunciation.recent` array grows; latest entry has `overall.accuracy` between 50–95 (real human speech, not 100)
   - If any word scored <70: `flagged_words` array is non-empty
4. **Two more freeform turns** (whatever feels natural). Check:
   - Controller `bilingual_ratio_target` shifts based on perceived hesitation/fluency
   - On turn 5: an `[difficulty] eval cycle for turn 5 done` line containing `edge_check=true`
5. **End & Compact**: click button. Verify:
   - Returns within ~30s
   - Pre/post core diff shown in UI
   - `learner_core.session_trajectory` includes a new entry referencing this session
   - `fsrsCreated`/`fsrsRated` counts ≥0 and consistent with what was discussed
6. **DB inspection**:
   ```sql
   SELECT id, ended_at, jsonb_pretty(post_cores) FROM sessions ORDER BY started_at DESC LIMIT 1;
   SELECT count(*) FROM fsrs_cards WHERE learner_id = '<LEARNER_ID>';
   ```

### Protocol — Session 2 (continuity check)
1. Refresh the page. Click Connect again.
2. **Verify continuity**:
   - Sofía's greeting references something concrete from session 1 (a topic, a name, a phrase). Not generic.
   - Debug panel `learnerCore.version` incremented from session 1.
   - First turn's `bilingual_ratio_target` reflects the post-compaction value, not the seed.
3. Run 2–3 more turns, then End & Compact. Confirm `version` increments again.

### Pass criteria
- All bullets above check out without intervention
- No error lines in agent log for the entire 5-turn arc
- Total cost (estimate from per-call latency × pricing): under $0.30 for a 10-min session

### Failure modes to watch for
| Symptom | Likely cause | Fix |
|---|---|---|
| Sofía never speaks | Cartesia key invalid or voice ID rejected | check agent log for Cartesia 4xx |
| Transcript stuck mid-sentence | Deepgram dropped connection | check Nova-3 plan / restart agent |
| `[pronunciation] assessment cycle failed` | Audio under 0.3s, or Azure quota / region issue | check `wav` length, re-run Layer 3 |
| Compaction returns `ok: false` | Sonnet quota or transcript too short | inspect `error` field in response |
| All controller deltas = 0 | Haiku timing out (single-flight skip cascading) | check Anthropic API status, increase timeout |
| `learnerCore.version` stuck at 0 | DB write failed silently in compaction | check `runCompaction` error path + Postgres logs |

---

## Layer 6 — Five-day learner arc (Phase 10 deliverable)

Out of scope for Phase 11; this layer is the actual Phase 10 protocol from the v2 plan: one session per day for a week with a real A1–A2 learner. Do not start it until Layers 0–5 are reliably green and Phase 8 (onboarding) lands. Run Layer 5 first as a single-session smoke before scheduling a real arc.

---

## Quick-reference command list

```bash
# All layers, in order:
npm run build
npx tsx scripts/test-wav.ts
npx tsx scripts/test-pronunciation-pipeline.ts
npx tsx scripts/test-prompt-builder.ts
npx tsx scripts/test-difficulty-controller.ts
npx tsx scripts/test-difficulty-drift.ts
npx tsx scripts/test-controller-compaction-handoff.ts
npx tsx scripts/test-compaction.ts
npx tsx scripts/test-evolution.ts
npx tsx scripts/test-dynamic-session.ts
npx tsx scripts/test-preflight.ts
npx tsx scripts/test-azure-assess-live.ts
npm run server &
npm run agent dev &
# then browser at http://localhost:3000/
```

## Current state

Layers 0–4 verified green at the time of writing. Layer 5 awaits a human session. Layer 6 awaits Phase 8 onboarding work and is out of scope here.

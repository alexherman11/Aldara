# Phase 13 — Resilient Pronunciation Pipeline (Shipped)

What's running, where to look, and what to do next.

## Current state

The live agent uses **`PRONUNCIATION_PROVIDER=segmented`** — Deepgram nova-3 transcribes a turn with per-word timestamps, the segmenter splits it into language-tagged phrases at silence/language boundaries, and Azure scores only the Spanish phrases against their own transcripts. English portions reach the UI as plain text. Worker `AW_*` is registered, idle, ready.

Recording is on (`RECORD_TURNS=1`). Each PTT cycle writes `recordings/<sessionId>/turn_NNN.wav` plus a sidecar JSON with the Deepgram transcript and Azure baseline. The recordings directory has been cleared of pre-fix data — anything captured from here on is good.

## How to use

1. **Hard reload** http://localhost:3000 (Ctrl+Shift+R)
2. Click Connect → PTT-talk naturally → release
3. Each turn auto-saves to `recordings/<id>/`
4. Repeat for 3–5 conversations of a few minutes each

Speak however you naturally do — long pauses, English fallback, hesitation, all fine. The pipeline only scores the Spanish parts.

## Offline tuning loop

Once you have recordings:

```bash
# Compare current baseline vs segmented across every recording:
npx tsx scripts/replay-recording.ts recordings/

# Replay just one session:
npx tsx scripts/replay-recording.ts recordings/<sessionId>/

# Run the scenario regression suite (synthesized cases):
npx tsx scripts/test-segmented-scenarios.ts

# Verify segmenter logic in isolation:
npx tsx scripts/test-segmenter.ts
```

`replay-recording.ts` runs both pipelines on each recording and prints a side-by-side comparison: per-turn deltas, aggregate stats (improved / similar / regressed buckets), full results JSON.

## Code map

| Path | What |
|---|---|
| [src/stt/types.ts](src/stt/types.ts) | Transcriber interface, language tags |
| [src/stt/deepgram-stt.ts](src/stt/deepgram-stt.ts) | Deepgram nova-3 REST adapter (used in offline pipeline) |
| [src/stt/openai-stt.ts](src/stt/openai-stt.ts) | OpenAI whisper-1 (fallback; back-translates English→Spanish so not preferred) |
| [src/segmenter.ts](src/segmenter.ts) | Phrase segmentation by silence + language. Lexicon + smoothing. |
| [src/pronunciation/segmented-scorer.ts](src/pronunciation/segmented-scorer.ts) | STT → segmenter → per-phrase Azure → aggregate |
| [src/pronunciation/segmented-assessor.ts](src/pronunciation/segmented-assessor.ts) | PronunciationAssessor adapter so live agent uses it transparently |
| [src/agent.ts](src/agent.ts) | Live agent. PTT-gated audio capture, recording, RPC handlers. |

## Test coverage

| Script | What | Status |
|---|---|---|
| `test-wav.ts` | WAV writer | 19/19 |
| `test-pronunciation-pipeline.ts` | Assessor factory, formatAnnotation, error paths | 20/20 |
| `test-azure-assess-live.ts` | Single-utterance Azure pipeline (TTS audio) | 7/7 |
| `test-pronunciation-stress.ts` | Cross-voice, L1-influenced, edge cases, concurrency | 9/10 (1 synthesis-artifact miss) |
| `test-pronunciation-stress-v2.ts` | Multi-voice Cartesia + OpenAI, noise, sample rate | 39-point sensitivity gap measured |
| `test-segmenter.ts` | Phrase segmentation logic | 21/21 |
| `test-segmented-pipeline.ts` | E2E Deepgram→segmenter→Azure on synthetic mixed audio | 6/6 |
| `test-segmented-scenarios.ts` | 5 realistic L2 scenarios via Cartesia synthesis | 11/13 |
| `test-prompt-builder.ts` | Inline annotation prompt construction | 12/12 |
| `test-long-session-stress.ts` | 91 turns across 3 compactions, continuity verification | All checks pass |
| `test-preflight.ts` | Env vars, Postgres, LiveKit, Azure | 19/19 |

## Known issues to watch for when real recordings arrive

1. **Synthesized English-via-Spanish-voice merges into Spanish phrases** — the `spanish-with-english-fallback` scenario failed because Cartesia's Spanish-trained voice reading English produces audio Deepgram tags as Spanish. Real human English should be cleaner. If real recordings still show this, the lexicon classifier needs more weight relative to Deepgram's tag.
2. **Empty phoneme labels from Azure for `es-MX`** — scores are returned but the phoneme symbols are missing strings. `formatAnnotation` falls back gracefully (renders score only without phoneme arrow) but the planned post-session pronunciation report needs the symbols. Workaround unclear — may need Azure support contact or `es-ES` instead of `es-MX`.
3. **Proper nouns persistently score low** ("Carlos", "Madrid" both 32–69 even on native Cartesia voices). Azure's phoneme model probably handles capitalized tokens differently. Currently shows up as red tints on names which is misleading. Filter unclear — best to surface in real-recording analysis, then decide whether to suppress.
4. **Compaction takes ~30s/turn** — acceptable but worth measuring against real Phase 13 cores once we have sessions.

## What's NOT shipped yet

| Feature | Why deferred |
|---|---|
| Drill mode (Sofía pins target phrase for next assessment) | Phase 14 — was waiting on the open-conversation case working first |
| Per-word Deepgram alternates surfaced to Sofía prompt | Phase 13.2b — segmented pipeline addresses most of the underlying need by getting cleaner Spanish-only references |
| Streaming Azure during PTT (no gate) | Phase 13.5 — the segmented pipeline restructured the problem; streaming would be ~300ms faster but isn't the bottleneck |
| Post-session pronunciation report | Phase 14 — depends on accumulated per-phoneme history which only exists with real recordings |

## Open questions when you're back

- Do real recordings reproduce the synthesized-English fallback issue? (Run replay first to find out.)
- Should the green stretch highlighting be tied to FSRS due-items only, or also to a static A1/A2 vocabulary list?
- Is 30s compaction latency acceptable, or should we move it to a background job after session end?

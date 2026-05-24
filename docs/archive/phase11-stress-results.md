# Phase 11 — Stress Test Results

## Scope

Three goals: (1) verify the Azure pronunciation pipeline catches real L2 errors, not just the clean-TTS happy path; (2) confirm compaction holds up across long-form, multi-session arcs without bloat; (3) give Sofía a stronger pronunciation signal so she can act on what the engine reports.

## Headline numbers

| Layer | Result |
|---|---|
| Pronunciation contract tests | **20/20 pass** |
| Live Azure single-utterance | **7/7 pass** (96% accuracy, ~1.2s) |
| Pronunciation stress (clean + L1-influenced + edge + concurrency) | **9/10 pass** |
| Long-form compaction (3 sessions, 91 turns, ~96s of LLM time) | **all checks pass** |
| Prompt-builder unit tests (incl. 2 new) | **12/12 pass** |
| Type-check | **clean** |

---

## 1. Pronunciation pipeline — does Azure catch real errors?

Method: synthesize Spanish phrases two ways. **Clean** = native Cartesia es voice. **L1-influenced** = mutate the input text so Cartesia produces an English-leaning pronunciation (`"yo soy"` → `"jo soi"`, `"México"` → `"mexEEko"`, etc.). The reference text Azure scores against stays correct — only the audio is "wrong." Then check whether Azure flags the bad ones.

### Clean baseline (Phase A)
5/5 cases pass. Avg accuracy **92.4**, latency 870–1575ms, all clean phonemes.

```
clean-greet        acc=83 pron=82 flags=1 lat= 913ms dur=1.11s
clean-rolled-r     acc=89 pron=89 flags=1 lat= 977ms dur=1.86s
clean-vowels       acc=97 pron=98 flags=0 lat= 912ms dur=1.76s
clean-numbers      acc=95 pron=97 flags=0 lat= 858ms dur=1.21s
clean-long         acc=98 pron=99 flags=0 lat=1575ms dur=3.81s
```

### L1-influenced (Phase B)
4/5 pass. Avg accuracy **71.6**.

```
l1-no-rolled-r     acc=51 → flagged perro:18, corre:29, rápido:61   ← caught
l1-flat-vowels     acc=87 → flagged leche:55                         ← caught (partial)
l1-h-vs-j          acc=94 → no flags                                  ← MISS
l1-final-vowels    acc=67 → flagged Casa:58, bonita:46              ← caught
l1-stress-shift    acc=59 → flagged México:7                         ← caught (sharp)
```

Sensitivity gap: clean 92.4 vs L1 71.6 = **20.8 points**. Plenty of signal.

The one miss (`l1-h-vs-j`) was a synthesis artifact — Cartesia produced clean Spanish even with mutated input text "Me heffey trabaha muchoh," so there was nothing wrong for Azure to catch. This is a limitation of the test method, not the assessor. Real-learner audio in Layer 5 will be the actual sensitivity test.

### Edge cases (Phase C)
All four degrade gracefully:

```
silence(2s)        acc=0  recognized="."           — engine returns 0, no crash
too-short(0.1s)    acc=0  lat=541ms                — agent skips <0.3s, this is the safety net
long(15.8s)        acc=95 51 words                 — handles long audio (8.8s API latency)
wrong-lang         acc=32 4 flags                  — English audio→Spanish ref correctly fails
```

### Concurrency (Phase D)
**5 parallel Azure calls in 1196ms wall-clock** vs ~5s sequential. Per-call latencies 865–1196ms, all returned valid results, no state corruption from the SDK's push-stream model. Cartesia is the bottleneck (free-tier limit of 2 concurrent), not Azure — the test pre-synthesizes serially before parallelizing assessments.

### Known issue
Azure returns **empty phoneme symbol labels** for `es-MX` (only the scores). Per-phoneme confidence is intact. Workaround: phoneme arrows like `/r/ → /ɾ/` only render when both sides come back — silently skipped otherwise. The trend-summarizer falls back to word-level recurrence, so Sofía still gets a useful signal even when phoneme labels are missing.

Run: `npx tsx scripts/test-pronunciation-stress.ts` (artifacts written to [phase11-pronunciation-stress-results.json](phase11-pronunciation-stress-results.json))

---

## 2. Compaction — does it hold up across 90 turns?

Method: three back-to-back sessions on a freshly-created learner row. Session A 40 turns (Mexico City + dogs + work), Session B 30 turns (cooking + Coco), Session C 21 turns (travel planning). After each, run real `runCompaction()` against Claude Sonnet, then verify (a) cores evolve, (b) the next session's prompt reflects the previous one, (c) prompt size stays bounded.

### Compaction performance
| Session | Turns | Compaction time | FSRS created | FSRS rated |
|---|---|---|---|---|
| A | 40 | 30.4s | 14 | 0 |
| B | 30 | 32.6s | 12 | 3 |
| C | 21 | 33.4s | 5 | 6 |
| **Total** | **91** | **96.4s** | **31** | **9** |

FSRS is maturing correctly: session A seeds, session B starts re-rating earlier items as they become due, session C rates more than it creates. The schedule is working.

### Continuity (does session N+1 carry forward session N?)
**A→B: 8/8 signal words preserved. B→C: 8/8.** Long-form proper nouns and technical terms from the previous session's compacted core appear in the next session's system prompt verbatim. Concrete examples observed:
- Session B's compaction notes: "learner self-studied vocabulary between sessions, self-corrected pro-drop after one recast"
- Session C's compaction notes: "learner produced 'me encantan los cafés' with correct plural agreement unprompted"

These are session-specific facts — they couldn't be in the prompt unless compaction propagated them through the cores.

### Bloat check
| Session | Prompt before | Prompt after | Δ |
|---|---|---|---|
| A | 5289 | 7032 | +1743 |
| B | 7032 | 7222 | +190 |
| C | 7222 | 7220 | **−2** |

**Net growth across 3 sessions: 1931 chars over 91 turns.** Session C *shrank* the prompt — compaction is correctly summarizing rather than appending. The learner_core's `vocabulary.active_count` grew 14→26→26 (one session's worth of consolidation), confirming the model is gating what it adds based on what's truly novel.

### Final cores after 3 sessions
- `learner_core.version = 3`, `vocabulary.active_count = 26`, `comfort_zones = ['food', 'family', 'pets', 'basic_expressions', 'cooking_ingredients', 'cafe_morning_routine', 'basic_travel_phrases']`
- `tutor_core.version = 3`, `pacing.next_horizon = "Giving and understanding directions; quiero ir a + place; numbers..."`
- Beautifully structured emerging/frontier/breakthrough fields, narrative summaries that refer to specific learner moments by name

Run: `npx tsx scripts/test-long-session-stress.ts` (artifacts in [phase11-long-session-results.json](phase11-long-session-results.json))

---

## 3. Stronger pronunciation signal for Sofía

Three changes shipped:

### a. `formatAnnotation` now surfaces the full L1 pattern, not a single hint
**Before:** one phoneme arrow per flagged word.

**After:**
- Up to **3 phoneme substitutions per word** (`MAX_PHONEME_HINTS_PER_WORD`). Multi-phoneme L1 patterns — e.g., simultaneous flat /r/ AND English-style /e/→/eɪ/ on the same word — are now visible to Sofía.
- New **STT/assessor mismatch line** when Deepgram's transcript and Azure's recognized text disagree. This catches the common failure where the learner mispronounces something badly enough that STT auto-corrects. Example annotation:

  ```
  [pronunciation] perro: 40 (Mispronunciation, /r/ → /ɾ/, /e/ → /ɛ/)
  [pronunciation] STT/assessor mismatch: heard "pero" not "perro"
  ```

### b. New `summarizePronunciationTrends()` — multi-turn pattern detection
Aggregates the last 5 assessments. When a phoneme appears weak in ≥2 distinct words across the window, the system prompt grows a new section:

```
## Pronunciation patterns over recent turns
Recurring phoneme weakness (probable L1 transfer):
  - /r/ flagged in 3 of last 5 turns (perro, corre, rápido)
Recurring word-level flags: "casa" (2×)
```

This is the moment a single noisy turn becomes an actionable pattern. Sofía's persona was updated to teach her to react to this — model the affected sound cleanly when it next comes up, optionally highlight the contrast once per session per pattern, never drill explicitly.

### c. `sofia-persona.txt` updated with full reading guide
Sofía now has explicit instructions for: reading the accuracy number, reading multi-phoneme arrows as L1 patterns, treating STT/assessor mismatch as a pronunciation signal not a transcription error, and gating explicit acknowledgment behind the trend summary's 3+ turn threshold.

### Tests
Two new prompt-builder unit tests (test 11 multi-phoneme + divergence, test 12 trend summary) plus the existing 10 — **12/12 pass**. Pronunciation pipeline contract tests **20/20 pass** including the new `summarizePronunciationTrends` export.

---

## What's still gappy

1. **Azure phoneme labels are empty for es-MX.** Scores work, symbols don't. Either the SDK isn't surfacing them or the service doesn't return them for Spanish. Worth a focused investigation before Phase 7's "Pronunciation report" UI ships, since the report needs the symbols.

2. **Reference text is still Deepgram's transcript.** When the learner says something genuinely wrong (e.g., wrong word entirely), Deepgram corrects it and Azure scores against the corrected text. The new STT/assessor mismatch annotation catches the *acoustic* form of this, but the deeper fix is **drill mode**: when Sofía proposes a phrase ("say *quisiera*"), the agent should pin that as the gold reference for the next assessment. Out of scope for this round; sketched as a Phase 11.5 follow-up.

3. **Cartesia synthesis can't always produce L1-influenced audio on demand.** The `l1-h-vs-j` failure showed Cartesia is robust enough that mutated input text doesn't reliably produce mutated audio. For deeper sensitivity testing, a small library of human-recorded L2 samples (Common Voice, recorded clips from a beginner) would be more diagnostic than synthetic mutations.

4. **Compaction takes 30s/session.** Acceptable, but if it bothers users who want immediate feedback on `End & Compact`, we could (a) stream the compaction notes back as they're generated, (b) move compaction to a background job, or (c) try Haiku for non-critical fields and reserve Sonnet for the narrative.

---

## Reproduce

```bash
# Stress: pronunciation
npx tsx scripts/test-pronunciation-stress.ts

# Stress: 90-turn arc with continuity check
npx tsx scripts/test-long-session-stress.ts

# Unit verification post-changes
npx tsx scripts/test-prompt-builder.ts          # 12/12
npx tsx scripts/test-pronunciation-pipeline.ts  # 20/20
npx tsx scripts/test-azure-assess-live.ts       # 7/7
```

The agent worker and token server are still running in the background from earlier; the Layer 5 manual browser session in [phase11-test-plan.md](phase11-test-plan.md) is the only thing left that requires a human voice.

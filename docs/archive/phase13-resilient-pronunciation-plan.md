# Phase 13 — Pronunciation Feedback Under Realistic Learner Speech

## The problem your session exposed

You spoke the way an actual A1–A2 learner speaks:
- 30+ second PTT presses with long thinking pauses
- Mid-sentence falls back to English ("but I don't know", "I feel a bit")
- Self-corrections, restarts, hesitation
- A few real Spanish phrases mixed in: "Sí, me gusta aprender", "me asombra el sol"

The current pipeline scored these turns at **acc=0–4**. Not because the Spanish parts were bad — but because Azure was asked to forced-align 30 seconds of mixed-language audio against a reference text that contained English words and Deepgram misreads. Garbage reference + garbage timing → garbage score, even when the Spanish itself was fine.

This is not a tuning problem. It's an architectural mismatch. The current design assumes "one PTT press = one clean monolingual utterance." Real learners don't behave that way, and we shouldn't force them to.

## What needs to change

Three structural changes, in order of leverage:

### 1. Replace Deepgram with a multilingual ASR that handles code-switching natively

Looking at the actual Deepgram output from your session:
- `"Las Polebras"` (probably "las palabras")
- `"Necesito a brand there"` (probably "necesito aprender")
- `"asombra das cosas"` (probably "asombran las cosas")

Deepgram's `nova-3` with `language: multi` accepts multilingual input but it's optimized for cleanly-spoken speech and tends to "lock in" to one language once it commits. For L2 learners with imperfect Spanish phonetics, those misreads above will keep happening — and every misread becomes a wrong reference text fed to Azure.

**Better options for this use case:**

| Service | Spanish + code-switch | Per-word timestamps | Per-word confidence | Streaming | Notes |
|---|---|---|---|---|---|
| **`gpt-4o-transcribe`** (OpenAI) | Excellent | Yes (segments) | No | Limited | Best at messy multilingual L2 audio. Tradeoff: streaming is rough, latency-after-PTT can be 1–2s. |
| **`whisper-1`** (OpenAI) | Very good | Yes (`word_timestamps` param) | No | No | Reliable, well-understood. Worse than gpt-4o-transcribe on edge cases. |
| **Azure Speech STT** | Good (es-MX or `auto-detect`) | Yes | Yes (`format: detailed`) | Yes | Same vendor as our pronunciation engine — could simplify auth + pricing. |
| **Speechmatics** | Excellent, with per-word language tags | Yes | Yes | Yes | Most explicit bilingual support; not free-tier. |
| **Deepgram nova-3 (current)** | OK | Yes | Yes | Yes | Good for clean speech, weak on L2 imperfections. |

**Recommendation: `gpt-4o-transcribe` for v2.1**, with Whisper as fallback. Reasons:
- Already have OpenAI key wired up — zero new infra
- Best accuracy on messy L2 multilingual audio (validated in benchmarks)
- The 1–2s latency penalty is fine because we already need to *not* be on the critical path for first-token latency
- Streaming-rough is acceptable: we send the full PTT chunk on release, get the result back, then run pronunciation

### 2. Segment-aware pronunciation, not utterance-aware

Right now Azure receives `(audio_buffer, reference_text)` and is forced to score the whole thing as one unit. What it should receive: a series of `(audio_slice, spanish_phrase)` calls, one per Spanish phrase, with the English and silence portions excluded entirely.

**Pipeline:**

```
PTT audio (35s)
  ↓
ASR with word-level timestamps + language tags
  ↓ produces:
  [
    {text: "Sí me gusta aprender más", lang: "es", start: 0.5, end: 3.2},
    {text: "Sobre puedo hablar sobre mi día", lang: "es", start: 4.1, end: 7.8},
    {text: "but I don't know", lang: "en", start: 8.5, end: 10.2},
    {text: "Las palabras como", lang: "es", start: 10.8, end: 12.6},
    ...
  ]
  ↓
For each segment where lang == "es":
  audio_slice = audio_buffer[start..end]
  Azure.assess(audio_slice, reference_text=text, language=es-MX)
  ↓
Combine per-segment word scores into one annotated transcript
```

The English segments still appear in the transcript bubble (the learner did say them, that's pedagogically real) — but they have **no pronunciation annotation**, they're just rendered as neutral text. The Spanish segments get the gradient/bracket treatment Phase 12.1 already builds. Same UI, just per-segment scoring rather than per-utterance.

**Why this works for your specific failure cases:**

- "Sí, me gusta aprender más" → scored as one Spanish phrase, probably high accuracy
- "but I don't know" → not scored, just shown as plain text
- "Las palabras como" (if ASR catches the right words) → scored on the Spanish words specifically
- 35-second turn total → only the ~8 seconds of actual Spanish audio reach Azure

### 3. Per-word language detection inside `gpt-4o-transcribe` segments

`gpt-4o-transcribe` doesn't natively tag language per word in its current API — segments are the granularity. But within a segment we can detect mid-segment code-switches via a cheap second pass:

- For each ASR segment, run the segment text through a fast classifier (Anthropic Haiku or a tiny local model) asking: "which of these words are Spanish?"
- Skip segments that are >50% English
- For mixed segments, score only the Spanish-word subsequences

This is a small second LLM call per turn — ~200ms additional latency, well worth it for accuracy.

Cheaper alternative: a static Spanish stopword/lexicon match. Maintain a list of common Spanish words and check overlap. Works for the obvious cases ("hola", "me gusta", "casa") without an LLM call. Falls back to LLM for ambiguous segments.

## What you'll see different

After v2.1 ships:

```
Your turn (rendered on screen):

  "Sí, me gusta aprender más. Sobre puedo hablar sobre mi día, but I
   don't know las palabras como I don't even I feel a bit no sé."
   ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾  ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾  ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾
   pron score: 78           pron score: 82            pron score: 65
   (mild yellow tints)      (mild yellow tints)       (orange "como" 60)
                                                       
                            ↑ "but I don't know" rendered as neutral grey —
                              no pronunciation annotation. Just text.
```

The English portions are visible but unscored — they're part of the conversation but not part of the pronunciation evaluation. Spanish portions get word-level color tints exactly like Phase 12.1 already renders, just isolated to the parts that matter.

## What this costs

| Component | Marginal cost per 30s turn | vs current |
|---|---|---|
| ASR (gpt-4o-transcribe) | ~$0.0015 | vs Deepgram ~$0.0017 — about even |
| Language detection (Haiku) | ~$0.0005 | new |
| Azure pronunciation (only Spanish slices) | ~$0.001 | vs ~$0.0017 — slightly cheaper since we score less audio |
| Total per turn | ~$0.003 | vs ~$0.0035 — roughly the same |

No cost increase. Possibly a slight decrease since we're not paying for pronunciation assessment on English audio that produces useless scores.

## Implementation order

Each step verifiable before the next.

| Step | What | Verification |
|---|---|---|
| 13.0 | Today's UI polling fix + data-channel push for pronunciation updates | Annotations show on bubbles within 2s of PTT release. **In progress, ready to verify.** |
| 13.1 | Add gpt-4o-transcribe as alternate STT, toggleable via env var (`STT_PROVIDER=openai`) | Same turns transcribed with fewer Spanish misreads |
| 13.2 | Build segmenter: takes ASR result with timestamps, splits into language-tagged phrases | Unit test: a 30s mixed transcript produces correct phrase boundaries |
| 13.3 | Build slice-aware pronunciation: per-phrase audio slicing + Azure calls + aggregation | Test against the actual recording of your last session — should produce per-phrase scores instead of single 0 |
| 13.4 | UI: render per-segment with appropriate styling (Spanish = annotated, English = plain) | Visual verification in browser |
| 13.5 | (Optional) Haiku per-word language classifier as a fallback when segment boundaries are wrong | Better handling of code-switching within a single segment |

## What we're explicitly NOT doing

- **Forcing learners into a "speak only Spanish" mode.** That's not how learning works.
- **Penalizing pauses.** Thinking time is normal. The segmenter ignores silence > 200ms.
- **Discarding turns with English in them.** They're still part of the conversation; we just don't pronunciation-score the English.
- **Drill mode.** Still deferred to Phase 14 — the open-conversation case needs to work first.

---

## Right now: did the polling fix work?

Your previous session is still alive. Two ways to verify Phase 12.1's annotations actually render:

1. **Click "Refresh Debug"** on your current page. The three assessments in agent memory will fetch, `annotateLearnerBubbles` runs, transcript bubbles light up red.
2. **Start a fresh PTT cycle** (Sofía finishes → press PTT → say something short → release). The new polling fires at 400, 1500, 3500, 6000ms so it'll definitely catch the assessment.

If you see the annotations even on the bad turns: Phase 12.1 wiring is correct, just was racing the polling. If you still see nothing after Refresh Debug, there's a deeper bug I need to find.

Either way, I'd like to get this plan locked in before I start coding 13.0–13.5, since it's a meaningful pivot. Specific things worth your input:

1. **STT switch**: gpt-4o-transcribe (recommended) vs keep Deepgram vs try Speechmatics?
2. **Segmenter granularity**: phrase-level (cheap, simple) vs word-level (expensive, more accurate)?
3. **English-portion display**: render as plain text, or hide entirely?
4. **Audio retention**: do we need to keep PTT recordings on the server for re-scoring with new models, or one-shot?

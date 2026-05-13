# Habla v2 — From Prototype to Something Special

## Goal

The prototype proved the loop works (voice in/out, dynamic prompting, compaction-based continuity, FSRS weaving). v2 is about making it *feel* right. Less robotic, more pedagogically sharp, more honest about what the learner actually said. The bar: an A1 learner finishes a 10-minute session feeling like they had a real conversation with a tutor who *gets them* — not a chatbot wearing a tutor costume.

**Out of scope for v2**: mobile app, multi-language pairs beyond Spanish↔English, classroom/teacher dashboards, monetization. Still validating the core experience.

---

## Guiding principles for v2

1. **Latency is character.** Every 200ms shaved off response time makes the tutor feel more present. Treat latency budgets as design constraints, not aspirations.
2. **The transcript is sacred.** If we mishear what the learner said, every downstream system (compaction, FSRS, feedback) inherits the error. Errors in learner speech are *signal*, not noise to clean up.
3. **Pedagogy beats personality.** A warm tutor who teaches badly fails. A slightly cooler tutor who pushes the learner exactly to their edge succeeds. Build for the second.
4. **Make the invisible visible.** Every architectural decision should show up somewhere in the debug panel so we can tell when it's working and when it isn't.

---

## Phase 5: Model & Voice Audit (Week 1)

**Goal**: Pick the best LLM + TTS combo for warmth, intelligence, latency, and cost. End the phase with a measured comparison, not a vibe check.

### 5.0 Provider strategy — escape the LiveKit plugin gate

LiveKit JS only ships five official LLM/STT/TTS plugins, but the constraint is much weaker than it looks: the `@livekit/agents-plugin-openai` LLM class accepts a custom `baseURL` and `apiKey`. Any OpenAI-API-compatible provider drops in with zero plugin work.

**For the bake-off, route everything through OpenRouter** — one API key, every candidate model, no per-provider SDK work:

```ts
new openai.LLM({
  model: 'anthropic/claude-sonnet-4.6',  // or deepseek/v3.2, qwen/qwen-2.5-72b, etc.
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})
```

**Latency tax of OpenRouter**: ~20–80ms of routing overhead on top of the underlying provider's TTFT. Real but small (~3–10% of our 700ms turn budget). Acceptable for benchmarking, not for production.

**The plan**:
1. Phase 5.1–5.4 use OpenRouter exclusively for the bake-off
2. Phase 5.5 (winner selection) switches the chosen model to its native endpoint to reclaim those 20–80ms
3. Build a thin `src/llm/LLMRouter.ts` wrapper (~30 lines) that selects provider + base URL via env var so swapping is one config change, not a code change

**Native-endpoint TTFT reference (April 2026, US west)** — what we'll target post-bake-off:

| Provider | TTFT | Cost relative to GPT-4o-mini |
|---|---|---|
| Cerebras (Llama 3.3 70B) | ~80ms | ~1× |
| Groq (Llama 3.3 70B) | ~120ms | ~1× |
| DeepSeek V3.2 | ~250ms | ~0.3× |
| GPT-4o-mini (current) | ~280ms | 1× baseline |
| Gemini 2.5 Flash | ~300ms | ~0.5× |
| Claude Haiku 4.5 | ~350ms | ~3× |
| Claude Sonnet 4.6 | ~600ms | ~15× |
| + OpenRouter proxy | +20–80ms | +5% margin |

If Phase 5 picks Sonnet, we fight the latency budget downstream. If it picks Haiku/DeepSeek, we have headroom for Phase 9's friction work. Cerebras/Groq is the wildcard worth benchmarking just for the latency floor.

**Why not switch to Pipecat instead?**
Pipecat (Python) has a richer plugin ecosystem and arguably better primitives for backchannels, interruption, and pronunciation pipelines. But: rewriting everything in Python costs ~2 weeks, and the OpenAI-compatible escape hatch above gives us 80% of Pipecat's plugin advantage from our existing TS code. Reconsider Pipecat in Phase 11 (production hardening) only if we hit 4+ custom adapters or a fundamental LiveKit limitation. Phase 7's dual-pipeline pronunciation work runs outside LiveKit anyway, so the framework choice doesn't gate it.

**For Anthropic specifically (no first-party LiveKit JS plugin yet)**: use OpenRouter or Anthropic's own OpenAI-compatible endpoint at `https://api.anthropic.com/v1/`. If we want native prompt caching control after Phase 5, write a ~100-line custom `llm.LLM` adapter — half a day of work, not a framework switch.

### 5.1 Build a model bake-off harness

A script that runs the same set of ~20 canned learner turns through different LLM configs and dumps:
- First-token latency (TTFT)
- Total response latency
- Token cost per turn
- Side-by-side response text

Canned turns should cover: greeting, off-topic chitchat, pronunciation question, grammar mistake, frustrated learner, code-switching mid-sentence, meta question ("how do I say X?"), silence-after-prompt.

### 5.2 Candidate models to benchmark

| Model | Why it's interesting | Concern |
|---|---|---|
| **Claude Sonnet 4.6** | Warmth baseline. The "what we're trying to match" target. | Cost, latency |
| **Claude Haiku 4.5** | Same family character at ~1/5 cost, faster | May lose nuance on tutoring calls |
| **GPT-4o-mini** (current) | Already wired up, cheap, low latency | Generic chatbot voice |
| **GPT-4o** (full) | Native voice mode is a separate path worth evaluating | Pricier, locks us into OpenAI voice |
| **DeepSeek V3.2** | Chinese frontier model, dirt cheap, surprisingly warm in some evals | Geopolitical/data-residency questions, less battle-tested for ESL |
| **Qwen 2.5 72B** | Alibaba's best, strong multilingual incl. Spanish | Same sovereignty caveat |
| **Gemini 2.5 Flash** | Native audio in/out path, fast, cheap | Personality often flat |
| **Mistral Large 2** | EU option, decent warmth | Weaker on Spanish than the others |

### 5.3 How to measure "warmth" / character (the hard part)

Character isn't a single benchmark. Best practical approaches:

- **Pairwise human preference** — for each canned turn, show two responses blind, you pick which feels more like a real tutor. n=50 turns is enough to rank.
- **LMArena-style ELO** if we want it more rigorous later, but pairwise from one rater is fine for v2.
- **Rubric scoring** — score each response 1–5 on: warmth, pedagogical instinct, conciseness, naturalness of code-switching. Lets us catch regressions on specific axes.
- **EQ-Bench / Creative Writing benchmarks** as a secondary signal — public leaderboards exist for emotional intelligence and creative voice, useful for narrowing the candidate set before manual eval.

**The honest answer to "can we get Sonnet warmth at Haiku cost?"**: Probably not from a base model alone. The path that works is **Haiku (or DeepSeek) + a much sharper system prompt + few-shot examples drawn from Sonnet outputs**. Phase 5 ends with that prompt.

### 5.4 Voice (TTS) audit

Cartesia Sonic 3 is the current pick. Worth comparing in the same harness:
- **Cartesia Sonic 3** (current) — fast, decent prosody
- **ElevenLabs Turbo v2.5 / Flash** — best-in-class warmth, slightly slower
- **OpenAI TTS-1-hd** with the newer voices — surprisingly good, very cheap
- **Google Cloud TTS Chirp 3 HD** — multilingual, native code-switching support

Pick on: code-switching naturalness (does Spanish pronunciation degrade when embedded in an English sentence?), latency, voice fit for "Sofía".

### 5.5 Deliverable

A `phase5-bakeoff.md` with the matrix, the chosen model + TTS, and the new system prompt. Wire the winner into `src/agent.ts`.

---

## Phase 6: Pedagogically-Tuned Prompting & Code-Switching (Week 2)

**Goal**: Sofía code-switches mid-sentence in a way that pushes the learner exactly at their edge. The bilingual ratio stops being a static number and becomes a live function of what the learner just produced.

### 6.1 Rewrite the system prompt around code-switching as a primary skill

Current prompt treats bilingual ratio as a target percentage. v2 prompt treats it as a *technique*:

- **Sandwich technique**: introduce a new Spanish word, immediately follow with English gloss in parens, use it again in Spanish later in the same turn
- **Scaffolded substitution**: as the learner shows comfort with a word, drop the English gloss
- **Comprehensible input rule**: every sentence should be ~90% understandable to the learner — push novelty in the remaining 10%
- **Mid-sentence switching with explicit examples**: "I love that you're learning — me encanta que estés aprendiendo." Show the model what we want with 5–10 hand-crafted examples in the prompt.

### 6.2 Dynamic difficulty adjustment

The compaction engine already updates `bilingual_ratio` in the learner core. v2 makes it adjust *every turn*, not just at session end:

- After each user turn, a lightweight "difficulty controller" looks at: did they hesitate, did they self-correct, did they ask for translation, did they respond in English when prompted in Spanish, did they nail a sentence cleanly
- Outputs a delta on `bilingual_ratio` for the next turn (±0.05 max)
- Gets injected into the next prompt as "RIGHT NOW, target X% Spanish — they're warmed up / they're struggling"

This is cheap: it's a small classifier prompt to GPT-4o-mini or Haiku, run in parallel with TTS so it doesn't add latency.

### 6.3 The "edge" check

Every 5 turns, the controller asks: "Is the learner on the edge of their ability or coasting?" If coasting → inject a slightly harder construction. If overwhelmed → back off to a comfort topic. This becomes a visible knob in the debug panel.

### 6.4 Deliverable

New `src/difficulty-controller.ts` + updated prompt in `src/prompts/`. Debug panel shows live bilingual ratio target, edge state, and reason for last adjustment.

---

## Phase 7: Honest Transcription & Pronunciation Feedback (Weeks 3–4)

**Goal**: Stop pretending the learner spoke perfectly. Capture what they *actually* said, including errors, and feed that into both the live response and post-session compaction.

This is the biggest technical lift in v2 and the highest-leverage. See companion doc `pronunciation-research.md` for the full landscape.

### 7.1 The dual-pipeline architecture

```
                    ┌──→ Deepgram Nova-3 ──→ "clean" transcript ──→ LLM
microphone audio ──┤
                    └──→ Pronunciation pipeline ──→ phoneme + prosody scores
                                                    + error annotations    
                                                          │
                                                          ▼
                                              merged into transcript
                                              annotated for the LLM
                                              surfaced to the learner
```

Both pipelines run on the same audio chunk. Deepgram gives us responsive turn-taking. The pronunciation pipeline gives us truth.

### 7.2 Pronunciation pipeline — three tiers, pick one for v2

**Tier A — Buy it (recommended for v2)**: **Azure Pronunciation Assessment** with `EnableProsodyAssessment=true`. ~$1.32/hr, free tier covers prototyping. Returns Accuracy, Fluency, Prosody, Completeness + per-phoneme scores + error types (Monotone, Unexpected break, etc). Caveat: prosody is en-US only, so for Spanish output we use accuracy/fluency only. **Start here, ship something.**

**Tier B — Build it**: wav2vec2-XLSR fine-tuned for Spanish phoneme recognition + `parselmouth` for F0/energy contours + Claude as the "translator" that converts numeric scores into a learner-facing tip. The `crazycloud/mispronunciation-detection-diagnosis-wav2vec2-and-llm` repo is a starting skeleton. Right path long-term, wrong path for v2 timeline.

**Tier C — DIY prosody only**: parselmouth + Praat. Free, low-level, useful for catching truly flat intonation but won't catch phoneme-level errors. Cheap addition on top of Tier A.

**v2 plan**: Ship Tier A. Add a small Tier C layer for monotone/intonation flags on Spanish (since Azure prosody is en-US only). Document Tier B as the v3 direction.

### 7.3 Error-aware transcription

When the pronunciation pipeline flags a word as mispronounced, the transcript fed to Sofía gets annotated:

```
[learner] Yo... cocina? (intended: "cocino", confidence 0.4 on /o/)
```

The system prompt teaches Sofía how to respond to these annotations: gently model the correct form, don't quiz, don't shame. This is the loop we couldn't close in the prototype because we had no idea what the learner *actually* said.

### 7.4 Learner-facing pronunciation feedback

Two surfaces:
- **In-session**: subtle visual hint in the web UI when a word is flagged (small underline, hover for the score). Not interruptive.
- **Post-session**: a "Pronunciation report" appended to the compaction output — "You've nailed /r/ in 'pero', still working on the rolled /rr/ in 'perro'. Want to drill it next session?"

### 7.5 Deliverable

`src/pronunciation/` module with the dual pipeline. Pronunciation scores stored on the session row. Debug panel shows live phoneme-level scores. New "Pronunciation" tab in the post-session view.

---

## Phase 8: Onboarding (Week 5)

**Goal**: The first 90 seconds of a new learner's first session should set up everything downstream — the cores, the difficulty controller, the FSRS seed, even the voice. Done well, session 1 starts already feeling personalized. Done badly, the prototype's "cold drop into conversation" feel persists no matter how good the rest of v2 is.

This phase exists because every other phase compounds off the cores, and the cores compound off whatever happens in the first session. Bad seed → bad compaction → bad session 2.

### 8.1 Multi-modal onboarding flow

Three short stages, designed to feel like meeting a tutor for the first time, not filling out a form:

**Stage 1 — Profile (text/tap, ~20s)**
- Name, preferred name (what should Sofía call you?)
- Native language (English assumed; option for Portuguese/French/Italian as L1 changes everything pedagogically)
- Why are you learning Spanish? (free text, 1 line — feeds `learning_profile.motivation` in the learner core)

**Stage 2 — Level placement (voice, ~45s)**
- Sofía greets in 100% English, asks a few open questions in escalating difficulty:
  - "Tell me a little about your day" (English baseline — speech rate, fluency baseline)
  - "Do you know any Spanish at all?" (catches "I took two years in high school" vs "completely new")
  - "Try saying hello to me in Spanish" (first L2 production — catches accent baseline + confidence)
- A placement classifier (cheap LLM call) reads the responses and picks initial CEFR level + bilingual ratio + endpointing
- Critical: the placement *is* the start of the session, not separate. No "now we begin." Smooth transition.

**Stage 3 — Interests & goals (voice or tap, ~25s)**
- "What do you like to talk about?" — pick 2–3 topics from a quick grid (food, travel, work, family, sports, music, books, news, hobbies) OR say them aloud
- Optional voice persona pick: warmer Sofía vs. crisper Sofía vs. more challenging Sofía. Three pre-written tutor cores to choose from. Voice sample plays for each.

### 8.2 Seed core generation from onboarding

Output of Stage 1–3 hydrates the learner core and tutor core *before* the first real conversational turn:

- `learner_core.proficiency.cefr_level` — from placement classifier
- `learner_core.proficiency.bilingual_ratio` — from placement (A1 starts at 0.85 English, A2 at 0.65, B1 at 0.45)
- `learner_core.proficiency.speech_rate_wpm` — measured from English baseline turn
- `learner_core.learning_profile.interests` — from Stage 3
- `learner_core.learning_profile.motivation` — from Stage 1
- `learner_core.learning_profile.endpointing_ms` — from English baseline pause patterns
- `learner_core.pronunciation.l1_baseline` — first audio sample stored for later L1-transfer pattern detection
- `tutor_core.persona` — from Stage 3 voice pick
- `tutor_core.teaching_narrative` — generated by Sonnet from all of the above ("Maria is a beginner motivated by an upcoming Mexico trip with her partner. Loves food and travel. Slight Italian L1 may help cognates but watch for /h/ vs /j/ confusion. Wants warmth, not pressure.")

### 8.3 Returning-learner handling

Onboarding only fires for first session. Returning learners get a much shorter welcome:
- "Welcome back, [name]" — references something specific from last session's compaction notes
- "Last time we talked about [topic]. Want to keep going or try something new?"
- This is a UX problem more than a technical one — make it warm, make it short.

### 8.4 Skip & resume

Learner can skip onboarding entirely ("just start") — system seeds with safe defaults and lets compaction figure it out over 2–3 sessions. Slower path to personalization but respects users who hate onboarding flows.

Onboarding state persists — if the learner closes the tab mid-flow, they resume where they left off, not from scratch.

### 8.5 Failure modes to design for

- **The "I lied" learner**: Self-rates as A2, actually A1. Difficulty controller (Phase 6) catches this in the first 5 turns and quietly adjusts; tutor core gets corrected at first compaction.
- **The mute first turn**: Learner picks voice onboarding then doesn't speak. Timeout at 8s, fall back to text/tap version of the same question.
- **The over-eager beginner**: Picks "more challenging Sofía" persona but is actually A1. Tutor adapts within first 3 turns; never makes the learner feel they "chose wrong."
- **Already-fluent learner who picked Spanish↔English by mistake**: Placement detects fluency, offers "this looks like B2+ — want to switch to advanced mode?" rather than treating them like a beginner.

### 8.6 Web UI requirements

- Onboarding is a separate route (`/onboarding`) not the main session route
- Progress indicator across the three stages (subtle — no "step 1 of 3" school feel)
- Voice playback for persona samples needs to actually work, including on iOS Safari quirks
- Dark mode by default; the prototype's web UI matches this

### 8.7 Deliverable

`src/onboarding/` module: placement classifier, seed core generator, persona templates. New `web/onboarding.html` flow. A test where 5 different synthetic learners (varied L1, level, motivation) pass through onboarding and end up with sensibly-different cores. The first message of session 1 references something from onboarding within the first 2 sentences.

---

## Phase 9: Friction Pass — Make It Feel Right (Week 6)

**Goal**: A grab bag of small things, all of which matter. None individually impressive, collectively the difference between "demo" and "real product."

### 8.1 Latency surgery

Measure end-to-end pipeline latency at every hop. Targets:
- Mic → Deepgram first partial: <150ms
- End-of-turn → LLM first token: <300ms
- LLM first token → first audio out: <200ms
- **Total turn latency target: <750ms**

Likely wins: streaming the LLM response into TTS chunk-by-chunk (probably already happening, verify), prewarming the LLM with the system prompt, keeping the WebRTC connection warm between sessions.

### 8.2 Interruption handling

Right now push-to-talk sidesteps this. v2 adds: if the learner starts speaking while Sofía is mid-sentence, Sofía stops cleanly within 200ms and listens. Critical for natural conversation feel.

### 8.3 Backchannels & filler

Sofía should occasionally emit "mm-hmm", "claro", "sí, sí" when the learner is clearly mid-thought (long pause but not end-of-turn). Done via a separate cheap-model side-channel that listens to partial transcripts.

### 8.4 Repair moves

When the learner says "wait, what?" or "say that again" or pauses confused for 4+ seconds, Sofía should detect this and rephrase, not repeat verbatim. Add a small "confusion detector" prompt that runs on partials.

### 8.5 Memory leak audit

Make sure session contexts are cleaned up between sessions. Postgres connection pooling. WebRTC disconnect handling. Boring but matters.

### 8.6 Voice activity polish

Endpointing tuning per-learner. Some people pause a lot mid-sentence; others don't. The compaction engine already tracks `endpointing_ms` in the learner core — actually use it.

---

## Phase 10: Demo Session & Validation (Week 7)

**Goal**: Run a real 5-session arc with someone who isn't us. Watch them use it. Fix what breaks.

### 10.1 Recruit a real learner

Friend, family member, ideally an actual A1–A2 Spanish learner. Not another engineer.

### 10.2 5-session protocol

One session per day for a week. Before/after: short interview about what worked, what didn't, what felt off. Keep all transcripts and core diffs.

### 10.3 Success criteria (write these *before* the sessions)

- Session 5 references things from sessions 1–3 unprompted ✓/✗
- Learner can identify ≥3 vocab items from session 1 by session 5 (free recall, not prompted) ✓/✗
- Learner reports the tutor "felt like it knew them" by session 3 ✓/✗
- Pronunciation feedback led to a measurable improvement on at least one targeted phoneme ✓/✗
- No session had a latency-induced break in conversation ✓/✗
- Learner wants a 6th session unprompted ✓/✗

### 10.4 Deliverable

A `phase10-results.md` with what worked, what didn't, what's next.

---

## Cross-cutting concerns (every phase)

- **Cost monitoring**: track per-session cost in the debug panel. v2 target: under $0.30 per 10-minute session (LLM + STT + TTS + compaction + pronunciation combined).
- **Prompt versioning**: all prompts stored as files in `src/prompts/`, versioned in git. Compaction logs which prompt version produced each core update.
- **Eval harness**: grow the canned-turn set from Phase 5 throughout v2. By end of v2 it should be ~100 turns covering every interaction we care about. Run it before every prompt change.

---

## What "really special" looks like at the end of v2

A 10-minute session where:
- Sofía code-switches naturally inside sentences, scaffolding novelty against words the learner already owns
- The learner mispronounces "perro" with a tapped /r/ instead of trilled, Sofía gently models it back and the system schedules a drill
- Mid-conversation, the learner gets confused, pauses; Sofía notices and rephrases without being asked
- The learner says something interesting about their weekend; next session, Sofía asks how the trip went
- The whole thing costs less than a quarter and feels like a person

That's the v2 bar.

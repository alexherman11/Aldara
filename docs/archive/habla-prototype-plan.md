# Habla Prototype — Development Plan

## Goal

A working end-to-end prototype that proves the core thesis: compaction-based memory makes a voice language tutor feel like it *knows* you across sessions. The prototype connects all the pieces — voice in, voice out, dynamic LLM prompting from learner/tutor cores, FSRS vocabulary scheduling, post-session compaction, and a web UI showing what's happening inside the system.

**Not in scope for the prototype**: React Native mobile app, SpeechAce pronunciation scoring, Google Cloud TTS IPA demos, offline fallback, on-device VAD/WhisperKit, CEFR drift validation. These are all future layers on a foundation that this prototype validates.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Web Browser Client                        │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Push-to-Talk │  │ Live         │  │ Debug Panel             │ │
│  │ Button       │  │ Transcript   │  │ (cores, FSRS, metrics)  │ │
│  └──────┬──────┘  └──────────────┘  └─────────────────────────┘ │
│         │  LiveKit WebRTC + RPC                                  │
└─────────┼────────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────────┐
│                    LiveKit Agent Server (Node.js)                 │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ SofíaAgent (voice.Agent)                                     │ │
│  │   • instructions = buildSystemPrompt(sessionContext)          │ │
│  │   • on_enter: greet learner                                  │ │
│  │   • on_user_turn_completed: log transcript, update context   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ AgentSession                                                  │ │
│  │   • turnDetection: "manual" (push-to-talk via RPC)           │ │
│  │   • STT: Deepgram Nova-3                                     │ │
│  │   • LLM: GPT-4o-mini (via OpenAI plugin)                    │ │
│  │   • TTS: Cartesia Sonic 3                                    │ │
│  │   • VAD: Silero (for speech activity, not turn detection)    │ │
│  │   • userdata: SessionContext                                  │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ SessionContext│  │ FSRS Engine  │  │ Compaction Engine       │ │
│  │ (in-memory)  │  │ (ts-fsrs)    │  │ (Claude Sonnet, async) │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬───────────┘ │
└─────────┼─────────────────┼───────────────────────┼─────────────┘
          │                 │                       │
┌─────────▼─────────────────▼───────────────────────▼─────────────┐
│                        PostgreSQL + JSONB                         │
│  learners (cores)  │  sessions (transcripts)  │  fsrs_cards      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Component Breakdown

### 1. Database Layer

**File**: `src/db/schema.sql`

Three tables, kept minimal:

```sql
CREATE TABLE learners (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  cefr_level      TEXT DEFAULT 'A1',
  session_count   INTEGER DEFAULT 0,
  learner_core    JSONB DEFAULT '{}',
  tutor_core      JSONB DEFAULT '{}',
  core_version    INTEGER DEFAULT 0
);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID REFERENCES learners(id),
  started_at      TIMESTAMPTZ DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  transcript      JSONB DEFAULT '[]',
  pre_cores       JSONB,    -- snapshot before compaction
  post_cores      JSONB,    -- snapshot after compaction
  compaction_log  TEXT       -- raw compaction output for debugging
);

CREATE TABLE fsrs_cards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID REFERENCES learners(id),
  item_type       TEXT NOT NULL,
  item_key        TEXT NOT NULL,
  item_context    TEXT,
  due             TIMESTAMPTZ NOT NULL DEFAULT now(),
  stability       REAL DEFAULT 0,
  difficulty      REAL DEFAULT 0,
  elapsed_days    REAL DEFAULT 0,
  scheduled_days  REAL DEFAULT 0,
  reps            INTEGER DEFAULT 0,
  lapses          INTEGER DEFAULT 0,
  state           INTEGER DEFAULT 0,
  last_review     TIMESTAMPTZ,
  UNIQUE(learner_id, item_type, item_key)
);

CREATE INDEX idx_fsrs_due ON fsrs_cards(learner_id, due);
```

**File**: `src/db/index.ts` — thin wrapper using `pg` (node-postgres). Just `query()`, no ORM. Five functions: `getOrCreateLearner()`, `saveCores()`, `getDueCards()`, `upsertCard()`, `saveSession()`.

For the prototype, use a local Postgres or a free Neon/Supabase instance. The `.env` DATABASE_URL gets filled in.

---

### 2. Session Context & Prompt Builder

**File**: `src/session-context.ts`

```typescript
export interface SessionContext {
  learnerId: string;
  learnerCore: Record<string, any>;
  tutorCore: Record<string, any>;
  fsrsDueItems: Array<{ item_key: string; item_context: string }>;
  
  conversationHistory: Array<{ role: string; text: string; ts: Date }>;
  fullTranscript: Array<{ role: string; text: string; ts: Date }>;
  turnCount: number;
  sessionStartedAt: Date;
  sessionId: string;
}

export async function loadSessionContext(learnerId: string): Promise<SessionContext> {
  // 1. Fetch learner row (or create with seed cores if new)
  // 2. Query fsrs_cards WHERE due <= now() LIMIT 8
  // 3. Create new session row
  // 4. Return assembled SessionContext
}
```

**File**: `src/prompt-builder.ts`

The system prompt assembler. This is the nerve center — it reads the tutor core and learner core and produces the instructions that make Sofía sound like a tutor who knows this specific learner.

```typescript
export function buildSystemPrompt(ctx: SessionContext): string {
  const tutorPersona = ctx.tutorCore.teaching_narrative 
    || `You are Sofía, a warm and encouraging Spanish-English language tutor.
        The learner is at CEFR A1. Use 80% English and 20% Spanish.
        Introduce Spanish words in context. Praise attempts.
        Keep responses conversational and under 3 sentences.`;

  const learnerProfile = ctx.learnerCore.session_trajectory
    || 'This is a new learner. Start by asking about their interests.';

  const fsrsSection = ctx.fsrsDueItems.length > 0
    ? `Vocabulary items due for review — weave these naturally into conversation, 
       do NOT quiz explicitly:\n${ctx.fsrsDueItems.map(
         i => `  - "${i.item_key}" (${i.item_context || 'new word'})`
       ).join('\n')}`
    : '';

  const cefrReminder = ctx.turnCount > 0 && ctx.turnCount % 7 === 0
    ? `\nREMINDER: Stay at ${ctx.learnerCore?.proficiency?.cefr_level || 'A1'} level. 
       Bilingual ratio: ${ctx.learnerCore?.proficiency?.bilingual_ratio || 0.8} English.`
    : '';

  return [
    tutorPersona,
    `\nAbout this learner:\n${learnerProfile}`,
    fsrsSection,
    cefrReminder,
  ].filter(Boolean).join('\n\n');
}
```

For a brand new learner (no cores yet), the prompt builder falls back to sensible defaults — generic Sofía persona, A1 level, 80/20 English/Spanish ratio, "ask about their interests." After the first session compacts, the cores take over.

---

### 3. Seed Cores (For New Learners)

**File**: `src/seed-cores.ts`

When a learner has no cores yet, the system seeds minimal starter documents:

```typescript
export const SEED_LEARNER_CORE = {
  version: 0,
  proficiency: {
    cefr_level: "A1",
    bilingual_ratio: 0.8,
    speech_rate_wpm: 0,
    self_correction_rate: 0
  },
  vocabulary: { active_count: 0, passive_count: 0, comfort_zones: [], gaps: [] },
  pronunciation: { overall_score: 0, trajectories: {}, l1_transfer_patterns: [] },
  grammar: { frontier: "present tense", mastered: [], emerging: [], breakthroughs: [] },
  learning_profile: {
    interests: [],
    correction_preference: "praise-first, end-of-turn",
    emotional_baseline: "unknown — first session",
    frustration_triggers: [],
    strengths: [],
    endpointing_ms: 6000
  },
  session_trajectory: "New learner. No sessions yet."
};

export const SEED_TUTOR_CORE = {
  version: 0,
  persona: {
    name: "Sofía",
    voice_id: "CARTESIA_SOFIA_VOICE_ID",
    personality: "Warm, curious, gently challenging. Mexican Spanish."
  },
  teaching_narrative: "New learner — probe for interests, establish rapport, assess baseline level. Use heavy English scaffolding with simple Spanish greetings and common phrases. Celebrate every attempt.",
  correction_strategy: {
    grammar: "Do not correct yet — let them produce freely",
    pronunciation: "Note patterns silently, no feedback yet",
    vocabulary: "Introduce 3-5 new words per session in context"
  },
  pacing: {
    current_push: "Basic greetings, self-introduction, interests",
    next_horizon: "Present tense regular verbs",
    avoid: "Past tenses, subjunctive — too early"
  },
  fsrs_integration: "Introduce new vocabulary naturally, no review items yet",
  engagement_insights: {
    high_engagement_topics: [],
    low_engagement_topics: [],
    preferred_conversation_style: "unknown"
  },
  bilingual_ratio_target: 0.8,
  endpointing_ms: 6000
};
```

---

### 4. LiveKit Agent

**File**: `src/agent.ts`

The core agent using LiveKit Agents JS SDK. Push-to-talk with manual turn detection.

```typescript
import { type JobContext, type JobProcess, defineAgent, voice, llm } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';

import { loadSessionContext, SessionContext } from './session-context.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { runCompaction } from './compaction.js';

// For the prototype, use a hardcoded learner ID
// In production, this comes from auth token metadata
const LEARNER_ID = process.env.LEARNER_ID || 'default-learner';

class SofiaAgent extends voice.Agent {
  private ctx: SessionContext;
  
  constructor(sessionContext: SessionContext) {
    super({
      instructions: buildSystemPrompt(sessionContext),
    });
    this.ctx = sessionContext;
  }

  override async onEnter() {
    // Greet the learner based on their history
    const greeting = this.ctx.learnerCore.session_trajectory?.includes('New learner')
      ? "¡Hola! I'm Sofía, your Spanish tutor. Tell me — what made you want to learn Spanish?"
      : `¡Hola! Welcome back. ${this.ctx.tutorCore.teaching_narrative?.split('.')[0] || "Ready to practice?"}`;
    
    this.session.generateReply({ instructions: greeting });
  }

  override async onUserTurnCompleted(
    turnCtx: llm.ChatContext,
    newMessage: llm.ChatMessage
  ) {
    // 1. Log to full transcript
    const userText = typeof newMessage.content === 'string' 
      ? newMessage.content 
      : JSON.stringify(newMessage.content);
    
    this.ctx.fullTranscript.push({
      role: 'learner',
      text: userText,
      ts: new Date(),
    });
    this.ctx.turnCount++;

    // 2. Rebuild instructions with CEFR reminder on every 7th turn
    if (this.ctx.turnCount % 7 === 0) {
      // Update the agent's instructions dynamically
      await this.updateInstructions(buildSystemPrompt(this.ctx));
    }

    // 3. After this hook returns, LiveKit sends context to LLM automatically
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    // Load the session context from Postgres
    const sessionContext = await loadSessionContext(LEARNER_ID);

    const agent = new SofiaAgent(sessionContext);

    const session = new voice.AgentSession({
      stt: new deepgram.STT({ model: 'nova-3', language: 'multi' }),
      llm: new openai.LLM({ model: 'gpt-4o-mini' }),
      tts: new cartesia.TTS({ 
        model: 'sonic-3',
        voice: process.env.CARTESIA_VOICE_ID || 'default',
      }),
      vad: ctx.proc.userData.vad,
      userdata: sessionContext,
      
      // Push-to-talk: manual turn detection
      turnDetection: 'manual',
    });

    // Disable audio input at start (push-to-talk)
    session.input.setAudioEnabled(false);

    // RPC methods for push-to-talk from the client
    ctx.room.localParticipant.registerRpcMethod('start_turn', async () => {
      session.interrupt();
      session.clearUserTurn();
      session.input.setAudioEnabled(true);
      return 'ok';
    });

    ctx.room.localParticipant.registerRpcMethod('end_turn', async () => {
      session.input.setAudioEnabled(false);
      session.commitUserTurn();
      return 'ok';
    });

    // Handle session end — trigger compaction
    ctx.room.localParticipant.registerRpcMethod('end_session', async () => {
      session.input.setAudioEnabled(false);
      
      // Run compaction async
      await runCompaction(sessionContext);
      
      return JSON.stringify({
        sessionId: sessionContext.sessionId,
        turnCount: sessionContext.turnCount,
        message: 'Session compacted successfully'
      });
    });

    // Also log assistant responses to the transcript
    session.on('agentSpeechCommitted', (ev) => {
      sessionContext.fullTranscript.push({
        role: 'tutor',
        text: ev.content || '',
        ts: new Date(),
      });
    });

    await session.start({ agent, room: ctx.room });
  },
});
```

---

### 5. Compaction Engine

**File**: `src/compaction.ts`

Calls Claude Sonnet with the full session transcript and current cores. This is the most important code in the system.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { SessionContext } from './session-context.js';
import { saveCores, saveSession, upsertCard } from './db/index.js';
import { fsrs, Rating, type Card } from 'ts-fsrs';

const anthropic = new Anthropic();
const f = fsrs();

const COMPACTION_PROMPT = `You are the Compaction Engine for Habla, a Spanish-English language tutor...`; 
// [Full compaction prompt from the architecture decisions doc]
// Imported from src/prompts/compaction-prompt.txt

export async function runCompaction(ctx: SessionContext): Promise<void> {
  const transcript = ctx.fullTranscript
    .map(t => `[${t.role}] ${t.text}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `
<existing_learner_core>
${JSON.stringify(ctx.learnerCore, null, 2)}
</existing_learner_core>

<existing_tutor_core>
${JSON.stringify(ctx.tutorCore, null, 2)}
</existing_tutor_core>

<session_transcript>
${transcript}
</session_transcript>

<session_metrics>
Turn count: ${ctx.turnCount}
Session duration: ${((Date.now() - ctx.sessionStartedAt.getTime()) / 1000 / 60).toFixed(1)} minutes
</session_metrics>
      `.trim()
    }],
    system: COMPACTION_PROMPT,
  });

  // Parse the structured JSON response
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  
  // Strip markdown code fences if present
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  const result = JSON.parse(clean);

  // Save pre/post snapshots
  await saveSession(ctx.sessionId, {
    ended_at: new Date(),
    transcript: ctx.fullTranscript,
    pre_cores: { learner: ctx.learnerCore, tutor: ctx.tutorCore },
    post_cores: { learner: result.learner_core, tutor: result.tutor_core },
    compaction_log: result.compaction_notes,
  });

  // Update the cores in Postgres
  await saveCores(ctx.learnerId, result.learner_core, result.tutor_core);

  // Process FSRS updates
  for (const update of result.fsrs_updates || []) {
    if (update.action === 'create') {
      // New vocabulary card
      const card = f.createEmptyCard(new Date());
      await upsertCard(ctx.learnerId, {
        item_type: update.item_type,
        item_key: update.item_key,
        item_context: update.context,
        ...cardToRow(card),
      });
    } else if (update.action === 'rate') {
      // Update existing card with implicit rating
      const rating = Rating[update.rating as keyof typeof Rating];
      // Fetch existing card, compute new state, save
      // (implementation details in db layer)
    }
  }

  console.log(`[compaction] Session ${ctx.sessionId} compacted. ` +
    `Notes: ${result.compaction_notes}`);
}
```

**File**: `src/prompts/compaction-prompt.txt`

The full compaction prompt from the architecture decisions document, stored as a text file and loaded at startup. This keeps the prompt editable without recompiling.

---

### 6. Web Client

**File**: `web/index.html` + `web/app.js`

A single-page web app using LiveKit's JS client SDK via CDN. No build step, no React — just vanilla JS for fast iteration.

Three panels:

**Left panel: Conversation**
- Push-to-talk button (hold to speak, release to send)
- Live transcript showing both learner and Sofía's words
- Visual indicator for agent state (listening, thinking, speaking)

**Right panel: Debug / System State**
- Current Learner Core (formatted JSON, updates after compaction)
- Current Tutor Core (formatted JSON)
- FSRS cards due this session
- Session metrics (turn count, duration)
- "End Session & Compact" button that triggers compaction and shows the diff

**Implementation sketch**:

```javascript
// Connect to LiveKit room
const room = new LivekitClient.Room();
await room.connect(LIVEKIT_URL, token);

// Push-to-talk
const pttButton = document.getElementById('ptt');
pttButton.addEventListener('mousedown', async () => {
  await room.localParticipant.performRpc({
    destinationIdentity: 'agent', method: 'start_turn', payload: ''
  });
  pttButton.classList.add('recording');
});
pttButton.addEventListener('mouseup', async () => {
  await room.localParticipant.performRpc({
    destinationIdentity: 'agent', method: 'end_turn', payload: ''
  });
  pttButton.classList.remove('recording');
});

// Display transcripts from agent events
room.on('transcriptionReceived', (segments, participant) => {
  // Append to transcript panel
});

// End session button
document.getElementById('end-session').addEventListener('click', async () => {
  const result = await room.localParticipant.performRpc({
    destinationIdentity: 'agent', method: 'end_session', payload: ''
  });
  // Show compaction result in debug panel
  // Refresh cores display
});
```

**Token server**: A tiny Express endpoint (`src/token-server.ts`) that generates LiveKit access tokens for the web client. ~20 lines.

---

### 7. Project Structure

```
habla-prototype/
├── .env                          # API keys (from project)
├── package.json
├── tsconfig.json
├── src/
│   ├── agent.ts                  # LiveKit agent entry point
│   ├── session-context.ts        # SessionContext loader
│   ├── prompt-builder.ts         # System prompt assembler
│   ├── compaction.ts             # Claude Sonnet compaction engine
│   ├── seed-cores.ts             # Default cores for new learners
│   ├── token-server.ts           # Express token endpoint for web client
│   ├── db/
│   │   ├── schema.sql            # Postgres table definitions
│   │   └── index.ts              # Database query functions
│   └── prompts/
│       └── compaction-prompt.txt # The compaction system prompt
└── web/
    ├── index.html                # Single-page web client
    ├── app.js                    # LiveKit client + push-to-talk + debug panel
    └── style.css                 # Minimal styling
```

---

## Development Sequence

### Phase 0: Foundation (Day 1)

**Goal**: Project scaffolding, database, and the compaction prompt tested offline.

1. Initialize the Node.js project with TypeScript and ESM (`"type": "module"`)
2. Install dependencies: `@livekit/agents`, `@livekit/agents-plugin-deepgram`, `@livekit/agents-plugin-openai`, `@livekit/agents-plugin-cartesia`, `@livekit/agents-plugin-silero`, `@anthropic-ai/sdk`, `ts-fsrs`, `pg`, `express`, `dotenv`
3. Create the Postgres schema and database functions
4. Set up `.env` from the existing project credentials
5. **Test the compaction prompt offline**: Write a script (`scripts/test-compaction.ts`) that feeds a synthetic Week 1-style transcript (from the vision doc) through Claude Sonnet with the compaction prompt, starting from seed cores. Inspect the output. Iterate on the prompt until the cores evolve convincingly. This is the most important step — get it right before touching audio.

### Phase 1: Voice Pipeline (Day 2)

**Goal**: Sofía speaks and listens, with a hardcoded system prompt.

1. Build the agent with LiveKit Agents JS — hardcoded instructions, no database
2. Set up push-to-talk via RPC methods
3. Build the token server
4. Build the minimal web client with push-to-talk button and transcript display
5. Test: hold button, speak English, release, hear Sofía respond
6. Verify Deepgram transcription appears in the transcript panel

### Phase 2: Dynamic Prompting (Day 3)

**Goal**: Sofía's personality comes from the database-backed cores.

1. Wire `loadSessionContext()` to Postgres — load cores and FSRS items at session start
2. Replace hardcoded instructions with `buildSystemPrompt(ctx)`
3. Wire `onUserTurnCompleted` to log transcript and update turn count
4. Add the debug panel showing current cores and due FSRS items
5. Seed a learner in the database with the starter cores
6. Test: Start a session, have a conversation about hiking, see the system prompt in the debug panel adapting as CEFR reminders fire every 7 turns

### Phase 3: Compaction Loop (Day 4)

**Goal**: Session end triggers compaction, cores evolve, next session reflects the changes.

1. Wire the `end_session` RPC to call `runCompaction()`
2. Show pre/post core diffs in the debug panel after compaction
3. Process `fsrs_updates` from compaction output — create new cards, rate existing ones
4. Test the full loop:
   - Start session 1 with a new learner (seed cores)
   - Have a conversation about cooking (introduce "cocinar", "delicioso", "receta")
   - End session → compaction runs → cores update
   - Start session 2 → Sofía should reference cooking, the due FSRS items should include words from session 1
   - The debug panel should show evolved cores with cooking in the interests

### Phase 4: Polish & Demo (Day 5)

**Goal**: Smooth enough for a demo to someone else.

1. Improve the web UI — cleaner transcript, visual state indicators, core diff viewer
2. Add session history view — list past sessions with their transcripts and core diffs
3. Handle edge cases: empty transcripts, compaction failures, network disconnects
4. Add a "Reset Learner" button for testing from scratch
5. Run a full 3-session demo sequence mimicking Week 1 from the vision doc
6. Record a screen capture of the demo

---

## Key Dependencies & Versions

| Package | Purpose |
|---------|---------|
| `@livekit/agents` | Agent framework |
| `@livekit/agents-plugin-deepgram` | STT (Nova-3, multi-language) |
| `@livekit/agents-plugin-openai` | LLM (GPT-4o-mini) |
| `@livekit/agents-plugin-cartesia` | TTS (Sonic 3) |
| `@livekit/agents-plugin-silero` | VAD |
| `@anthropic-ai/sdk` | Compaction LLM (Claude Sonnet) |
| `ts-fsrs` | Spaced repetition scheduling |
| `pg` | Postgres client |
| `express` | Token server |
| `dotenv` | Environment config |
| `livekit-server-sdk` | Token generation |

---

## Environment Variables Needed

```env
# LiveKit (already have these)
LIVEKIT_API_KEY=APIedj8CxsMGTXC
LIVEKIT_API_SECRET=MfsXLh0PEoNvQJmITZgoZSYAfmqeEWRlJ4RwmKaJxGZA
LIVEKIT_URL=wss://lingua-ghti7l62.livekit.cloud

# STT
DEEPGRAM_API_KEY=<existing>

# LLM — real-time
OPENAI_API_KEY=<need this for GPT-4o-mini>

# TTS
CARTESIA_API_KEY=<existing>
CARTESIA_VOICE_ID=<pick a Sofía voice from Cartesia's library>

# Compaction LLM
ANTHROPIC_API_KEY=<existing>

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/habla

# Prototype config
LEARNER_ID=<UUID of the test learner>
```

**Note on the real-time LLM**: The prototype uses GPT-4o-mini through OpenAI's plugin because LiveKit has a mature OpenAI integration. Your architecture doc considered Claude Sonnet for this role too — for the prototype, GPT-4o-mini is the path of least resistance since the LiveKit OpenAI plugin handles streaming, function calling, and context management out of the box. Switching to Claude for real-time is a later optimization.

---

## What This Prototype Proves

After 5 days, you'll have evidence for or against these hypotheses:

1. **Compaction creates continuity**: Does session 3 feel like it remembers sessions 1 and 2? Does the tutor reference the learner's interests, correct in their preferred style, and surface vocabulary at the right time?

2. **FSRS weaving works**: Does naturally surfacing due vocabulary in conversation feel organic, or does it feel forced? Is the LLM good enough at this with just prompt instructions?

3. **The latency is tolerable**: With push-to-talk (eliminating turn detection latency), does the ~700ms pipeline feel responsive enough for conversation?

4. **Cores stay coherent**: After 5+ compaction cycles, do the cores drift, balloon in size, or lose important information? The debug panel makes this visible.

5. **The architecture holds**: Is LiveKit Agents flexible enough for the Habla-specific hooks (dynamic prompt rebuilding, FSRS injection, compaction trigger), or does the framework fight you?

The answers to these questions determine what to build next — React Native mobile app, pronunciation scoring, automatic turn detection tuning, or something else entirely.

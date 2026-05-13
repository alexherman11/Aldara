// Load .env using an absolute path so this works even when the job-process
// is spawned with a different cwd than the project root.
import { config as dotenvConfig } from 'dotenv';
import { dirname as _dirname, join as _join } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
const __agentDir = _dirname(_fileURLToPath(import.meta.url));
// override:true because parent shell env may have stale empty values for keys
// (e.g., from a previous dev session) — .env on disk is the canonical source.
dotenvConfig({ path: _join(__agentDir, '..', '.env'), override: true });
// Surface critical env at startup so we don't silently fall back to a broken
// state on the first turn that needs them.
for (const k of ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'CARTESIA_API_KEY']) {
  if (!process.env[k]) {
    console.warn(`[agent] WARNING: ${k} is missing — features depending on it will fail`);
  }
}
import {
  type JobContext,
  type JobProcess,
  defineAgent,
  cli,
  voice,
  llm,
  ServerOptions,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';

import { loadSessionContext, type SessionContext } from './session-context.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { runCompaction } from './compaction.js';
import {
  initControllerState,
  evaluateTurn,
  evaluateEdge,
  type ControllerState,
} from './difficulty-controller.js';
import {
  createAssessor,
  type PronunciationAssessor,
} from './pronunciation/index.js';
import { chunksToWav, chunkDurationSeconds, type PcmChunk } from './pronunciation/wav.js';
import type { PronunciationAssessment } from './pronunciation/types.js';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join as _pathJoin } from 'node:path';

// Persist each PTT cycle's WAV + transcript metadata under recordings/<sessionId>/
// so we can replay real learner audio through future pipeline iterations
// without needing the learner online. Enabled when RECORD_TURNS=1.
const RECORD_TURNS = process.env.RECORD_TURNS === '1';
const RECORDINGS_DIR = _pathJoin(__agentDir, '..', 'recordings');

const EDGE_CHECK_EVERY_N_TURNS = 5;
const MAX_STORED_ASSESSMENTS = 20;

/**
 * Save a single PTT turn as WAV + sidecar JSON metadata under
 * recordings/<sessionId>/turn_<N>.{wav,json}. The JSON captures the Deepgram
 * transcript, Azure score, and timing so an offline replay harness can later
 * load the WAV, run alternate STT/scoring pipelines, and diff against this
 * baseline.
 *
 * Best-effort and synchronous — writes happen fire-and-forget so they never
 * stall the live conversation. Failure logs but does not throw.
 */
function saveTurnRecording(
  sessionId: string,
  turnNumber: number,
  wav: Buffer,
  meta: Record<string, unknown>,
): void {
  if (!RECORD_TURNS) return;
  try {
    const dir = _pathJoin(RECORDINGS_DIR, sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stem = _pathJoin(dir, `turn_${String(turnNumber).padStart(3, '0')}`);
    writeFileSync(stem + '.wav', wav);
    writeFileSync(stem + '.json', JSON.stringify(meta, null, 2));
    // Append-only index so we can scan all turns across sessions in one pass
    appendFileSync(
      _pathJoin(RECORDINGS_DIR, 'index.jsonl'),
      JSON.stringify({
        session_id: sessionId,
        turn: turnNumber,
        path: stem,
        captured_at: new Date().toISOString(),
        ...meta,
      }) + '\n',
    );
  } catch (err) {
    console.warn('[record] failed to save turn:', err);
  }
}

/**
 * Lift a PronunciationAssessment + session context into the shape the web UI
 * consumes for inline transcript annotation. Per-word: score, error type, top
 * phoneme substitution, and whether the word is "above-level" (matches an
 * FSRS card the tutor is currently scaffolding — proves the learner reached).
 *
 * Returned shape is plain JSON so it survives the RPC boundary.
 */
function buildPronunciationRenderData(
  a: PronunciationAssessment,
  ctx: SessionContext,
): {
  reference_text: string;
  recognized_text?: string;
  overall: PronunciationAssessment['overall'];
  latency_ms: number;
  prosody?: PronunciationAssessment['prosody'];
  words: Array<{
    word: string;
    score: number;
    error_type: string;
    phoneme_sub?: { from: string; to: string };
    is_stretch: boolean;
  }>;
  divergence: boolean;
} {
  // FSRS items the tutor is actively scaffolding — these are the stretch
  // targets. A learner producing one unprompted = a green-highlighted moment.
  const stretchSet = new Set(
    (ctx.fsrsDueItems ?? []).map((i) => i.item_key.toLowerCase()),
  );

  const norm = (s: string | undefined) =>
    (s ?? '').replace(/[.,!?;:¿¡]/g, '').trim().toLowerCase();

  const words = a.words.map((w) => {
    // First phoneme substitution under threshold with an alternative — same
    // signal that drives the inline bracket display in the UI.
    const subSrc = w.phonemes?.find(
      (p) => p.accuracy_score < 70 && (p.alternatives?.length ?? 0) > 0,
    );
    const phoneme_sub = subSrc?.alternatives?.[0]
      ? { from: subSrc.phoneme, to: subSrc.alternatives[0].phoneme }
      : undefined;

    const cleanWord = norm(w.word);
    return {
      word: w.word,
      score: Math.round(w.accuracy_score),
      error_type: w.error_type,
      phoneme_sub,
      is_stretch: stretchSet.has(cleanWord),
    };
  });

  return {
    reference_text: a.reference_text,
    recognized_text: a.recognized_text,
    overall: a.overall,
    latency_ms: a.latency_ms,
    prosody: a.prosody,
    words,
    divergence: norm(a.recognized_text) !== norm(a.reference_text),
  };
}

const CARTESIA_VOICE_ID =
  process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c';

// For the prototype, a single hardcoded learner. Phase 4+ handles real auth.
const LEARNER_ID =
  process.env.LEARNER_ID || '00000000-0000-0000-0000-000000000aaa';

class SofiaAgent extends voice.Agent {
  public ctx: SessionContext;
  public controllerState: ControllerState;
  public assessor: PronunciationAssessor;
  private evalInFlight = false;

  /** PCM chunks for the IN-PROGRESS turn. Reset on PTT_start. */
  private currentTurnFrames: PcmChunk[] = [];

  /**
   * Whether the learner is currently holding PTT. Gates captureFrames so we
   * only buffer audio between ptt_start and ptt_end — not the silence between
   * turns or the agent's own speech reflecting back. The previous version
   * accumulated frames for the entire session lifetime, producing 30+ minute
   * "turn" recordings.
   */
  private pttActive = false;

  constructor(sessionContext: SessionContext, assessor: PronunciationAssessor) {
    const controllerState = initControllerState(sessionContext);
    super({
      instructions: buildSystemPrompt(sessionContext, { controllerState }),
    });
    this.ctx = sessionContext;
    this.controllerState = controllerState;
    this.assessor = assessor;
  }

  /**
   * Tee the audio stream so we capture a per-turn PCM buffer for pronunciation
   * assessment WITHOUT disturbing the STT pipeline. The default sttNode
   * receives one tee branch; the other branch flows into currentTurnFrames.
   *
   * Provider-agnostic: NoOp assessor produces zero overhead because we still
   * collect frames but the assess() call does nothing meaningful.
   */
  override async sttNode(
    audio: Parameters<voice.Agent['sttNode']>[0],
    modelSettings: Parameters<voice.Agent['sttNode']>[1],
  ): ReturnType<voice.Agent['sttNode']> {
    const [forStt, forCapture] = audio.tee();

    // Drain the capture branch concurrently. Errors here must not break STT.
    void this.captureFrames(forCapture).catch((err) => {
      console.warn('[pronunciation] capture branch failed:', err);
    });

    return voice.Agent.default.sttNode(this, forStt, modelSettings);
  }

  private async captureFrames(
    stream: Parameters<voice.Agent['sttNode']>[0],
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        if (!value) continue;
        // Only buffer frames between ptt_start and ptt_end. Without this gate
        // we accumulate audio for the entire agent lifetime — silence between
        // turns, Sofía's own speech feeding back, everything. Resulted in
        // 1913-second "turn" recordings on the first session.
        if (!this.pttActive) continue;
        this.currentTurnFrames.push({
          samples: value.data,
          sampleRate: value.sampleRate,
          channels: value.channels,
        });
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Called from the ptt_start RPC. Marks the start of a new turn — resets the
   * frame buffer (defensive: should already be empty after the prior flush)
   * and enables capture.
   */
  beginPttCapture(): void {
    this.currentTurnFrames = [];
    this.pttActive = true;
  }

  /**
   * Called from the ptt_end RPC. Stops accumulating frames. The buffer is
   * flushed by onUserTurnCompleted via flushTurnFrames().
   */
  endPttCapture(): void {
    this.pttActive = false;
  }

  /**
   * Snapshot and clear the current turn's frames. Called from the ptt_end RPC
   * so we get exactly the audio that was captured between push-to-talk events.
   */
  flushTurnFrames(): PcmChunk[] {
    const out = this.currentTurnFrames;
    this.currentTurnFrames = [];
    return out;
  }

  override async onEnter() {
    const isNewLearner =
      this.ctx.learnerCore.version === 0 &&
      this.ctx.learnerCore.session_trajectory.includes('No sessions yet');

    const greetingInstructions = isNewLearner
      ? "Greet the learner warmly with '¡Hola!' and introduce yourself as Sofía. " +
        'Ask what made them want to learn Spanish. Keep it brief and friendly.'
      : "Greet the learner warmly with '¡Hola!' and welcome them back. Briefly reference " +
        'something from the session trajectory to show continuity, and ask what they want to focus on today.';

    this.session.generateReply({ instructions: greetingInstructions });
  }

  override async onUserTurnCompleted(
    _chatCtx: llm.ChatContext,
    newMessage: llm.ChatMessage,
  ) {
    const text =
      typeof newMessage.content === 'string'
        ? newMessage.content
        : JSON.stringify(newMessage.content);

    this.ctx.fullTranscript.push({
      role: 'learner',
      text,
      ts: new Date(),
    });
    this.ctx.turnCount++;

    console.log(`[learner turn ${this.ctx.turnCount}] ${text}`);

    // Fire-and-forget difficulty evaluation. Never blocks the LLM response.
    // Result lands in controllerState and is picked up on the NEXT prompt rebuild.
    this.kickOffDifficultyEval();

    // Fire-and-forget pronunciation assessment on the recorded turn audio.
    // Result lands in ctx.recentAssessments and is surfaced on the NEXT prompt
    // rebuild as a [pronunciation] annotation under this turn's transcript line.
    const audioFrames = this.flushTurnFrames();
    if (audioFrames.length > 0) {
      this.kickOffPronunciationAssessment(text, audioFrames);
    }
  }

  private kickOffPronunciationAssessment(
    referenceText: string,
    frames: PcmChunk[],
  ): void {
    const turnNumber = this.ctx.turnCount;
    const startedAt = Date.now();

    // Always build the WAV when recording is enabled, even for noop assessor.
    // The replay harness will run alternate STT/scoring against it offline.
    const wav = chunksToWav(frames);
    const durationSec = chunkDurationSeconds(frames);

    if (this.assessor.name === 'noop') {
      saveTurnRecording(this.ctx.sessionId, turnNumber, wav, {
        reference_text: referenceText,
        duration_sec: Number(durationSec.toFixed(3)),
        sample_rate: frames[0]?.sampleRate,
        assessor: 'noop',
      });
      return;
    }

    void (async () => {
      try {
        if (durationSec < 0.3) {
          console.log(
            `[pronunciation] turn ${turnNumber}: skipping — only ${durationSec.toFixed(2)}s of audio captured`,
          );
          saveTurnRecording(this.ctx.sessionId, turnNumber, wav, {
            reference_text: referenceText,
            duration_sec: Number(durationSec.toFixed(3)),
            sample_rate: frames[0]?.sampleRate,
            skipped: 'too_short',
          });
          return;
        }

        const result = await this.assessor.assess({
          audio: wav,
          reference_text: referenceText,
          sample_rate: frames[0]?.sampleRate,
          language: 'es-mx',
        });

        saveTurnRecording(this.ctx.sessionId, turnNumber, wav, {
          reference_text: referenceText,
          recognized_text: result.recognized_text,
          duration_sec: Number(durationSec.toFixed(3)),
          sample_rate: frames[0]?.sampleRate,
          assessor: this.assessor.name,
          assessment: {
            overall: result.overall,
            words: result.words.map((w) => ({
              word: w.word,
              score: Math.round(w.accuracy_score),
              error_type: w.error_type,
            })),
            latency_ms: result.latency_ms,
          },
        });

        // Cap stored history so the debug payload doesn't grow unbounded.
        if (!this.ctx.recentAssessments) this.ctx.recentAssessments = [];
        this.ctx.recentAssessments.push(result);
        if (this.ctx.recentAssessments.length > MAX_STORED_ASSESSMENTS) {
          this.ctx.recentAssessments.shift();
        }

        // Rebuild the prompt so the next tutor turn sees the [pronunciation]
        // annotation under this turn's transcript line.
        (this as unknown as { _instructions: string })._instructions =
          buildSystemPrompt(this.ctx, {
            controllerState: this.controllerState,
          });

        console.log(
          `[pronunciation] turn ${turnNumber} (${durationSec.toFixed(2)}s) ` +
            `via ${this.assessor.name}: accuracy=${Math.round(result.overall.accuracy)} ` +
            `pronunciation=${Math.round(result.overall.pronunciation)} ` +
            `[${Date.now() - startedAt}ms total, ${result.latency_ms}ms api]`,
        );
      } catch (err) {
        console.warn('[pronunciation] assessment cycle failed:', err);
      }
    })();
  }

  private kickOffDifficultyEval(): void {
    // Single-flight: if a prior eval is still running, skip this one. The next
    // turn's eval will catch up — better than racing two writers on controllerState.
    if (this.evalInFlight) {
      console.log(
        `[difficulty] skipping eval for turn ${this.ctx.turnCount} — prior eval still in flight`,
      );
      return;
    }

    const turnNumber = this.ctx.turnCount;
    const shouldEdgeCheck =
      turnNumber > 0 && turnNumber % EDGE_CHECK_EVERY_N_TURNS === 0;

    this.evalInFlight = true;
    const startedAt = Date.now();

    void (async () => {
      try {
        const tasks: Promise<void>[] = [
          evaluateTurn(this.ctx, this.controllerState),
        ];
        if (shouldEdgeCheck) {
          tasks.push(evaluateEdge(this.ctx, this.controllerState));
        }
        await Promise.all(tasks);

        // Push the updated prompt so the NEXT tutor turn uses fresh ratio + directive.
        // LiveKit Agents JS 1.2 doesn't expose a public updateInstructions method;
        // the AgentActivity reads `this.agent.instructions` on every LLM call, which
        // is a getter over `_instructions`. Mutating it here is supported in practice
        // and is the same path the framework uses internally (agent_activity.cjs:271).
        // Revisit if we upgrade to a version that ships a public setter.
        (this as unknown as { _instructions: string })._instructions =
          buildSystemPrompt(this.ctx, {
            controllerState: this.controllerState,
          });

        console.log(
          `[difficulty] eval cycle for turn ${turnNumber} done in ${Date.now() - startedAt}ms ` +
            `(edge_check=${shouldEdgeCheck})`,
        );
      } catch (err) {
        console.warn('[agent] difficulty eval cycle failed:', err);
      } finally {
        this.evalInFlight = false;
      }
    })();
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // Load session context from Postgres (seeds a new learner if needed)
    console.log(`[agent] Loading session context for learner ${LEARNER_ID}`);
    const sessionContext = await loadSessionContext(LEARNER_ID);
    console.log(
      `[agent] Learner loaded: core_version=${sessionContext.learnerCore.version}, ` +
        `tutor_version=${sessionContext.tutorCore.version}, ` +
        `fsrs_due=${sessionContext.fsrsDueItems.length}, ` +
        `session_id=${sessionContext.sessionId}`,
    );

    const assessor = createAssessor();
    console.log(`[agent] Pronunciation assessor: ${assessor.name}`);

    const agent = new SofiaAgent(sessionContext, assessor);

    const session = new voice.AgentSession<SessionContext>({
      stt: new deepgram.STT({ model: 'nova-3', language: 'multi' }),
      llm: new openai.LLM({ model: 'gpt-4o' }),
      tts: new cartesia.TTS({
        model: 'sonic-3',
        voice: CARTESIA_VOICE_ID,
        language: 'es',
      }),
      vad: ctx.proc.userData.vad as silero.VAD,
      userData: sessionContext,
      turnHandling: {
        turnDetection: 'manual',
        interruption: { enabled: false },
      },
    });

    // Disable audio input initially (push-to-talk)
    session.input.setAudioEnabled(false);

    // Register push-to-talk RPC methods
    ctx.room.localParticipant!.registerRpcMethod('ptt_start', async () => {
      // interrupt() throws when interruption is disabled in turn handling
      // (which it is — see AgentSession config below). Swallow the throw so
      // the rest of the handler always runs; without this, setAudioEnabled
      // never got called and every PTT turn produced silent STT input.
      try {
        session.interrupt();
      } catch (err) {
        // expected when agent isn't currently speaking, or when interruption
        // is disabled — both are fine. Log at debug level only.
      }
      session.clearUserTurn();
      agent.beginPttCapture();
      session.input.setAudioEnabled(true);
      return JSON.stringify({ ok: true });
    });

    ctx.room.localParticipant!.registerRpcMethod('ptt_end', async () => {
      session.input.setAudioEnabled(false);
      agent.endPttCapture();
      session.commitUserTurn();
      return JSON.stringify({ ok: true });
    });

    // Debug snapshot RPC — returns current session state for the web debug panel
    ctx.room.localParticipant!.registerRpcMethod(
      'debug_snapshot',
      async () => {
        return JSON.stringify({
          learnerId: sessionContext.learnerId,
          sessionId: sessionContext.sessionId,
          learnerCore: sessionContext.learnerCore,
          tutorCore: sessionContext.tutorCore,
          fsrsDueItems: sessionContext.fsrsDueItems,
          turnCount: sessionContext.turnCount,
          sessionStartedAt: sessionContext.sessionStartedAt.toISOString(),
          systemPrompt: buildSystemPrompt(sessionContext, {
            controllerState: agent.controllerState,
          }),
          transcriptLength: sessionContext.fullTranscript.length,
          // Full transcript exposed for the scenario harness — the Node SDK
          // doesn't surface TranscriptionReceived events the way the browser
          // client does, so the harness polls this after each PTT turn.
          transcript: sessionContext.fullTranscript.map((t) => ({
            role: t.role,
            text: t.text,
            ts: t.ts instanceof Date ? t.ts.toISOString() : String(t.ts),
          })),
          controllerState: agent.controllerState,
          pronunciation: {
            provider: agent.assessor.name,
            recent: (sessionContext.recentAssessments ?? [])
              .slice(-5)
              .map((a) => buildPronunciationRenderData(a, sessionContext)),
          },
        });
      },
    );

    // End session RPC — triggers compaction and returns pre/post diff
    ctx.room.localParticipant!.registerRpcMethod(
      'end_session',
      async () => {
        console.log(
          `[agent] End session requested. Turns: ${sessionContext.turnCount}, transcript entries: ${sessionContext.fullTranscript.length}`,
        );

        // Stop listening during compaction
        session.input.setAudioEnabled(false);

        if (sessionContext.fullTranscript.length === 0) {
          return JSON.stringify({
            ok: false,
            error: 'Nothing to compact — no transcript entries yet',
          });
        }

        try {
          const outcome = await runCompaction(
            sessionContext,
            agent.controllerState,
          );
          return JSON.stringify({
            ok: true,
            preCores: outcome.preCores,
            postCores: {
              learner: outcome.result.learner_core,
              tutor: outcome.result.tutor_core,
            },
            fsrsUpdates: outcome.result.fsrs_updates,
            compactionNotes: outcome.result.compaction_notes,
            fsrsCreated: outcome.fsrsCreated,
            fsrsRated: outcome.fsrsRated,
            durationMs: outcome.durationMs,
          });
        } catch (err) {
          console.error('[agent] Compaction failed:', err);
          return JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    // Log state changes
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[agent] State: ${ev.newState}`);
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) {
        console.log(`[stt] Final: ${ev.transcript}`);
      }
    });

    // Log tutor (agent) speech for the full transcript
    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      (ev: { item: { role: string; textContent?: string } }) => {
        if (ev.item.role === 'assistant' && ev.item.textContent) {
          sessionContext.fullTranscript.push({
            role: 'tutor',
            text: ev.item.textContent,
            ts: new Date(),
          });
        }
      },
    );

    await session.start({ agent, room: ctx.room });
    console.log('[agent] Sofia is ready and waiting for a learner.');
  },
});

// agentName="sofia" pins this worker behind a named dispatch — the scenario
// harness creates explicit AgentDispatches per scenario room. The web app
// uses an auto-dispatched anonymous worker when none is set, so we still
// need a separate untagged worker (or explicit dispatch on connect) for that.
cli.runApp(new ServerOptions({ agent: import.meta.filename, agentName: 'sofia' }));

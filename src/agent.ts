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
for (const k of [
  'ANTHROPIC_API_KEY',
  'DEEPGRAM_API_KEY',
  'OPENAI_API_KEY',
  'CARTESIA_API_KEY',
  'ASSEMBLYAI_API_KEY',
]) {
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
import * as assemblyai from '@livekit/agents-plugin-assemblyai';
import * as google from '@livekit/agents-plugin-google';
import * as inworld from '@livekit/agents-plugin-inworld';
import { ChirpTTS } from './chirp-tts.js';

import {
  loadSessionContext,
  type SessionContext,
  type SessionMode,
} from './session-context.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { runCompaction } from './compaction.js';
import { persistPlacement } from './placement.js';
import {
  initControllerState,
  evaluateTurn,
  evaluateEdge,
  evaluateCalibrationTurn,
  finalizePlacement,
  ratioToCefr,
  type ControllerState,
} from './difficulty-controller.js';
import {
  createAssessor,
  type PronunciationAssessor,
} from './pronunciation/index.js';
// TTS catalog is consumed by the token-server (validation + /debug/config)
// and by the React picker. agent.ts doesn't need to import it directly — it
// just receives the already-validated provider/voice pair via dispatch metadata.
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

// Pick the live STT provider at runtime. Default is AssemblyAI Universal-3 Pro
// Streaming — empirically much more accurate on noisy code-switched Spanish/English
// than Deepgram nova-3 multi. U3 Pro Streaming silently ignores `language_code`,
// so we steer multilingual behavior via the `prompt` field per AssemblyAI's docs.
// The Spanish vocabulary in `keytermsPrompt` biases away from common mistakes
// observed in earlier sessions ("Functionar", "Acesa", "verdas", etc.).
//
// Precedence (highest first):
//   1. dispatch metadata override (per-session pick from the web app's STT
//      selector — see resolveSttChoice).
//   2. STT_PROVIDER env var (server-side default).
//   3. Hardcoded fallback to assemblyai.
function createStt(override?: string) {
  const provider = (
    override ||
    process.env.STT_PROVIDER ||
    'assemblyai'
  ).toLowerCase();
  if (provider === 'deepgram') {
    console.log('[agent] STT: deepgram nova-3 (language=multi)');
    return new deepgram.STT({ model: 'nova-3', language: 'multi' });
  }
  console.log('[agent] STT: assemblyai u3-rt-pro (multilingual prompt)');
  return new assemblyai.STT({
    speechModel: 'u3-rt-pro',
    prompt: 'Transcribe Spanish and English. The speaker is a Spanish learner who code-switches frequently.',
    keytermsPrompt: [
      'hola', 'gracias', 'por favor', 'sí', 'no', 'español',
      'puedo', 'quiero', 'estoy', 'soy', 'tengo', 'voy',
      'hablar', 'comer', 'beber', 'ver', 'entender', 'aprender',
      'palabras', 'pronunciación', 'anotaciones', 'programa',
      'México', 'España', 'Argentina',
    ],
    formatTurns: true,
  });
}

/**
 * Read the per-session STT override from dispatch metadata. Mirrors
 * resolveTtsChoice — same JSON, different field. Returns undefined when no
 * stt field is present so createStt() falls through to its env default.
 */
function resolveSttChoice(ctx: JobContext): string | undefined {
  const raw = ctx.job?.metadata;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const v = parsed?.stt;
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {
    // Older dispatch metadata was a bare learner id (not JSON). Ignore.
  }
  return undefined;
}

// Sofía's TTS persona — handed to providers that accept a style instruction
// (Gemini). Keeps the voice warm and unhurried regardless of which engine
// renders it.
const SOFIA_TTS_STYLE =
  'Speak as Sofía: a warm, patient, encouraging Spanish tutor. ' +
  'Natural conversational pace, gentle and clear, never rushed.';

// Pick a TTS at runtime so we can flip providers without code edits when one
// goes down or runs out of credits. Precedence (highest first):
//   1. dispatch metadata (`override.provider` + `override.voice` from the
//      web app's voice picker — see resolveTtsChoice)
//   2. TTS_PROVIDER env var (server-side default)
//   3. Hardcoded fallback to Cartesia, the original Habla voice.
//
// `override.legacyChoice` is the OLD single-string `tts` value still produced
// by older browser sessions (cartesia | openai | google-flash | google-pro |
// inworld). When present and `provider` is absent, it picks the branch.
function createTts(
  override?: { provider?: string; voice?: string; legacyChoice?: string },
) {
  // The new structured override beats everything except the env when both
  // sides are empty. legacyChoice is a separate code path: it dispatches by
  // the historical compound id (google-flash, google-pro, inworld) that the
  // new catalog doesn't model.
  const rawProvider =
    override?.provider ||
    override?.legacyChoice ||
    process.env.TTS_PROVIDER ||
    'cartesia';
  const provider = rawProvider.toLowerCase();
  const voiceOverride = override?.voice;

  if (provider === 'openai') {
    const voice = (voiceOverride || process.env.OPENAI_TTS_VOICE || 'shimmer') as
      | 'alloy'
      | 'ash'
      | 'ballad'
      | 'coral'
      | 'echo'
      | 'fable'
      | 'nova'
      | 'onyx'
      | 'sage'
      | 'shimmer';
    console.log(`[agent] TTS: openai gpt-4o-mini-tts (voice=${voice})`);
    return new openai.TTS({ model: 'gpt-4o-mini-tts', voice });
  }

  // New: the catalog-driven `google` provider. Uses the Gemini 2.5 Flash TTS
  // surface from @livekit/agents-plugin-google (the only Google TTS in the
  // 1.2.6 plugin). voiceOverride is a Gemini voice name (Achernar, Aoede,
  // etc.) — see TTS_CATALOG.google. We keep the SOFIA_TTS_STYLE prompt so
  // Sofía sounds consistent regardless of voice.
  if (provider === 'google') {
    const model = 'gemini-2.5-flash-tts';
    // TODO: when the plugin exposes Cloud TTS (Chirp 3 HD / Studio voices),
    // switch on a voice id like `es-US-Chirp3-HD-Achernar` here and route to
    // the Cloud TTS surface. Until then we map to the Gemini voice name of
    // the same suffix (Achernar, Aoede, …).
    const voiceName = voiceOverride || process.env.GEMINI_TTS_VOICE || 'Aoede';
    console.log(`[agent] TTS: google ${model} (voice=${voiceName})`);
    return new google.beta.TTS({
      model,
      voiceName,
      apiKey: process.env.GOOGLE_API_KEY,
      instructions: SOFIA_TTS_STYLE,
    });
  }

  // Google Cloud TTS — Chirp 3 HD. Custom adapter in src/chirp-tts.ts because
  // @livekit/agents-plugin-google (pinned at 1.2.6) only exposes the Gemini
  // surface. Uses the same GOOGLE_API_KEY as the Gemini path; throws loudly
  // at construction if the key is missing so we never silently degrade.
  if (provider === 'chirp') {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[agent] TTS provider=chirp requires GOOGLE_API_KEY. Set it in .env ' +
          '(same key used for Gemini — enable the Cloud Text-to-Speech API on ' +
          'the project at https://console.cloud.google.com/apis).',
      );
    }
    const voiceName = voiceOverride || 'es-US-Chirp3-HD-Aoede';
    console.log(`[agent] TTS: google cloud chirp-3-hd (voice=${voiceName})`);
    return new ChirpTTS({
      voiceName,
      languageCode: 'es-US',
      apiKey,
    });
  }

  // Legacy two-tier Gemini selection used by older sessions that picked the
  // compound id from the previous voice dropdown. Kept so existing browser
  // tabs don't break the agent if they reconnect with stale localStorage.
  if (provider === 'google-flash' || provider === 'google-pro') {
    const model =
      provider === 'google-pro'
        ? 'gemini-2.5-pro-tts'
        : 'gemini-2.5-flash-tts';
    const voiceName = voiceOverride || process.env.GEMINI_TTS_VOICE || 'Aoede';
    console.log(`[agent] TTS: google ${model} (voice=${voiceName})`);
    return new google.beta.TTS({
      model,
      voiceName,
      apiKey: process.env.GOOGLE_API_KEY,
      instructions: SOFIA_TTS_STYLE,
    });
  }

  if (provider === 'inworld') {
    const model = process.env.INWORLD_TTS_MODEL || 'inworld-tts-2';
    const voice = voiceOverride || process.env.INWORLD_VOICE || 'Ashley';
    console.log(`[agent] TTS: inworld ${model} (voice=${voice})`);
    return new inworld.TTS({
      model,
      voice,
      apiKey: process.env.INWORLD_API_KEY,
    });
  }

  // Cartesia is the final fallback; the voice override is a Cartesia voice
  // UUID (see TTS_CATALOG.cartesia).
  const cartesiaVoice = voiceOverride || CARTESIA_VOICE_ID;
  console.log(`[agent] TTS: cartesia sonic-3 (voice=${cartesiaVoice})`);
  return new cartesia.TTS({
    model: 'sonic-3',
    voice: cartesiaVoice,
    language: 'es',
  });
}

// Fallback learner used when the dispatch metadata doesn't carry one (older
// scripts, the scenario harness, etc.). The web prototype passes the real
// learnerId from the signed-up user via the dispatch metadata — see
// resolveLearnerId() in entry().
const FALLBACK_LEARNER_ID =
  process.env.LEARNER_ID || '00000000-0000-0000-0000-000000000aaa';

/**
 * Read the learner id from the JobContext's dispatch metadata if present,
 * otherwise fall back to FALLBACK_LEARNER_ID. The token-server stamps the
 * dispatch with `{"learnerId": "<uuid>"}` so each browser session lands on
 * the right Postgres row.
 */
function resolveLearnerId(ctx: JobContext): string {
  const raw = ctx.job?.metadata;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.learnerId === 'string' && parsed.learnerId.length > 0) {
        return parsed.learnerId;
      }
    } catch {
      // Metadata wasn't JSON. Treat it as a raw learner id if it looks like one.
      if (/^[0-9a-fA-F-]{8,}$/.test(raw)) return raw;
    }
  }
  return FALLBACK_LEARNER_ID;
}

/**
 * Read the TTS provider choice from dispatch metadata, stamped by the
 * token-server from the web app's voice selector.
 *
 * The metadata may carry either the new structured form
 *   { "ttsProvider": "google", "ttsVoice": "Achernar" }
 * or the legacy compound-id form
 *   { "tts": "google-flash" }
 * Both are returned to createTts() — when both are present the structured
 * form wins. Returns an empty object when no TTS fields are present.
 */
function resolveTtsChoice(
  ctx: JobContext,
): { provider?: string; voice?: string; legacyChoice?: string } {
  const raw = ctx.job?.metadata;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: { provider?: string; voice?: string; legacyChoice?: string } = {};
    if (typeof parsed.ttsProvider === 'string' && parsed.ttsProvider.length > 0) {
      out.provider = parsed.ttsProvider;
    }
    if (typeof parsed.ttsVoice === 'string' && parsed.ttsVoice.length > 0) {
      out.voice = parsed.ttsVoice;
    }
    if (typeof parsed.tts === 'string' && parsed.tts.length > 0) {
      out.legacyChoice = parsed.tts;
    }
    return out;
  } catch {
    // metadata wasn't JSON — no tts choice to read
    return {};
  }
}

/**
 * Read the session mode from dispatch metadata (`{"mode":"placement"}`),
 * stamped by the token-server when the web app opens the post-signup
 * placement. Anything else (or absent metadata) is a normal session.
 */
function resolveMode(ctx: JobContext): SessionMode {
  const raw = ctx.job?.metadata;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.mode === 'placement') return 'placement';
    } catch {
      // metadata wasn't JSON — treat as a normal session
    }
  }
  return 'normal';
}

/**
 * Pull a plain text string out of an llm.ChatMessage.content payload. The
 * field is union-typed in the agents SDK — sometimes a bare string, sometimes
 * an array of content parts (each part either a string or `{type:'text',
 * text:'...'}`). Doing JSON.stringify on the array (the previous behavior)
 * meant the pronunciation reference_text was the literal `'["..."]'` with
 * brackets — which never matched the cleaned bubble text on the web client,
 * so the inline word annotations and summary band never rendered.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (typeof p === 'string') {
      parts.push(p);
    } else if (
      p &&
      typeof p === 'object' &&
      'text' in p &&
      typeof (p as { text: unknown }).text === 'string'
    ) {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.join(' ').trim();
}

class SofiaAgent extends voice.Agent {
  public ctx: SessionContext;
  public controllerState: ControllerState;
  public assessor: PronunciationAssessor;
  /**
   * Injected by entry() after the JobContext is available. Wraps
   * ctx.room.localParticipant.publishData so the web client receives
   * per-turn pronunciation render data as soon as Azure (or whichever
   * provider) returns. Optional so unit tests / scripted harnesses can
   * construct the agent without a live room.
   */
  public publishToRoom?: (data: Uint8Array, topic: string) => Promise<void>;
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
    // Placement sessions drive the calibration controller — it opens the
    // learner below their self-rated level and converges from there.
    const controllerState = initControllerState(
      sessionContext,
      sessionContext.mode === 'placement' ? 'calibration' : 'normal',
    );
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
    // Placement: open the calibration conversation in English. The example
    // line is deliberately concrete — describing the greeting abstractly led
    // gpt-4o to render the whole thing in Spanish.
    if (this.ctx.mode === 'placement') {
      this.session.generateReply({
        instructions:
          'This is the very first thing the learner hears. Speak it in ENGLISH — ' +
          'real English sentences, NOT Spanish and NOT a Spanish translation of an ' +
          'English idea. The only Spanish in this turn is the word "Hola" and your ' +
          'own name. Say something close to: "Hola! I\'m Sofía, your Spanish tutor. ' +
          "Let's just chat for a few minutes so I can get a feel for your Spanish — " +
          "there's no test and nothing to get right, so talk however feels natural " +
          'to you. To start — what made you want to learn Spanish?" Keep it that ' +
          'short, warm, and in English.',
      });
      return;
    }

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
    const text = extractMessageText(newMessage.content);

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

        // Push per-word render data to the web client so the learner's last
        // bubble can light up with phoneme citations in real time. Best-effort:
        // a failed publish must not interfere with the conversation.
        try {
          const payload = {
            type: 'pronunciation',
            turn: turnNumber,
            ...buildPronunciationRenderData(result, this.ctx),
          };
          const encoded = new TextEncoder().encode(JSON.stringify(payload));
          await this.publishToRoom?.(encoded, 'pronunciation');
        } catch (err) {
          console.warn('[pronunciation] publish to web failed:', err);
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
    const isPlacement = this.ctx.mode === 'placement';
    const shouldEdgeCheck =
      !isPlacement &&
      turnNumber > 0 &&
      turnNumber % EDGE_CHECK_EVERY_N_TURNS === 0;

    this.evalInFlight = true;
    const startedAt = Date.now();

    void (async () => {
      try {
        if (isPlacement) {
          // Placement: the calibration controller converges the placement
          // target toward the learner's demonstrated level.
          await evaluateCalibrationTurn(this.ctx, this.controllerState);
          // Push a live calibration snapshot to the web client so the Placement
          // debug bar can render the current ratio, CEFR, and confidence the
          // instant the classifier returns. Best-effort: a failed publish must
          // never interfere with the placement flow.
          this.publishCalibrationSnapshot(turnNumber);
        } else {
          const tasks: Promise<void>[] = [
            evaluateTurn(this.ctx, this.controllerState),
          ];
          if (shouldEdgeCheck) {
            tasks.push(evaluateEdge(this.ctx, this.controllerState));
          }
          await Promise.all(tasks);
        }

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
            `(mode=${this.ctx.mode}, edge_check=${shouldEdgeCheck})`,
        );
      } catch (err) {
        console.warn('[agent] difficulty eval cycle failed:', err);
      } finally {
        this.evalInFlight = false;
      }
    })();
  }

  /**
   * Best-effort live snapshot of the calibration controller, broadcast over the
   * LiveKit data channel under topic "placement_calibration". The Placement
   * page renders this as a live debug bar showing where calibration is sitting
   * after the most recent learner turn. Wrapped in try/catch — placement must
   * continue cleanly even if publishData fails.
   */
  private publishCalibrationSnapshot(turnIndex: number): void {
    try {
      const state = this.controllerState;
      const lastCalib =
        state.calibration_turns[state.calibration_turns.length - 1];
      // Find the last learner utterance for a short context snippet.
      let learnerSnippet: string | undefined;
      for (let i = this.ctx.fullTranscript.length - 1; i >= 0; i--) {
        const e = this.ctx.fullTranscript[i];
        if (e.role === 'learner' && e.text) {
          learnerSnippet = e.text.length > 80 ? e.text.slice(0, 77) + '…' : e.text;
          break;
        }
      }
      const ratio = state.current_ratio_target;
      const payload: PlacementCalibrationSnapshot = {
        turnIndex,
        ratio,
        cefr: ratioToCefr(ratio) as PlacementCalibrationSnapshot['cefr'],
        confidence: lastCalib?.confidence ?? 0,
        markedRatio: state.marked_ratio,
        learnerSnippet,
      };
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      // Fire-and-forget: don't await — placement flow must not depend on this.
      void this.publishToRoom?.(encoded, 'placement_calibration').catch((err) => {
        console.warn('[calibration] publish to web failed:', err);
      });
    } catch (err) {
      console.warn('[calibration] snapshot build failed:', err);
    }
  }
}

/**
 * Live calibration snapshot payload — duplicated on the web side in
 * web/src/lib/voice.ts because the bundler can't import backend types
 * directly. Keep the two shapes in sync.
 */
export interface PlacementCalibrationSnapshot {
  turnIndex: number;
  ratio: number;
  cefr: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  confidence: number;
  markedRatio: number;
  learnerSnippet?: string;
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // Load session context from Postgres (seeds a new learner if needed).
    // learnerId comes from the dispatch metadata stamped by the token-server.
    const learnerId = resolveLearnerId(ctx);
    const mode = resolveMode(ctx);
    console.log(
      `[agent] Loading session context for learner ${learnerId} (mode=${mode})`,
    );
    const sessionContext = await loadSessionContext(learnerId, mode);
    console.log(
      `[agent] Learner loaded: mode=${sessionContext.mode}, ` +
        `marked_level=${sessionContext.markedCefrLevel ?? '∅'}, ` +
        `core_version=${sessionContext.learnerCore.version}, ` +
        `tutor_version=${sessionContext.tutorCore.version}, ` +
        `fsrs_due=${sessionContext.fsrsDueItems.length}, ` +
        `session_id=${sessionContext.sessionId}`,
    );

    const assessor = createAssessor();
    console.log(`[agent] Pronunciation assessor: ${assessor.name}`);

    const agent = new SofiaAgent(sessionContext, assessor);
    // Bind the live room's data publisher onto the agent so onUserTurnCompleted
    // can stream pronunciation results to the web client without needing a
    // direct ctx reference inside the agent class.
    agent.publishToRoom = async (data, topic) => {
      const lp = ctx.room.localParticipant;
      if (!lp) return;
      await lp.publishData(data, { topic, reliable: true });
    };

    const ttsChoice = resolveTtsChoice(ctx);
    if (ttsChoice.provider || ttsChoice.voice || ttsChoice.legacyChoice) {
      console.log(
        `[agent] TTS override from dispatch metadata: provider=${ttsChoice.provider ?? '∅'} ` +
          `voice=${ttsChoice.voice ?? '∅'} legacy=${ttsChoice.legacyChoice ?? '∅'}`,
      );
    }
    const sttChoice = resolveSttChoice(ctx);
    if (sttChoice) {
      console.log(`[agent] STT override from dispatch metadata: ${sttChoice}`);
    }
    const session = new voice.AgentSession<SessionContext>({
      stt: createStt(sttChoice),
      llm: new openai.LLM({ model: 'gpt-4o' }),
      tts: createTts(ttsChoice),
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

    // End session RPC — triggers compaction and returns pre/post diff.
    //
    // Payload shape: `{ "compact"?: boolean }` (JSON). Default is true — i.e.
    // a legacy empty payload still runs compaction, preserving the contract
    // for older browser builds. When `compact: false`, we skip the LLM call,
    // skip the FSRS writes, and return `{ok: true, skipped: true}` — useful
    // when the learner wants to bail mid-session without burning a Claude
    // request or polluting their cores with a half-finished conversation.
    ctx.room.localParticipant!.registerRpcMethod(
      'end_session',
      async (rpc) => {
        let compact = true;
        if (rpc.payload && rpc.payload.length > 0) {
          try {
            const parsed = JSON.parse(rpc.payload);
            if (parsed && parsed.compact === false) compact = false;
          } catch {
            console.warn('[agent] end_session payload not JSON, defaulting to compact=true');
          }
        }

        console.log(
          `[agent] End session requested (compact=${compact}). Turns: ${sessionContext.turnCount}, transcript entries: ${sessionContext.fullTranscript.length}`,
        );

        // Stop listening regardless of whether we compact.
        session.input.setAudioEnabled(false);

        if (!compact) {
          return JSON.stringify({
            ok: true,
            skipped: true,
            transcriptLength: sessionContext.fullTranscript.length,
            turnCount: sessionContext.turnCount,
          });
        }

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

    // Placement wrap RPC — the web app fires this ~30s before the placement
    // timer ends so Sofía gives a warm spoken close. No-op outside placement.
    ctx.room.localParticipant!.registerRpcMethod(
      'placement_wrap',
      async () => {
        if (sessionContext.mode !== 'placement') {
          return JSON.stringify({ ok: false, error: 'not a placement session' });
        }
        session.generateReply({
          instructions:
            'The placement is wrapping up now. Give a warm, brief closing — mostly ' +
            "in English — thanking the learner, telling them you've got a good feel " +
            'for where to begin, and that the real conversations start now. Do not ' +
            'say any level, number, or score out loud.',
        });
        return JSON.stringify({ ok: true });
      },
    );

    // End placement RPC — finalizes the calibration, persists the calibrated
    // level to the learner/tutor cores, and returns the placed level for the
    // result card. Distinct from end_session: deterministic, no compaction LLM.
    ctx.room.localParticipant!.registerRpcMethod(
      'end_placement',
      async () => {
        console.log(
          `[agent] End placement requested. Turns: ${sessionContext.turnCount}, ` +
            `calibration steps: ${agent.controllerState.calibration_step_count}`,
        );
        session.input.setAudioEnabled(false);

        if (sessionContext.mode !== 'placement') {
          return JSON.stringify({
            ok: false,
            error: 'not a placement session',
          });
        }

        try {
          const result = finalizePlacement(agent.controllerState);
          await persistPlacement(sessionContext, agent.controllerState, result);
          return JSON.stringify({
            ok: true,
            placedLevel: result.cefr_level,
            placedRatio: result.ratio,
            markedLevel: sessionContext.markedCefrLevel ?? null,
            confidence: result.confidence,
            converged: result.converged,
            calibrationTurns: result.calibration_turns,
          });
        } catch (err) {
          console.error('[agent] persistPlacement failed:', err);
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

// agentName pins this worker behind a named dispatch — the scenario harness
// creates explicit AgentDispatches per scenario room. It's env-configurable
// (SOFIA_AGENT_NAME, default "sofia") so a second stack — e.g. a feature
// worktree — can run its own agent under a distinct name on the same LiveKit
// project without stealing dispatches from the primary one. The token-server
// already reads the same env var when it creates dispatches.
cli.runApp(
  new ServerOptions({
    agent: import.meta.filename,
    agentName: process.env.SOFIA_AGENT_NAME || 'sofia',
  }),
);

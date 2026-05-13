/**
 * Scenario harness — drives a scripted "learner" through a real LiveKit room
 * against the real Sofía agent process, captures everything the test plan
 * cares about, and writes a structured artifact for downstream judging.
 *
 * The harness mirrors the web app's PTT flow exactly:
 *   1. Join the LiveKit room as participant identity 'learner'
 *   2. Wait for the agent to join (matches the web app's findAgentIdentity)
 *   3. For each scripted turn:
 *        a. Synthesize the learner's line as a 48 kHz mono WAV (Cartesia for ES,
 *           OpenAI gpt-4o-mini-tts for EN — different vendors so the Spanish
 *           voice never accidentally translates English)
 *        b. Push the audio through an AudioSource bound to a published track
 *        c. Send the agent ptt_start RPC, stream the frames, send ptt_end
 *        d. Wait for the tutor turn to land (subscribe to TranscriptionReceived)
 *        e. Poll debug_snapshot to capture controller state + pronunciation
 *   4. Optionally end the session and capture the compaction diff
 *
 * The artifact written per run is a single .jsonl in scenarios/<scenario>/<runId>/
 * with one record per event. That feeds Layer 3's judge.
 */

import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import {
  Room,
  RoomEvent,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  AudioFrame,
  TrackSource,
} from '@livekit/rtc-node';
import { chunksToWav, type PcmChunk } from '../src/pronunciation/wav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ────────────────────────────────────────────────────────────

export type LineLang = 'es' | 'en' | 'mixed';

/** One scripted learner turn — text + which TTS to use. */
export interface ScriptedTurn {
  text: string;
  /** Which voice to use for this line. 'mixed' splits on a separator. */
  language: LineLang;
  /** Optional silence to inject before this line, simulating thinking. */
  pauseBeforeSec?: number;
  /** Optional override of which agent turn (1-indexed) we expect this to follow. */
  expectedTutorTurnIndex?: number;
}

export interface Scenario {
  name: string;
  description: string;
  /** Maximum wall-clock seconds before we give up. */
  budgetSec: number;
  turns: ScriptedTurn[];
  /** Run end_session at the end of the scenario? */
  endWithCompaction?: boolean;
}

interface CapturedEvent {
  ts: number;
  type:
    | 'learner-turn-end'
    | 'tutor-turn-final'
    | 'tutor-turn-interim'
    | 'agent-state'
    | 'debug-snapshot'
    | 'compaction'
    | 'note';
  data: unknown;
}

// ── Synthesis ────────────────────────────────────────────────────────

const SAMPLE_RATE = 48_000; // LiveKit's standard mic capture rate

async function cartesiaSynth(text: string, language: 'es' | 'en'): Promise<Buffer> {
  const resp = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.CARTESIA_API_KEY!,
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: text,
      voice: {
        mode: 'id',
        id: process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c',
      },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: SAMPLE_RATE,
      },
      language,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Cartesia HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

/** OpenAI gpt-4o-mini-tts → linearly upsample 24 kHz to 48 kHz. */
async function openaiSynth(text: string): Promise<Buffer> {
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: 'alloy',
      response_format: 'pcm', // 24 kHz mono signed-16 LE
    }),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI TTS HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return upsample24kTo48k(Buffer.from(await resp.arrayBuffer()));
}

/** Cheap linear upsampling 24 kHz → 48 kHz (duplicate sample). Good enough for STT. */
function upsample24kTo48k(pcm24k: Buffer): Buffer {
  const samplesIn = new Int16Array(
    pcm24k.buffer,
    pcm24k.byteOffset,
    pcm24k.length / 2,
  );
  const samplesOut = new Int16Array(samplesIn.length * 2);
  for (let i = 0; i < samplesIn.length; i++) {
    samplesOut[2 * i] = samplesIn[i];
    samplesOut[2 * i + 1] = samplesIn[i];
  }
  return Buffer.from(
    samplesOut.buffer,
    samplesOut.byteOffset,
    samplesOut.byteLength,
  );
}

/**
 * Wrap a Node Buffer of PCM bytes as an Int16Array. Critical: pass byteOffset
 * and length explicitly. Node buffers are slices of shared ArrayBuffer pools,
 * so naively using `buf.buffer` reads beyond the buffer's valid bytes into
 * unrelated memory — which sounds like silence to Deepgram and made our
 * first scenario run record empty learner turns despite "successful" capture.
 */
function bufferToInt16(buf: Buffer): Int16Array {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

/**
 * Synthesize a single scripted turn. For 'mixed' lines, split on the literal
 * `|` separator: anything before is Spanish (Cartesia), after is English (OpenAI).
 */
async function synthesizeTurn(turn: ScriptedTurn): Promise<Int16Array> {
  if (turn.language === 'es') {
    return bufferToInt16(await cartesiaSynth(turn.text, 'es'));
  }
  if (turn.language === 'en') {
    return bufferToInt16(await openaiSynth(turn.text));
  }
  // mixed
  const parts = turn.text.split('|');
  const blobs: Int16Array[] = [];
  for (let i = 0; i < parts.length; i++) {
    const trimmed = parts[i].trim();
    if (!trimmed) continue;
    const isEs = i % 2 === 0; // first part Spanish, then alternates
    const pcm = isEs
      ? bufferToInt16(await cartesiaSynth(trimmed, 'es'))
      : bufferToInt16(await openaiSynth(trimmed));
    blobs.push(pcm);
    // small natural gap between language switches
    blobs.push(new Int16Array(Math.floor(0.25 * SAMPLE_RATE)));
  }
  const totalLen = blobs.reduce((n, b) => n + b.length, 0);
  const out = new Int16Array(totalLen);
  let off = 0;
  for (const b of blobs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

// ── LiveKit driver ───────────────────────────────────────────────────

/**
 * Push 10ms frames at real-time pacing through an AudioSource. The agent
 * captures frames in its sttNode and that capture only fires while ptt_start
 * has run, so we open the gate before streaming and close it after.
 */
async function streamFrames(
  source: AudioSource,
  samples: Int16Array,
  sampleRate: number,
): Promise<void> {
  const FRAME_MS = 10;
  const samplesPerFrame = Math.floor((sampleRate * FRAME_MS) / 1000);
  const start = Date.now();
  let cursor = 0;
  let frameIdx = 0;

  while (cursor < samples.length) {
    const slice = samples.subarray(cursor, cursor + samplesPerFrame);
    const frame = new AudioFrame(slice, sampleRate, 1, slice.length);
    await source.captureFrame(frame);
    cursor += slice.length;
    frameIdx++;
    // Real-time pacing — don't dump everything at once or the agent's VAD/STT
    // sees a 5-second burst it can't decode realistically.
    const targetElapsed = frameIdx * FRAME_MS;
    const realElapsed = Date.now() - start;
    if (targetElapsed > realElapsed) {
      await new Promise((r) => setTimeout(r, targetElapsed - realElapsed));
    }
  }
  // Tail silence so the agent sees clean end-of-turn audio
  const tail = new Int16Array(samplesPerFrame * 10); // 100ms
  await source.captureFrame(new AudioFrame(tail, sampleRate, 1, tail.length));
}

/** Wrap performRpc so a single failure doesn't crash the harness mid-scenario. */
async function safeRpc(
  room: Room,
  destinationIdentity: string,
  method: string,
  responseTimeout = 8_000,
): Promise<string | null> {
  try {
    return await room.localParticipant!.performRpc({
      destinationIdentity,
      method,
      payload: '',
      responseTimeout,
    });
  } catch (err) {
    console.warn(`  rpc(${method}) failed:`, err);
    return null;
  }
}

/** Stable short hash for the system prompt — useful for diffing across turns. */
function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function buildLearnerToken(roomName: string): Promise<string> {
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    {
      identity: 'learner',
      name: 'learner',
      ttl: '15m',
    },
  );
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

// ── Per-scenario runner ──────────────────────────────────────────────

export async function runScenario(scenario: Scenario): Promise<string> {
  const runId = `${Date.now()}`;
  const outDir = join(__dirname, '..', 'scenarios', scenario.name, runId);
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, 'events.jsonl');
  const metaPath = join(outDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify(scenario, null, 2));
  const startedAt = Date.now();

  const log = (e: CapturedEvent) => {
    appendFileSync(logPath, JSON.stringify({ ...e, ts: e.ts - startedAt }) + '\n');
  };

  console.log(`\n══════ Scenario: ${scenario.name} ══════`);
  console.log(`  ${scenario.description}`);
  console.log(`  Run ID: ${runId}`);
  console.log(`  Artifacts → ${outDir}\n`);

  const roomName = `scenario-${scenario.name}-${runId}`;
  const token = await buildLearnerToken(roomName);

  // Explicitly dispatch the named "sofia" agent into the scenario room so the
  // test isn't dependent on project-level auto-dispatch config.
  const dispatchClient = new AgentDispatchClient(
    process.env.LIVEKIT_URL!.replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://'),
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  console.log(`Dispatching agent 'sofia' to room ${roomName}…`);
  try {
    const dispatch = await dispatchClient.createDispatch(roomName, 'sofia');
    log({ ts: Date.now(), type: 'note', data: { msg: 'agent dispatched', dispatchId: dispatch.id } });
  } catch (err) {
    console.warn('  dispatch failed:', err);
    log({ ts: Date.now(), type: 'note', data: { msg: 'dispatch failed', err: String(err) } });
  }

  const room = new Room();
  let agentIdentity: string | null = null;
  let agentState: string = 'unknown';

  room.on(RoomEvent.ParticipantConnected, (p) => {
    if (p.attributes && p.attributes['lk.agent.state']) {
      agentIdentity = p.identity;
      agentState = p.attributes['lk.agent.state'];
      log({
        ts: Date.now(),
        type: 'agent-state',
        data: { state: agentState, identity: p.identity },
      });
    }
  });
  room.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
    if (changed['lk.agent.state']) {
      agentIdentity = p.identity;
      agentState = changed['lk.agent.state'];
      log({ ts: Date.now(), type: 'agent-state', data: { state: agentState } });
    }
  });

  /** Wait for the agent to be done speaking before we PTT. */
  const waitForListening = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (agentState === 'listening' || agentState === 'idle') return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Agent did not reach 'listening' within ${timeoutMs}ms (last state: ${agentState})`);
  };

  console.log(`Connecting to ${process.env.LIVEKIT_URL} as 'learner'…`);
  await room.connect(process.env.LIVEKIT_URL!, token);
  log({ ts: Date.now(), type: 'note', data: { msg: 'learner connected', room: roomName } });

  // Wait for the agent worker to dispatch into this room.
  console.log('Waiting for Sofía to join…');
  const agentDeadline = Date.now() + 30_000;
  while (!agentIdentity && Date.now() < agentDeadline) {
    for (const [, p] of room.remoteParticipants) {
      if (p.attributes && p.attributes['lk.agent.state']) {
        agentIdentity = p.identity;
        break;
      }
    }
    if (agentIdentity) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!agentIdentity) {
    throw new Error('Sofía never joined the room within 30s');
  }
  console.log(`  Sofía joined as ${agentIdentity}`);

  // Publish our learner mic track.
  const source = new AudioSource(SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack('learner-mic', source);
  const publishOpts = new TrackPublishOptions();
  publishOpts.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(track, publishOpts);
  log({ ts: Date.now(), type: 'note', data: { msg: 'learner mic published' } });

  // Drive turns.
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    console.log(`\n── Learner turn ${i + 1}/${scenario.turns.length}: [${turn.language}] "${turn.text.slice(0, 80)}…"`);

    // Synthesize while the agent finishes its previous turn — overlaps cleanly.
    const samples = await synthesizeTurn(turn);
    // Compute peak amplitude — if it's zero, synthesis is broken before
    // we even hit the LiveKit publish path.
    let peak = 0;
    for (let k = 0; k < Math.min(samples.length, 5000); k++) {
      if (Math.abs(samples[k]) > peak) peak = Math.abs(samples[k]);
    }
    // Dump the first synthesized turn as a WAV so we can listen to it on disk
    // and confirm the synth pipeline produces something audible.
    if (process.env.SCENARIO_DEBUG === '1' || i === 0) {
      const dumpPath = join(outDir, `learner-turn-${i + 1}.wav`);
      writeFileSync(dumpPath, chunksToWav([{ samples, sampleRate: SAMPLE_RATE, channels: 1 }]));
    }
    log({
      ts: Date.now(),
      type: 'note',
      data: { msg: 'synthesized', turnIdx: i, samples: samples.length, peak },
    });
    console.log(`  audio: ${samples.length} samples, peak amplitude=${peak}`);

    // Wait for Sofía to finish speaking the last response before we open our mic.
    await waitForListening();
    if (turn.pauseBeforeSec) {
      await new Promise((r) => setTimeout(r, turn.pauseBeforeSec! * 1000));
    }

    // ptt_start
    try {
      await room.localParticipant!.performRpc({
        destinationIdentity: agentIdentity,
        method: 'ptt_start',
        payload: '',
      });
    } catch (err) {
      console.warn('  ptt_start failed:', err);
      log({ ts: Date.now(), type: 'note', data: { msg: 'ptt_start failed', err: String(err) } });
      continue;
    }

    // Tiny grace period — agent's session.input.setAudioEnabled(true) and the
    // STT pipeline subscribing to the track aren't instantaneous. Without this,
    // the first ~50ms of every learner turn is lost.
    await new Promise((r) => setTimeout(r, 150));

    await streamFrames(source, samples, SAMPLE_RATE);

    // ptt_end
    try {
      await room.localParticipant!.performRpc({
        destinationIdentity: agentIdentity,
        method: 'ptt_end',
        payload: '',
      });
    } catch (err) {
      console.warn('  ptt_end failed:', err);
    }

    // Wait for the tutor to complete its response. The Node SDK can't easily
    // subscribe to TranscriptionReceived, so we poll debug_snapshot and watch
    // for the transcript array to grow by at least one tutor entry beyond
    // whatever was there before we PTT'd.
    const beforeSnapshotResp = await safeRpc(room, agentIdentity, 'debug_snapshot', 5_000);
    const beforeTutorCount = beforeSnapshotResp
      ? (JSON.parse(beforeSnapshotResp).transcript as Array<{ role: string }>).filter(
          (t) => t.role === 'tutor',
        ).length
      : 0;

    let snapshot: any = null;
    const turnDeadline = Date.now() + 35_000;
    let lastTutorTurn: string | null = null;
    while (Date.now() < turnDeadline) {
      const resp = await safeRpc(room, agentIdentity, 'debug_snapshot', 10_000);
      if (resp) {
        snapshot = JSON.parse(resp);
        const tutorTurns = (snapshot.transcript as Array<{ role: string; text: string }>).filter(
          (t) => t.role === 'tutor',
        );
        if (tutorTurns.length > beforeTutorCount) {
          lastTutorTurn = tutorTurns[tutorTurns.length - 1].text;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 600));
    }

    if (lastTutorTurn) {
      log({
        ts: Date.now(),
        type: 'tutor-turn-final',
        data: { turnIdx: i, text: lastTutorTurn },
      });
      console.log(`  Sofía: "${lastTutorTurn.slice(0, 140)}${lastTutorTurn.length > 140 ? '…' : ''}"`);
    } else {
      console.warn('  ⚠  No tutor response within 35s — recording empty');
      log({ ts: Date.now(), type: 'note', data: { msg: 'tutor-response-timeout', turnIdx: i } });
    }

    if (snapshot) {
      const ratioPct = Math.round(snapshot.controllerState.current_ratio_target * 100);
      log({
        ts: Date.now(),
        type: 'debug-snapshot',
        data: {
          turnIdx: i,
          controllerState: snapshot.controllerState,
          turnCount: snapshot.turnCount,
          pronunciationLatest: snapshot.pronunciation?.recent?.slice(-1)[0] ?? null,
          systemPromptHash: hashShort(snapshot.systemPrompt),
        },
      });
      console.log(`  controller: ${ratioPct}% EN, edge=${snapshot.controllerState.edge_state}`);
    }

    if (Date.now() - startedAt > scenario.budgetSec * 1000) {
      console.warn('  budget exceeded — bailing');
      log({ ts: Date.now(), type: 'note', data: { msg: 'budget-exceeded' } });
      break;
    }
  }

  if (scenario.endWithCompaction) {
    console.log('\n── Ending session + running compaction ──');
    try {
      const resp = await room.localParticipant!.performRpc({
        destinationIdentity: agentIdentity,
        method: 'end_session',
        payload: '',
        responseTimeout: 90_000,
      });
      const compaction = JSON.parse(resp);
      log({ ts: Date.now(), type: 'compaction', data: compaction });
      console.log(`  compaction ok=${compaction.ok} duration=${compaction.durationMs}ms`);
    } catch (err) {
      console.warn('  end_session failed:', err);
    }
  }

  await room.disconnect();
  console.log(`\nScenario complete. Artifacts: ${outDir}`);
  return outDir;
}

// ── Scenario library ─────────────────────────────────────────────────

export const SCENARIO_1: Scenario = {
  name: 'first-session-warm-up',
  description:
    'Brand-new A1 learner. Mostly English, one broken Spanish attempt at turn 3. ' +
    'Expected: Sofía stays mostly English (~80%), models the broken phrase back, never quizzes.',
  budgetSec: 240,
  endWithCompaction: false, // start cheap; flip on once stable
  turns: [
    {
      language: 'en',
      text: 'Hi Sofia, I am just getting started with Spanish so go easy on me please',
      pauseBeforeSec: 3, // wait for the greeting before the first learner line
    },
    {
      language: 'en',
      text: 'My main goal is to be able to talk to people when I travel to Mexico next year',
    },
    {
      language: 'es',
      text: 'me gusta cocinar tacos pero no soy muy bueno',
    },
    {
      language: 'en',
      text: 'I love cooking and food in general, I cook almost every night',
    },
    {
      language: 'en',
      text: 'I would love to learn how to order food at a restaurant in Spanish',
    },
  ],
};

// ── CLI entry ────────────────────────────────────────────────────────

async function main() {
  const scenarioName = process.argv[2] ?? 'first-session-warm-up';
  const scenarios: Record<string, Scenario> = {
    'first-session-warm-up': SCENARIO_1,
  };
  const scenario = scenarios[scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario "${scenarioName}". Known: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }
  try {
    const outDir = await runScenario(scenario);
    console.log(`\n✓ Done — ${outDir}`);
  } catch (err) {
    console.error('Scenario failed:', err);
    process.exit(1);
  }
}

// Only run main if invoked directly (not when imported by other tests)
if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}

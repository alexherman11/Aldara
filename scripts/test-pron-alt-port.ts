/**
 * One-off harness wrapper used to test the pronunciation pipeline against an
 * isolated LiveKit instance on a non-default port (7890 instead of 7880), so
 * the test doesn't interfere with concurrent dev stacks running on 7880.
 *
 * Why a wrapper: scenario-harness.ts calls dotenv.config({override:true}),
 * which stomps any LIVEKIT_URL we pass via the shell. We force the override
 * AFTER dotenv loads. Also: agent dispatch wants an http(s) URL; the harness's
 * regex turns ws:// into https://, which fails against the unencrypted local
 * server — so we monkey-patch process.env.LIVEKIT_URL to the http form during
 * the dispatch step.
 */
import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

// Override AFTER dotenv has loaded so the harness sees our alt-port URL.
process.env.LIVEKIT_URL = 'ws://127.0.0.1:7890';

import { AgentDispatchClient, AccessToken } from 'livekit-server-sdk';
import {
  Room,
  RoomEvent,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  AudioFrame,
  TrackSource,
} from '@livekit/rtc-node';

const SAMPLE_RATE = 48_000;

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
      voice: { mode: 'id', id: process.env.CARTESIA_VOICE_ID || '5c5ad5e7-1020-476b-8b91-fdcbe9cc313c' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
      language,
    }),
  });
  if (!resp.ok) throw new Error(`Cartesia ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return Buffer.from(await resp.arrayBuffer());
}

function bufferToInt16(buf: Buffer): Int16Array {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

async function streamFrames(source: AudioSource, samples: Int16Array, sampleRate: number) {
  const FRAME_MS = 10;
  const samplesPerFrame = Math.floor((sampleRate * FRAME_MS) / 1000);
  const start = Date.now();
  let cursor = 0, frameIdx = 0;
  while (cursor < samples.length) {
    const slice = samples.subarray(cursor, cursor + samplesPerFrame);
    const frame = new AudioFrame(slice, sampleRate, 1, slice.length);
    await source.captureFrame(frame);
    cursor += slice.length;
    frameIdx++;
    const targetElapsed = frameIdx * FRAME_MS;
    const realElapsed = Date.now() - start;
    if (targetElapsed > realElapsed) {
      await new Promise(r => setTimeout(r, targetElapsed - realElapsed));
    }
  }
  // trailing silence
  const tail = new Int16Array(samplesPerFrame * 10);
  await source.captureFrame(new AudioFrame(tail, sampleRate, 1, tail.length));
}

async function buildLearnerToken(roomName: string): Promise<string> {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
    identity: 'learner', name: 'learner', ttl: '15m',
  });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

async function safeRpc(room: Room, dest: string, method: string, timeout = 8000): Promise<string | null> {
  try {
    return await room.localParticipant!.performRpc({ destinationIdentity: dest, method, payload: '', responseTimeout: timeout });
  } catch (err) {
    console.warn(`  rpc(${method}) failed:`, err);
    return null;
  }
}

const TURNS: Array<{ text: string; language: 'es' }> = [
  // Clear, simple Spanish so we can interpret per-word scores easily.
  { text: 'hola me llamo alex', language: 'es' },
  // Has the trilled /r/ — Cartesia will pronounce it well; useful to confirm
  // we get high scores AND per-word coverage when nothing is "wrong".
  { text: 'tengo un perro grande y rojo', language: 'es' },
  // Multi-word with stress patterns.
  { text: 'me gusta mucho comer tacos en el restaurante', language: 'es' },
];

async function main() {
  console.log(`LIVEKIT_URL=${process.env.LIVEKIT_URL}`);
  console.log(`PRONUNCIATION_PROVIDER=${process.env.PRONUNCIATION_PROVIDER}`);
  console.log(`AZURE_SPEECH_REGION=${process.env.AZURE_SPEECH_REGION}`);

  const roomName = `pron-test-${Date.now()}`;
  const token = await buildLearnerToken(roomName);

  // Dispatch agent — for the alt LiveKit, manually build http URL.
  const httpUrl = `http://127.0.0.1:7890`;
  console.log(`Dispatching 'sofia' to ${roomName} via ${httpUrl}…`);
  const dispatchClient = new AgentDispatchClient(httpUrl, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
  try {
    const d = await dispatchClient.createDispatch(roomName, 'sofia');
    console.log(`  dispatched id=${d.id}`);
  } catch (err) {
    console.error('  dispatch failed:', err);
    process.exit(1);
  }

  const room = new Room();
  let agentIdentity: string | null = null;
  let agentState = 'unknown';
  const pronEvents: any[] = [];

  room.on('dataReceived', (payload, _p, _k, topic) => {
    if (topic !== 'pronunciation') return;
    try {
      const data = JSON.parse(new TextDecoder().decode(payload as Uint8Array));
      pronEvents.push(data);
      const flagged = (data.words ?? []).filter((w: any) => w.score < 70 || w.error_type !== 'None');
      console.log(`\n  📣 PRONUNCIATION (turn ${data.turn}):`);
      console.log(`     reference="${data.reference_text}"`);
      console.log(`     recognized="${data.recognized_text ?? ''}"`);
      console.log(`     overall: pron=${Math.round(data.overall?.pronunciation ?? 0)} acc=${Math.round(data.overall?.accuracy ?? 0)} flu=${Math.round(data.overall?.fluency ?? 0)} comp=${Math.round(data.overall?.completeness ?? 0)}`);
      console.log(`     words (${data.words?.length ?? 0}): ${(data.words ?? []).map((w: any) => `${w.word}=${w.score}${w.error_type!=='None'?'/'+w.error_type:''}${w.is_stretch?'*':''}`).join(', ')}`);
      if (flagged.length) console.log(`     FLAGGED: ${flagged.map((w:any)=>w.word).join(', ')}`);
      console.log(`     divergence=${data.divergence}`);
    } catch (err) { console.warn('  parse failed:', err); }
  });

  room.on(RoomEvent.ParticipantConnected, (p) => {
    if (p.attributes?.['lk.agent.state']) {
      agentIdentity = p.identity;
      agentState = p.attributes['lk.agent.state'];
    }
  });
  room.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
    if (changed['lk.agent.state']) {
      agentIdentity = p.identity;
      agentState = changed['lk.agent.state'];
    }
  });

  console.log(`Connecting to ${process.env.LIVEKIT_URL!}…`);
  await room.connect(process.env.LIVEKIT_URL!, token);
  console.log('Connected. Waiting for Sofía…');
  const deadline = Date.now() + 30_000;
  while (!agentIdentity && Date.now() < deadline) {
    for (const [, p] of room.remoteParticipants) {
      if (p.attributes?.['lk.agent.state']) { agentIdentity = p.identity; break; }
    }
    if (agentIdentity) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!agentIdentity) throw new Error('Sofía never joined within 30s');
  console.log(`  Sofía joined as ${agentIdentity}`);

  const source = new AudioSource(SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack('learner-mic', source);
  const publishOpts = new TrackPublishOptions();
  publishOpts.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(track, publishOpts);

  const waitForListening = async (timeoutMs = 30000) => {
    const d = Date.now() + timeoutMs;
    while (Date.now() < d) {
      if (agentState === 'listening' || agentState === 'idle') return;
      await new Promise(r => setTimeout(r, 250));
    }
    console.warn(`  agent not in listening state (last=${agentState})`);
  };

  // Initial pause to let the greeting finish.
  console.log('\nWaiting 6s for greeting…');
  await new Promise(r => setTimeout(r, 6000));

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    console.log(`\n── Turn ${i+1}/${TURNS.length}: "${turn.text}"`);
    const pcm = await cartesiaSynth(turn.text, turn.language);
    const samples = bufferToInt16(pcm);
    console.log(`  synthesized ${samples.length} samples (~${(samples.length/SAMPLE_RATE).toFixed(2)}s)`);

    await waitForListening();
    await safeRpc(room, agentIdentity, 'ptt_start');
    await new Promise(r => setTimeout(r, 150));
    await streamFrames(source, samples, SAMPLE_RATE);
    await safeRpc(room, agentIdentity, 'ptt_end');

    // Wait up to 20s for tutor response (proxy for pron payload being published shortly after).
    const before = await safeRpc(room, agentIdentity, 'debug_snapshot', 5000);
    const beforeTutor = before ? JSON.parse(before).transcript.filter((t:any)=>t.role==='tutor').length : 0;
    const turnDeadline = Date.now() + 30000;
    while (Date.now() < turnDeadline) {
      const snap = await safeRpc(room, agentIdentity, 'debug_snapshot', 8000);
      if (snap) {
        const t = JSON.parse(snap).transcript.filter((x:any)=>x.role==='tutor');
        if (t.length > beforeTutor) {
          console.log(`  Sofía: "${t[t.length-1].text.slice(0,120)}…"`);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 600));
    }
    // Extra grace so pronunciation publish lands.
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`SUMMARY: ${pronEvents.length} pronunciation events received`);
  console.log(`═══════════════════════════════════════════════`);
  for (const e of pronEvents) {
    console.log(`  turn ${e.turn}: ref="${e.reference_text}" pron=${Math.round(e.overall?.pronunciation ?? 0)} words=${e.words?.length ?? 0}`);
  }

  await room.disconnect();
  process.exit(pronEvents.length > 0 ? 0 : 2);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

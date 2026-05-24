/**
 * Smoke test for the Chirp 3 HD (Google Cloud TTS) provider.
 *
 * Construct-only (default): instantiates ChirpTTS with a placeholder key so
 * we verify the class shape, options surface, and module wiring without
 * spending an API quota or requiring credentials.
 *
 * With --synthesize: makes a real REST call to texttospeech.googleapis.com
 * using $GOOGLE_API_KEY, writes the resulting LINEAR16 PCM into chirp-out.wav
 * (with a proper 44-byte WAV header so you can actually play it back), and
 * prints "OK" plus byte/duration stats.
 *
 *   tsx scripts/test-chirp-tts.ts                # construct only
 *   tsx scripts/test-chirp-tts.ts --synthesize   # real synthesize, writes WAV
 *
 * Optional flags:
 *   --voice=<id>   override the default es-US-Chirp3-HD-Aoede voice
 *   --text="..."   override the default Spanish sample sentence
 *   --out=<path>   write to a different file (default: chirp-out.wav)
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { initializeLogger } from '@livekit/agents';
import { ChirpTTS, synthesizeChirpPcm } from '../src/chirp-tts.js';

// LiveKit's TTS base class touches the global logger in its constructor.
// Outside an agent worker process nothing initializes it for us, so the
// ChunkedStream verification below would crash. Init at warn level so we
// don't drown the smoke-test output.
initializeLogger({ pretty: true, level: 'warn' });

const DEFAULT_VOICE = 'es-US-Chirp3-HD-Aoede';
const DEFAULT_TEXT =
  'Hola, soy Sofía. Vamos a practicar español juntos, ¿te parece?';
const DEFAULT_OUT = 'chirp-out.wav';
const SAMPLE_RATE = 24_000;

/**
 * Wrap a LINEAR16 PCM buffer in a minimal WAV header so it can be played by
 * any standard audio app. Mono, 16-bit, sample rate as configured.
 */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

async function main(): Promise<void> {
  const shouldSynthesize = process.argv.includes('--synthesize');
  const voice = parseFlag('voice') || DEFAULT_VOICE;
  const text = parseFlag('text') || DEFAULT_TEXT;
  const outPath = parseFlag('out') || DEFAULT_OUT;

  const realKey = process.env.GOOGLE_API_KEY;
  // Construct-only path: use a placeholder so the class wiring still gets
  // exercised in environments without a key (CI, fresh clones, etc.).
  const apiKey = realKey || (shouldSynthesize ? '' : 'placeholder-for-smoke-test');

  if (shouldSynthesize && !realKey) {
    console.error(
      '--synthesize requires GOOGLE_API_KEY in the environment (set it in .env ' +
        'or export it). The same key used for Gemini works for Cloud TTS as ' +
        'long as the Text-to-Speech API is enabled on the project.',
    );
    process.exitCode = 1;
    return;
  }

  const tts = new ChirpTTS({
    voiceName: voice,
    languageCode: 'es-US',
    apiKey,
  });
  console.log(`ChirpTTS constructed OK`);
  console.log(`  label=${tts.label}`);
  console.log(`  provider=${tts.provider}`);
  console.log(`  model(voice)=${tts.model}`);
  console.log(`  sampleRate=${tts.sampleRate} numChannels=${tts.numChannels}`);
  console.log(`  capabilities.streaming=${tts.capabilities.streaming}`);
  console.log(
    `  api_key_source=${realKey ? 'env (GOOGLE_API_KEY)' : 'placeholder (smoke test)'}`,
  );

  if (!shouldSynthesize) {
    console.log(
      'Skipping synthesize() — pass --synthesize to call the API end-to-end.',
    );
    return;
  }

  console.log('');
  console.log(`Synthesizing (${text.length} chars): "${text}"`);
  const startedAt = Date.now();
  const pcm = await synthesizeChirpPcm(
    { voiceName: voice, languageCode: 'es-US', apiKey },
    text,
  );
  const restMs = Date.now() - startedAt;

  const wav = pcmToWav(pcm, SAMPLE_RATE);
  writeFileSync(outPath, wav);

  const durationSec = pcm.length / 2 / SAMPLE_RATE; // 2 bytes per sample, mono
  console.log('OK');
  console.log(`  rest_call_ms=${restMs}`);
  console.log(`  pcm_bytes=${pcm.length}`);
  console.log(`  wav_bytes=${wav.length}`);
  console.log(`  duration_sec=${durationSec.toFixed(2)}`);
  console.log(`  wrote=${outPath}`);

  // Also exercise the LiveKit-shaped ChunkedStream path so we know the
  // adapter actually frames the PCM correctly — this is the path the agent
  // hits at runtime. Count frames; expect > 0.
  console.log('');
  console.log('Verifying ChunkedStream frame emission…');
  const stream = tts.synthesize(text);
  let frameCount = 0;
  let totalSamples = 0;
  let sawFinal = false;
  for await (const ev of stream) {
    frameCount++;
    totalSamples += ev.frame.samplesPerChannel;
    if (ev.final) sawFinal = true;
  }
  console.log(
    `  frames=${frameCount} samples=${totalSamples} ` +
      `(~${(totalSamples / SAMPLE_RATE).toFixed(2)}s) saw_final=${sawFinal}`,
  );
  if (frameCount === 0) {
    throw new Error('ChunkedStream produced zero frames — adapter is broken');
  }
  if (!sawFinal) {
    throw new Error('ChunkedStream never emitted a frame with final=true');
  }
  console.log('ChunkedStream OK');
}

main().catch((err) => {
  console.error('test-chirp-tts failed:', err);
  process.exitCode = 1;
});

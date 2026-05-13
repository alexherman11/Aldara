/**
 * Round-trip tests for chunksToWav + chunkDurationSeconds.
 *
 * These two functions sit at the head of the pronunciation pipeline — every
 * turn's audio passes through chunksToWav before being sliced and scored. The
 * fix for the segmented-scorer sample-rate bug (reading rate from the header
 * instead of defaulting to 16 kHz) relies on chunksToWav writing the right
 * rate. This file pins that contract.
 *
 * Pure, no network.
 */

import { chunksToWav, chunkDurationSeconds, type PcmChunk } from '../src/pronunciation/wav.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info?: string) {
  if (ok) {
    console.log(`  PASS  ${label}${info ? ` — ${info}` : ''}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${info ? ` — ${info}` : ''}`);
    failed++;
  }
}

function silentChunk(sampleRate: number, durationSec: number, channels = 1): PcmChunk {
  const sampleCount = Math.floor(sampleRate * durationSec * channels);
  return { samples: new Int16Array(sampleCount), sampleRate, channels };
}

function readHeader(buf: Buffer) {
  return {
    riff: buf.toString('ascii', 0, 4),
    fileLen: buf.readUInt32LE(4),
    wave: buf.toString('ascii', 8, 12),
    fmtTag: buf.toString('ascii', 12, 16),
    fmtSize: buf.readUInt32LE(16),
    audioFormat: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    dataTag: buf.toString('ascii', 36, 40),
    dataLen: buf.readUInt32LE(40),
  };
}

console.log('── WAV round-trip ──\n');

// ── 1. Empty input → zero-length buffer ─────────────────────────────
console.log('1. Empty chunks');
{
  const wav = chunksToWav([]);
  check('empty input returns zero-length buffer', wav.length === 0);
  check('chunkDurationSeconds on empty = 0', chunkDurationSeconds([]) === 0);
}

// ── 2. Single 16 kHz mono chunk ─────────────────────────────────────
console.log('\n2. Single 16 kHz mono chunk, 1.0 second');
{
  const wav = chunksToWav([silentChunk(16000, 1.0)]);
  const h = readHeader(wav);
  check('RIFF header', h.riff === 'RIFF');
  check('WAVE marker', h.wave === 'WAVE');
  check('fmt chunk size = 16 (PCM)', h.fmtSize === 16);
  check('audio format = 1 (PCM)', h.audioFormat === 1);
  check('1 channel', h.channels === 1);
  check('16 kHz sample rate', h.sampleRate === 16000);
  check('16 bits per sample', h.bitsPerSample === 16);
  check(
    'data length = 32000 bytes (1.0s × 16 kHz × 2 bytes)',
    h.dataLen === 32_000,
  );
  check('total buffer length = 44 + dataLen', wav.length === 44 + h.dataLen);
}

// ── 3. 48 kHz mono — the rate LiveKit emits by default ──────────────
console.log('\n3. 48 kHz mono, 1.0 second');
{
  const wav = chunksToWav([silentChunk(48000, 1.0)]);
  const h = readHeader(wav);
  check('48 kHz sample rate', h.sampleRate === 48_000);
  check(
    'data length = 96000 bytes (1.0s × 48 kHz × 2 bytes)',
    h.dataLen === 96_000,
  );
  check('byteRate = 96000', h.byteRate === 96_000);
  check('blockAlign = 2', h.blockAlign === 2);
}

// ── 4. Multi-chunk concatenation preserves total duration ──────────
console.log('\n4. Multi-chunk concatenation (3× 0.5s @ 16 kHz)');
{
  const chunks = [
    silentChunk(16000, 0.5),
    silentChunk(16000, 0.5),
    silentChunk(16000, 0.5),
  ];
  const wav = chunksToWav(chunks);
  const h = readHeader(wav);
  check('combined data length = 48 000 bytes', h.dataLen === 48_000);
  check(
    'chunkDurationSeconds reports 1.5s',
    Math.abs(chunkDurationSeconds(chunks) - 1.5) < 1e-6,
    `got ${chunkDurationSeconds(chunks)}`,
  );
}

// ── 5. Heterogeneous chunks should throw ───────────────────────────
console.log('\n5. Heterogeneous sample rates throw');
{
  let threw = false;
  try {
    chunksToWav([silentChunk(16000, 0.5), silentChunk(48000, 0.5)]);
  } catch {
    threw = true;
  }
  check('mixing 16 kHz with 48 kHz throws', threw);
}

// ── 6. Sub-second durations round consistently ─────────────────────
console.log('\n6. Sub-second durations (0.3s @ 16 kHz)');
{
  const wav = chunksToWav([silentChunk(16000, 0.3)]);
  const h = readHeader(wav);
  // 0.3 × 16 000 = 4 800 samples × 2 bytes = 9 600 bytes
  check('data length = 9600 bytes', h.dataLen === 9_600);
}

// ── 7. Header RIFF size matches data + 36 ──────────────────────────
console.log('\n7. RIFF fileLen field equals 36 + dataLen');
{
  const wav = chunksToWav([silentChunk(16000, 0.5)]);
  const h = readHeader(wav);
  check('fileLen = 36 + dataLen', h.fileLen === 36 + h.dataLen);
}

// ── 8. Non-trivial PCM payload preserves first/last sample exactly ─
console.log('\n8. Non-zero samples preserved byte-for-byte');
{
  const samples = new Int16Array(1000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = ((i * 137) % 32768) - 16384; // deterministic-but-varied
  }
  const wav = chunksToWav([{ samples, sampleRate: 16000, channels: 1 }]);
  // First sample at byte offset 44, little-endian Int16
  const first = wav.readInt16LE(44);
  const last = wav.readInt16LE(44 + (samples.length - 1) * 2);
  check('first sample preserved', first === samples[0]);
  check('last sample preserved', last === samples[samples.length - 1]);
}

console.log('\n════════════════════════════════════════════════');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);

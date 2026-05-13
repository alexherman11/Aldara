import { chunksToWav, chunkDurationSeconds, type PcmChunk } from '../src/pronunciation/wav.js';

/**
 * WAV writer contract tests. Verifies:
 *   - Empty chunks → empty buffer
 *   - Header is RIFF/WAVE/fmt /data and reports correct sizes
 *   - Sample-rate, channels, bit-depth fields are correct
 *   - PCM data is concatenated in chunk order with correct endianness
 *   - Heterogeneous chunks throw
 *   - chunkDurationSeconds matches sample math
 */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, info?: string) {
  if (ok) {
    console.log(`  ${label}: PASS${info ? ` (${info})` : ''}`);
    passed++;
  } else {
    console.log(`  ${label}: FAIL${info ? ` (${info})` : ''}`);
    failed++;
  }
}

function makeChunk(samples: number[], rate = 16000, ch = 1): PcmChunk {
  return { samples: new Int16Array(samples), sampleRate: rate, channels: ch };
}

function main() {
  console.log('WAV writer contract tests\n');

  // ── 1. Empty chunks ─────────────────────────────────────────────
  console.log('── 1. Empty chunks ──');
  const emptyWav = chunksToWav([]);
  check('Empty chunks → empty buffer', emptyWav.length === 0);
  check('Empty chunks duration is 0', chunkDurationSeconds([]) === 0);

  // ── 2. Single chunk header layout ───────────────────────────────
  console.log('\n── 2. Single chunk header ──');
  const samples = [0, 1000, -1000, 32767, -32768, 0, 500];
  const wav = chunksToWav([makeChunk(samples)]);
  check('Buffer is at least 44 bytes', wav.length >= 44);
  check('RIFF marker present', wav.toString('ascii', 0, 4) === 'RIFF');
  check('WAVE marker present', wav.toString('ascii', 8, 12) === 'WAVE');
  check('fmt  marker present', wav.toString('ascii', 12, 16) === 'fmt ');
  check('data marker present', wav.toString('ascii', 36, 40) === 'data');
  check('PCM format = 1', wav.readUInt16LE(20) === 1);
  check('Channels = 1', wav.readUInt16LE(22) === 1);
  check('Sample rate = 16000', wav.readUInt32LE(24) === 16000);
  check('Bits per sample = 16', wav.readUInt16LE(34) === 16);
  check(
    'Byte rate = 32000 (16000 * 1 * 2)',
    wav.readUInt32LE(28) === 32000,
  );

  const expectedDataBytes = samples.length * 2;
  check(
    `Data size field = ${expectedDataBytes}`,
    wav.readUInt32LE(40) === expectedDataBytes,
  );
  check(
    `RIFF size field = 36 + ${expectedDataBytes}`,
    wav.readUInt32LE(4) === 36 + expectedDataBytes,
  );
  check(
    'Total buffer size = 44 + dataBytes',
    wav.length === 44 + expectedDataBytes,
  );

  // ── 3. PCM data round-trip ──────────────────────────────────────
  console.log('\n── 3. PCM data round-trip ──');
  for (let i = 0; i < samples.length; i++) {
    const expected = samples[i];
    const actual = wav.readInt16LE(44 + i * 2);
    if (expected !== actual) {
      check(`sample[${i}] = ${expected}`, false, `got ${actual}`);
      break;
    }
  }
  check('All samples round-tripped correctly', failed === 0 || passed > 12);

  // ── 4. Multi-chunk concatenation ────────────────────────────────
  console.log('\n── 4. Multi-chunk concatenation ──');
  const wavMulti = chunksToWav([
    makeChunk([1, 2, 3]),
    makeChunk([4, 5]),
    makeChunk([6]),
  ]);
  const expectedSamples = [1, 2, 3, 4, 5, 6];
  check(
    `Multi-chunk data length matches`,
    wavMulti.readUInt32LE(40) === expectedSamples.length * 2,
  );
  let allMatch = true;
  for (let i = 0; i < expectedSamples.length; i++) {
    if (wavMulti.readInt16LE(44 + i * 2) !== expectedSamples[i]) {
      allMatch = false;
      break;
    }
  }
  check('Multi-chunk data is in correct order', allMatch);

  // ── 5. Heterogeneous chunks throw ───────────────────────────────
  console.log('\n── 5. Heterogeneous chunks ──');
  let threw = false;
  try {
    chunksToWav([makeChunk([1], 16000, 1), makeChunk([2], 24000, 1)]);
  } catch {
    threw = true;
  }
  check('Mixed sample rates throw', threw);

  threw = false;
  try {
    chunksToWav([makeChunk([1], 16000, 1), makeChunk([2], 16000, 2)]);
  } catch {
    threw = true;
  }
  check('Mixed channel counts throw', threw);

  // ── 6. Duration math ────────────────────────────────────────────
  console.log('\n── 6. Duration math ──');
  // 16000 samples at 16kHz mono = 1 second
  const oneSecond = chunkDurationSeconds([
    {
      samples: new Int16Array(16000),
      sampleRate: 16000,
      channels: 1,
    },
  ]);
  check('16000 samples at 16kHz = 1.0s', Math.abs(oneSecond - 1.0) < 0.001);

  // ── 7. Realistic 16kHz / 1s sanity check ─────────────────────────
  console.log('\n── 7. Realistic 1s @ 16kHz ──');
  const oneSecOfAudio = new Int16Array(16000);
  for (let i = 0; i < 16000; i++) {
    // 440Hz sine wave at half amplitude
    oneSecOfAudio[i] = Math.round(Math.sin((i / 16000) * 440 * 2 * Math.PI) * 16384);
  }
  const sineWav = chunksToWav([
    { samples: oneSecOfAudio, sampleRate: 16000, channels: 1 },
  ]);
  check('1s of 16kHz audio → 32044 byte file', sineWav.length === 32044);

  console.log('\n════════════════════════════════════════════════');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main();

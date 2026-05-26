/**
 * Minimal WAV header writer for assembling a captured turn's PCM frames into
 * a single buffer that pronunciation engines (SpeechAce, Azure) can accept.
 *
 * Assumptions: 16-bit signed little-endian PCM, mono. SpeechAce and Azure
 * both accept 16kHz mono WAV.
 */

export interface PcmChunk {
  /** Int16 PCM samples, little-endian. */
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

/**
 * Concatenate PCM chunks (must share sampleRate and channels) and prepend a
 * RIFF/WAVE header. Returns a single Buffer ready to upload to a pronunciation
 * provider.
 */
export function chunksToWav(chunks: PcmChunk[]): Buffer {
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }

  const sampleRate = chunks[0].sampleRate;
  const channels = chunks[0].channels;
  const bitsPerSample = 16;

  // Validate uniformity — provider APIs reject mixed-rate audio
  for (const c of chunks) {
    if (c.sampleRate !== sampleRate || c.channels !== channels) {
      throw new Error(
        `chunksToWav: heterogeneous chunks (sampleRate ${c.sampleRate} vs ${sampleRate}, ` +
          `channels ${c.channels} vs ${channels})`,
      );
    }
  }

  const totalSamples = chunks.reduce((n, c) => n + c.samples.length, 0);
  const dataBytes = totalSamples * (bitsPerSample / 8);
  const headerBytes = 44;
  const buf = Buffer.alloc(headerBytes + dataBytes);

  // RIFF chunk
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4); // file size - 8
  buf.write('WAVE', 8, 'ascii');

  // fmt sub-chunk
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28); // byte rate
  buf.writeUInt16LE((channels * bitsPerSample) / 8, 32); // block align
  buf.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  // PCM data
  let offset = headerBytes;
  for (const c of chunks) {
    for (let i = 0; i < c.samples.length; i++) {
      buf.writeInt16LE(c.samples[i], offset);
      offset += 2;
    }
  }

  return buf;
}

/** Total duration in seconds of the captured PCM, useful for logging/debug. */
export function chunkDurationSeconds(chunks: PcmChunk[]): number {
  if (chunks.length === 0) return 0;
  const total = chunks.reduce((n, c) => n + c.samples.length, 0);
  return total / chunks[0].sampleRate / chunks[0].channels;
}

/**
 * Parse a 16-bit PCM WAV file into a single PcmChunk. Used by the dev
 * injection RPC to replay a captured recording through the same code paths
 * the live PTT flow uses. Only supports the format `chunksToWav` emits
 * (mono, 16-bit signed LE PCM, single data sub-chunk after a standard 44-byte
 * RIFF header). Throws if the input doesn't match.
 */
export function wavToChunk(wav: Buffer): PcmChunk {
  if (wav.length < 44) {
    throw new Error(`wavToChunk: buffer too short (${wav.length} bytes)`);
  }
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wavToChunk: missing RIFF/WAVE magic');
  }
  const format = wav.readUInt16LE(20);
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  if (format !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `wavToChunk: unsupported format (format=${format}, bps=${bitsPerSample}); expected 16-bit PCM`,
    );
  }
  if (wav.toString('ascii', 36, 40) !== 'data') {
    throw new Error('wavToChunk: data sub-chunk not at offset 36 (unusual layout)');
  }
  const dataBytes = wav.readUInt32LE(40);
  const sampleCount = dataBytes / 2;
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = wav.readInt16LE(44 + i * 2);
  }
  return { samples, sampleRate, channels };
}

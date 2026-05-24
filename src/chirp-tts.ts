/**
 * Google Cloud TTS (Chirp 3 HD) provider for LiveKit Agents.
 *
 * The official @livekit/agents-plugin-google package (pinned at 1.2.6) only
 * exposes Gemini Flash TTS — it does NOT surface Google Cloud TTS, which is
 * where the Chirp 3 HD voices live. Rather than waiting for the plugin to
 * catch up, we implement a tiny REST-based TTS adapter directly against
 * https://texttospeech.googleapis.com/v1/text:synthesize.
 *
 * Why REST + fetch() (instead of @google-cloud/text-to-speech):
 *   - The same GOOGLE_API_KEY that already powers the existing Gemini
 *     integration works for Cloud TTS — no service account / ADC required.
 *   - The official @google-cloud/text-to-speech SDK is built around gRPC +
 *     Application Default Credentials; the API-key path is awkward and the
 *     SDK pulls in a large dep tree. A single fetch() call is simpler, has
 *     zero new transitive deps, and is already proven to work against the
 *     `?key=$GOOGLE_API_KEY` endpoint.
 *   - LINEAR16 audio comes back directly in the JSON response (base64), so
 *     we skip MP3 decoding entirely and feed raw PCM straight into LiveKit's
 *     AudioByteStream — same framing path the OpenAI plugin uses.
 *
 * Streaming: this is a non-streaming TTS (`capabilities.streaming = false`).
 * Cloud TTS does expose v1beta1 streaming synthesize over bidi-gRPC, but it
 * doesn't support API-key auth — so we'd have to add the SDK and ADC just to
 * shave the ~1s synth latency. Not worth it for placement / tutoring turns
 * that are usually short enough that we're going to wait on the entire
 * utterance before playback anyway. The framework will wrap us with the
 * built-in StreamAdapter when something asks for `.stream()`.
 */

import { AudioByteStream, shortuuid, tts } from '@livekit/agents';
import type { APIConnectOptions } from '@livekit/agents';

/** Audio config returned by the REST endpoint when we ask for LINEAR16. */
const CHIRP_SAMPLE_RATE = 24_000;
const CHIRP_CHANNELS = 1;

const SYNTHESIZE_URL =
  'https://texttospeech.googleapis.com/v1/text:synthesize';

export interface ChirpTTSOptions {
  /**
   * Cloud TTS voice id — must be a Chirp 3 HD voice name, e.g.
   * `es-US-Chirp3-HD-Aoede`. The catalog in src/tts-catalog.ts is the
   * source of truth for which voices we ship.
   */
  voiceName: string;
  /**
   * BCP-47 language code. Defaults to `es-US` — the prefix of every Chirp 3
   * HD Spanish voice we expose. Override if you wire in non-Spanish voices.
   */
  languageCode?: string;
  /**
   * Google AI Studio / Cloud Console API key with the Text-to-Speech API
   * enabled. Required — we throw at construction if absent because falling
   * back silently to a different provider would be more confusing than a
   * loud startup failure.
   */
  apiKey: string;
  /**
   * Speaking rate (0.25–4.0). Cloud TTS default is 1.0; we leave it alone
   * unless the caller asks for something different.
   */
  speakingRate?: number;
  /**
   * Pitch in semitones (-20.0 to 20.0). Cloud TTS default is 0.0.
   * Note: Chirp 3 HD voices ignore most prosody knobs — this is mostly here
   * for parity with the REST API surface.
   */
  pitch?: number;
}

/** Shape of the JSON response from `text:synthesize`. */
interface SynthesizeResponse {
  audioContent?: string;
  error?: { code: number; message: string; status?: string };
}

/**
 * Build the request body for a single text:synthesize call. Extracted so the
 * smoke-test script (scripts/test-chirp-tts.ts) and the ChunkedStream below
 * can stay in sync without duplicating field names.
 */
export function buildSynthesizeBody(
  opts: ChirpTTSOptions,
  text: string,
): Record<string, unknown> {
  return {
    input: { text },
    voice: {
      languageCode: opts.languageCode ?? 'es-US',
      name: opts.voiceName,
    },
    audioConfig: {
      // LINEAR16 = raw 16-bit signed PCM, little-endian. We deliberately
      // skip MP3 here so we don't have to decode anything before handing
      // bytes to LiveKit's AudioByteStream.
      audioEncoding: 'LINEAR16',
      sampleRateHertz: CHIRP_SAMPLE_RATE,
      speakingRate: opts.speakingRate ?? 1.0,
      pitch: opts.pitch ?? 0.0,
    },
  };
}

/**
 * Perform a single non-streaming Cloud TTS synthesis. Returns the raw PCM
 * (LINEAR16 mono, 24 kHz) as a Buffer.
 *
 * Exported so the smoke-test script can call it without instantiating the
 * full LiveKit TTS class. Throws on any non-2xx response and on responses
 * that mysteriously omit `audioContent`.
 */
export async function synthesizeChirpPcm(
  opts: ChirpTTSOptions,
  text: string,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  const url = `${SYNTHESIZE_URL}?key=${encodeURIComponent(opts.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildSynthesizeBody(opts, text)),
    signal: abortSignal,
  });
  if (!res.ok) {
    // Surface as much of the upstream error as we can — Cloud TTS returns
    // human-readable JSON for 4xx/5xx and we want that in the logs.
    let detail = '';
    try {
      const body = (await res.json()) as SynthesizeResponse;
      detail = body.error?.message ?? JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(
      `Chirp TTS synthesize failed: ${res.status} ${res.statusText} — ${detail}`,
    );
  }
  const json = (await res.json()) as SynthesizeResponse;
  if (!json.audioContent) {
    throw new Error(
      `Chirp TTS returned no audioContent (response keys: ${Object.keys(json).join(', ')})`,
    );
  }
  return Buffer.from(json.audioContent, 'base64');
}

/**
 * LiveKit Agents TTS adapter for Google Cloud Chirp 3 HD voices.
 *
 * Mirrors the structure of @livekit/agents-plugin-openai's TTS class — a
 * thin synthesize() that returns a ChunkedStream which awaits the REST call
 * and then frames the PCM via AudioByteStream. We declare
 * `capabilities.streaming = false`; the framework wraps us in StreamAdapter
 * whenever a streaming consumer asks for `.stream()`.
 */
export class ChirpTTS extends tts.TTS {
  readonly label = 'chirp.TTS';
  private opts: ChirpTTSOptions;
  private abortController = new AbortController();

  override get model(): string {
    // No separate "model" knob in Cloud TTS REST — the voice id encodes the
    // model family (Chirp3-HD) and the specific timbre, so we report it as
    // the model for metrics/observability.
    return this.opts.voiceName;
  }

  override get provider(): string {
    return 'google-cloud-tts';
  }

  constructor(opts: ChirpTTSOptions) {
    super(CHIRP_SAMPLE_RATE, CHIRP_CHANNELS, { streaming: false });
    if (!opts.apiKey) {
      throw new Error(
        'ChirpTTS requires an apiKey (GOOGLE_API_KEY). The same AI Studio / ' +
          'Cloud Console key that powers the existing Gemini integration works ' +
          'for Cloud TTS as long as the Text-to-Speech API is enabled on the ' +
          'project.',
      );
    }
    if (!opts.voiceName) {
      throw new Error('ChirpTTS requires a voiceName (e.g. es-US-Chirp3-HD-Aoede)');
    }
    this.opts = opts;
  }

  override synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChirpChunkedStream(this, this.opts, text, connOptions, abortSignal);
  }

  override stream(): tts.SynthesizeStream {
    // Same posture as the OpenAI plugin — the framework's StreamAdapter
    // takes over whenever a streaming consumer asks for this. Throwing here
    // is the documented escape hatch.
    throw new Error(
      'ChirpTTS does not implement streaming. Wrap it in tts.StreamAdapter ' +
        '(with a sentence tokenizer) if you need a streaming surface.',
    );
  }

  override async close(): Promise<void> {
    this.abortController.abort();
  }
}

class ChirpChunkedStream extends tts.ChunkedStream {
  readonly label = 'chirp.ChunkedStream';
  private opts: ChirpTTSOptions;

  constructor(
    parent: ChirpTTS,
    opts: ChirpTTSOptions,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, parent, connOptions, abortSignal);
    this.opts = opts;
  }

  protected override async run(): Promise<void> {
    try {
      const pcm = await synthesizeChirpPcm(
        this.opts,
        this.inputText,
        this.abortSignal,
      );
      const requestId = shortuuid();
      const segmentId = shortuuid();
      const byteStream = new AudioByteStream(CHIRP_SAMPLE_RATE, CHIRP_CHANNELS);
      // AudioByteStream wants a buffer view; the PCM is already
      // little-endian int16, which matches what LiveKit consumes.
      const frames = byteStream.write(
        pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
      );
      const tail = byteStream.flush();

      // Emit every-frame-but-last with `final:false`, then the last one with
      // `final:true`. Same dance the OpenAI plugin does — the consumer keys
      // off `final` to know when this segment is done.
      let pending: (typeof frames)[number] | undefined;
      const flushPending = (final: boolean) => {
        if (pending) {
          this.queue.put({ requestId, segmentId, frame: pending, final });
          pending = undefined;
        }
      };
      for (const f of frames) {
        flushPending(false);
        pending = f;
      }
      for (const f of tail) {
        flushPending(false);
        pending = f;
      }
      flushPending(true);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      this.queue.close();
    }
  }
}

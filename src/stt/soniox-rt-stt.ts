/**
 * Soniox real-time STT provider for LiveKit Agents.
 *
 * There is no official `@livekit/agents-plugin-soniox` package, so — exactly
 * like ChirpTTS does for Google Cloud TTS — we implement a small streaming
 * adapter directly against Soniox's real-time WebSocket API:
 *   wss://stt-rt.soniox.com/transcribe-websocket
 *
 * Why Soniox: it advertises strong multilingual + code-switching transcription
 * (the whole point of this app — learners mix Spanish and English mid-utterance)
 * and emits per-token language tags + timestamps + confidence, which is the
 * same shape AssemblyAI/Deepgram give us.
 *
 * Protocol summary (see https://soniox.com/docs/stt/api-reference/websocket-api):
 *   1. Open the socket, then send ONE JSON config message
 *      ({api_key, model, audio_format:'s16le', sample_rate, num_channels,
 *        language_hints, enable_endpoint_detection, ...}).
 *   2. Stream raw PCM s16le as binary frames.
 *   3. Server streams back `{ tokens: [{text,start_ms,end_ms,confidence,
 *      is_final,language}], ... }`. Non-final tokens are provisional and may
 *      change; final tokens never change. A special `<end>` token (semantic
 *      endpoint detection) or `<fin>` token (manual finalization) marks an
 *      utterance boundary — both arrive as final tokens.
 *   4. Send `{"type":"finalize"}` to force pending tokens final (→ `<fin>`).
 *      Send an empty binary frame to end the stream.
 *
 * Turn handling: this app drives turns manually (push-to-talk — see the
 * `turnHandling: { turnDetection: 'manual' }` AgentSession in agent.ts). LiveKit
 * signals the end of a PTT turn by pushing a FLUSH_SENTINEL into our input; we
 * translate that into Soniox manual finalization and emit FINAL_TRANSCRIPT +
 * END_OF_SPEECH when the resulting boundary marker comes back. Soniox's own
 * endpoint detection (`<end>`) is left enabled as a backstop so a final still
 * fires if the learner pauses without releasing the button.
 */

import {
  AudioByteStream,
  Task,
  createTimedString,
  delay,
  log,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { APIConnectOptions } from '@livekit/agents';
import type { TimedString } from '@livekit/agents';
import { WebSocket } from 'ws';

type LanguageCode = ReturnType<typeof normalizeLanguage>;

const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

/** Tokens Soniox injects to mark a finalized utterance boundary. */
const BOUNDARY_TOKENS = new Set(['<end>', '<fin>']);

export interface SonioxSTTOptions {
  /** Soniox API key. Falls back to SONIOX_API_KEY. */
  apiKey?: string;
  /**
   * Real-time model id. Defaults to `stt-rt-v4` (Soniox's GA real-time model,
   * Feb 2026). Override via the `model` option or SONIOX_MODEL env var if Soniox
   * renames it.
   */
  model?: string;
  /** Input sample rate. LiveKit frames are resampled to this. Default 16000. */
  sampleRate?: number;
  /** How much audio to batch per outbound binary frame, ms. Default 120. */
  bufferSizeMs?: number;
  /** BCP-47-ish language hints. Default ['es','en'] for our code-switchers. */
  languageHints?: string[];
  /** Semantic endpoint detection. Default true (backstop for PTT). */
  enableEndpointDetection?: boolean;
  /** Per-token language tags. Default true. */
  enableLanguageIdentification?: boolean;
  /**
   * Idle keepalive interval, ms. Between PTT turns no audio flows, so we ping
   * Soniox to keep the socket from idling out. Default 10000. Set 0 to disable.
   */
  keepaliveMs?: number;
}

const defaultSTTOptions: Required<Omit<SonioxSTTOptions, 'apiKey'>> & {
  apiKey: string | undefined;
} = {
  apiKey: process.env.SONIOX_API_KEY,
  model: process.env.SONIOX_MODEL || 'stt-rt-v4',
  sampleRate: 16_000,
  bufferSizeMs: 120,
  languageHints: ['es', 'en'],
  enableEndpointDetection: true,
  enableLanguageIdentification: true,
  keepaliveMs: 10_000,
};

interface SonioxToken {
  text?: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final?: boolean;
  language?: string;
}

interface SonioxMessage {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

export class STT extends stt.STT {
  #opts: Required<Omit<SonioxSTTOptions, 'apiKey'>> & { apiKey: string };
  label = 'soniox.STT';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Soniox';
  }

  constructor(opts: SonioxSTTOptions = {}) {
    super({ streaming: true, interimResults: true, alignedTranscript: 'word' });
    const apiKey = opts.apiKey ?? defaultSTTOptions.apiKey;
    if (!apiKey) {
      throw new Error(
        'Soniox API key is required. Pass `apiKey`, or set the SONIOX_API_KEY environment variable.',
      );
    }
    this.#opts = { ...defaultSTTOptions, ...opts, apiKey };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_frame: unknown): Promise<stt.SpeechEvent> {
    throw new Error('Non-streaming recognize is not supported on Soniox STT');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: Required<Omit<SonioxSTTOptions, 'apiKey'>> & { apiKey: string };
  #logger = log();
  #speechDurationInS = 0;
  // Final tokens accumulated since the last utterance boundary.
  #finalTokens: SonioxToken[] = [];
  label = 'soniox.SpeechStream';

  constructor(
    stt2: STT,
    opts: Required<Omit<SonioxSTTOptions, 'apiKey'>> & { apiKey: string },
    connOptions?: APIConnectOptions,
  ) {
    super(stt2, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.closed = false;
  }

  // Reconnect loop around a single websocket lifetime (mirrors the AssemblyAI
  // and Deepgram plugins).
  protected async run(): Promise<void> {
    const maxRetry = 32;
    let retries = 0;
    while (!this.input.closed && !this.closed) {
      try {
        const ws = await this.#connectWS();
        await this.#runWS(ws);
        retries = 0;
      } catch (e) {
        if (!this.closed && !this.input.closed) {
          if (retries >= maxRetry) {
            throw new Error(`failed to connect to Soniox after ${retries} attempts: ${e}`);
          }
          const retryDelaySeconds = Math.min(retries * 5, 10);
          retries++;
          this.#logger.warn(
            `failed to connect to Soniox, retrying in ${retryDelaySeconds}s: ${e} (${retries}/${maxRetry})`,
          );
          await delay(retryDelaySeconds * 1e3);
        } else {
          this.#logger.warn(
            `Soniox disconnected, connection is closed: ${e} ` +
              `(inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
          );
        }
      }
    }
    this.closed = true;
  }

  async #connectWS(): Promise<WebSocket> {
    const ws = new WebSocket(SONIOX_WS_URL);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      ws.on('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
    });
    // First message must be the JSON config.
    ws.send(
      JSON.stringify({
        api_key: this.#opts.apiKey,
        model: this.#opts.model,
        audio_format: 's16le',
        sample_rate: this.#opts.sampleRate,
        num_channels: 1,
        language_hints: this.#opts.languageHints,
        enable_endpoint_detection: this.#opts.enableEndpointDetection,
        enable_language_identification: this.#opts.enableLanguageIdentification,
      }),
    );
    this.#logger.info(`[agent] STT: soniox ${this.#opts.model} (language_hints=${this.#opts.languageHints.join('+')})`);
    return ws;
  }

  async #runWS(ws: WebSocket): Promise<void> {
    let closing = false;
    const sessionController = new AbortController();

    const wsMonitor = Task.from(async (controller) => {
      const closed = new Promise<void>((_, reject) => {
        ws.once('close', (code, reason) => {
          if (!closing) {
            this.#logger.error(`Soniox WebSocket closed with code ${code}: ${reason}`);
            reject(new Error('WebSocket closed'));
          }
        });
      });
      await Promise.race([closed, waitForAbort(controller.signal)]);
    });

    // Keepalive: between PTT turns no audio flows, so ping Soniox to keep the
    // socket alive. Soniox documents a `keepalive` control request.
    let lastSendAt = Date.now();
    const keepalive =
      this.#opts.keepaliveMs > 0
        ? setInterval(() => {
            if (closing || ws.readyState !== WebSocket.OPEN) return;
            if (Date.now() - lastSendAt < this.#opts.keepaliveMs) return;
            try {
              ws.send(JSON.stringify({ type: 'keepalive' }));
            } catch {
              /* socket went away; reconnect loop handles it */
            }
          }, this.#opts.keepaliveMs)
        : undefined;

    const sendTask = async () => {
      const samplesPerBuffer = Math.floor((this.#opts.sampleRate * this.#opts.bufferSizeMs) / 1e3);
      const audioStream = new AudioByteStream(this.#opts.sampleRate, 1, samplesPerBuffer);
      const abortPromise = waitForAbort(this.abortSignal);
      const sessionAbort = waitForAbort(sessionController.signal);
      try {
        while (!this.closed) {
          const result = await Promise.race([this.input.next(), abortPromise, sessionAbort]);
          if (result === undefined) return; // aborted
          if (result.done) break;
          const data = result.value;
          let frames;
          if (data === SpeechStream.FLUSH_SENTINEL) {
            // PTT release / turn commit → force Soniox to finalize pending audio.
            for (const frame of audioStream.flush()) {
              this.#speechDurationInS += frame.samplesPerChannel / frame.sampleRate;
              ws.send(frame.data.buffer);
            }
            ws.send(JSON.stringify({ type: 'finalize' }));
            lastSendAt = Date.now();
            continue;
          } else if (data.sampleRate === this.#opts.sampleRate && data.channels === 1) {
            frames = audioStream.write(data.data.buffer);
          } else {
            throw new Error('sample rate or channel count of frame does not match');
          }
          for (const frame of frames) {
            this.#speechDurationInS += frame.samplesPerChannel / frame.sampleRate;
            ws.send(frame.data.buffer);
            lastSendAt = Date.now();
          }
        }
      } finally {
        closing = true;
        try {
          // Empty frame = end of stream.
          ws.send(new Uint8Array(0));
        } catch {
          /* ignore */
        }
        wsMonitor.cancel();
      }
    };

    let messageHandler: ((msg: Buffer, isBinary: boolean) => void) | null = null;
    const listenTask = Task.from(async (controller) => {
      const listenMessage = new Promise<void>((resolve, reject) => {
        messageHandler = (msg, isBinary) => {
          if (isBinary) {
            this.#logger.error('unexpected binary message from Soniox');
            return;
          }
          try {
            const json = JSON.parse(msg.toString()) as SonioxMessage;
            this.#processStreamEvent(json);
            if (json.finished || this.closed || closing) {
              resolve();
            }
          } catch (err) {
            this.#logger.error(`Soniox: error processing message: ${msg}`);
            reject(err);
          }
        };
        ws.on('message', messageHandler);
      });
      await Promise.race([listenMessage, waitForAbort(controller.signal)]);
    });

    try {
      await Promise.all([sendTask(), listenTask.result, wsMonitor.result]);
    } finally {
      closing = true;
      sessionController.abort();
      listenTask.cancel();
      if (keepalive) clearInterval(keepalive);
      if (messageHandler) ws.off('message', messageHandler);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  #averageConfidence(tokens: SonioxToken[]): number {
    if (tokens.length === 0) return 0;
    return tokens.reduce((sum, t) => sum + (t.confidence ?? 0), 0) / tokens.length;
  }

  #dominantLanguage(tokens: SonioxToken[]): LanguageCode {
    // Last token with a language tag wins; default to Spanish (the target lang).
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].language) return normalizeLanguage(tokens[i].language!);
    }
    return normalizeLanguage('es');
  }

  #toTimedStrings(tokens: SonioxToken[]): TimedString[] {
    return tokens.map((t) =>
      createTimedString({
        text: t.text ?? '',
        startTime: (t.start_ms ?? 0) / 1e3 + this.startTimeOffset,
        endTime: (t.end_ms ?? 0) / 1e3 + this.startTimeOffset,
        confidence: t.confidence ?? 0,
        startTimeOffset: this.startTimeOffset,
      }),
    );
  }

  #processStreamEvent(data: SonioxMessage): void {
    if (data.error_code) {
      this.#logger.error(`Soniox error ${data.error_code}: ${data.error_message ?? ''}`);
      return;
    }
    const tokens = data.tokens ?? [];
    if (tokens.length === 0) return;

    let boundaryHit = false;
    const nonFinalTokens: SonioxToken[] = [];
    for (const tok of tokens) {
      if (tok.text && BOUNDARY_TOKENS.has(tok.text)) {
        boundaryHit = true;
        continue;
      }
      if (tok.is_final) {
        this.#finalTokens.push(tok);
      } else {
        nonFinalTokens.push(tok);
      }
    }

    // Interim hypothesis = committed-final-so-far + current provisional tail.
    // Soniox tokens carry their own spacing, so concatenate verbatim.
    const interimTokens = [...this.#finalTokens, ...nonFinalTokens];
    if (interimTokens.length > 0) {
      const timedWords = this.#toTimedStrings(interimTokens);
      this.queue.put({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [
          {
            language: this.#dominantLanguage(interimTokens),
            text: interimTokens.map((t) => t.text ?? '').join('').trim(),
            startTime: timedWords[0]?.startTime ?? 0,
            endTime: timedWords[timedWords.length - 1]?.endTime ?? 0,
            confidence: this.#averageConfidence(interimTokens),
            words: timedWords,
          },
        ],
      });
    }

    if (boundaryHit) {
      const finalText = this.#finalTokens.map((t) => t.text ?? '').join('').trim();
      // Only emit a final turn when there's actual content — a `<fin>` from a
      // PTT release on silence carries no tokens and shouldn't fabricate a turn.
      if (finalText.length > 0) {
        const timedWords = this.#toTimedStrings(this.#finalTokens);
        this.queue.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [
            {
              language: this.#dominantLanguage(this.#finalTokens),
              text: finalText,
              startTime: timedWords[0]?.startTime ?? 0,
              endTime: timedWords[timedWords.length - 1]?.endTime ?? 0,
              confidence: this.#averageConfidence(this.#finalTokens),
              words: timedWords,
            },
          ],
        });
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
        if (this.#speechDurationInS > 0) {
          this.queue.put({
            type: stt.SpeechEventType.RECOGNITION_USAGE,
            recognitionUsage: { audioDuration: this.#speechDurationInS },
          });
          this.#speechDurationInS = 0;
        }
      }
      this.#finalTokens = [];
    }
  }
}

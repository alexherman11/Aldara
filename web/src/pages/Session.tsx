import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { SettingsDrawer } from '@/components/SettingsDrawer';
import { Waveform } from '@/components/Waveform';
import { X, Mic, Sparkles, Save, LogOut } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Room,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TranscriptionSegment,
} from 'livekit-client';
import {
  getToken,
  readStoredLearner,
  readSttChoice,
  readTtsChoice,
} from '@/lib/api';
import { getTtsPreference } from '@/lib/tts-settings';
import { devBus } from '@/lib/dev-bus';

const PARTICIPANT_IDENTITY = 'learner';

type OrbState = 'idle' | 'speaking' | 'listening';

type Fragment = { segId: string; text: string; final: boolean };

type Msg = {
  /** Stable id for React keys. Equals `${role}:${first segId}`. */
  id: string;
  role: 'tutor' | 'learner';
  /**
   * One bubble can absorb multiple LiveKit transcription segments that arrive
   * back-to-back from the same speaker. Without this, every streaming clause
   * Cartesia synthesizes (which the agent emits as a separate transcript id)
   * spawned its own little bubble — a visual rain.
   */
  fragments: Fragment[];
  /** True once every fragment is marked final. */
  final: boolean;
};

interface PronunciationWord {
  word: string;
  score: number;
  error_type: string;
  phoneme_sub?: { from: string; to: string };
  is_stretch: boolean;
}

interface PronunciationData {
  turn: number;
  reference_text: string;
  recognized_text?: string;
  overall: {
    accuracy: number;
    fluency: number;
    completeness: number;
    pronunciation: number;
  };
  prosody?: { score?: number; errors: Array<{ type: string }> };
  words: PronunciationWord[];
  divergence: boolean;
}

const FLAG_THRESHOLD = 70;
/** How long after PTT release we keep accepting learner transcript segments. */
const TRAILING_CAPTURE_MS = 1000;

/** Map LiveKit agent state attribute → orb visual */
function agentStateToOrb(agentState: string | undefined): OrbState {
  switch (agentState) {
    case 'speaking':
      return 'speaking';
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'speaking';
    case 'initializing':
    case 'idle':
    default:
      return 'idle';
  }
}

function normalizeText(s: string | undefined): string {
  // Strip punctuation AND bracket/quote characters that occasionally wrap STT
  // output (e.g. an older agent build sent reference_text as the JSON-encoded
  // `["..."]`). Whitespace collapsed to single spaces so two reasonable spellings
  // of the same utterance hash to the same bucket.
  return (s ?? '')
    .replace(/[.,!?;:¿¡"'`\[\]\(\)\{\}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function bubbleText(msg: Msg): string {
  return msg.fragments
    .map((f) => f.text.trim())
    .filter((t) => t.length > 0)
    .join(' ');
}

export default function Session() {
  const [, setLocation] = useLocation();
  const stored = readStoredLearner();

  // Read once on mount — readStoredLearner returns a fresh object each call
  // and we don't want the connect effect to retrigger.
  const learnerIdRef = useRef<string | null>(stored?.id ?? null);

  const [phase, setPhase] = useState<
    'connecting' | 'live' | 'ending' | 'ended' | 'error'
  >('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isPushing, setIsPushing] = useState(false);
  const [agentIdentity, setAgentIdentity] = useState<string | null>(null);
  // When true, the X button has been pressed once and we're waiting for the
  // user to choose between compaction and a no-save bail. Distinct from
  // phase='ending' (which is the *post-confirm* state when the RPC is in
  // flight) so the X button doesn't dispatch the RPC prematurely.
  const [showEndChoice, setShowEndChoice] = useState(false);

  /**
   * Per-turn pronunciation results indexed by normalized reference text. The
   * agent publishes after Azure completes (~400ms after the learner stops);
   * by then the corresponding learner bubble is already on screen, so we
   * attach by text match rather than by an in-flight turn counter we'd have
   * to keep synchronized with the agent.
   */
  const [pronunciation, setPronunciation] = useState<
    Map<string, PronunciationData>
  >(() => new Map());

  const roomRef = useRef<Room | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  /**
   * True from the moment the user presses PTT until 1 s after release. The
   * mic itself never mutes — Deepgram is producing interim transcripts the
   * whole time and emitting them on `TranscriptionReceived`. Without this
   * gate the learner side of the conversation visibly transcribes whatever
   * the mic picks up at all times, which made it impossible to tell which
   * speech Sofía actually heard.
   *
   * Trailing-edge window (TRAILING_CAPTURE_MS) keeps the gate open after
   * release so the last syllable of the learner's utterance — which often
   * lands ~300-500ms after their finger lifts — still makes it onto the
   * bubble and into the ptt_end commit.
   */
  const capturingRef = useRef<boolean>(false);
  const pttReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Learner segment ids that arrived inside an active capture window. Once a
   * seg id is admitted we keep updating it even after the window closes,
   * because Deepgram re-emits the same id with the final transcript a moment
   * later — discarding the final would leave the bubble stuck on the interim.
   */
  const admittedLearnerSegsRef = useRef<Set<string>>(new Set());

  // ── Connect to LiveKit once the page mounts ──────────────────────

  useEffect(() => {
    let cancelled = false;
    const learnerId = learnerIdRef.current;
    if (!learnerId) {
      setLocation('/signup');
      return;
    }

    (async () => {
      // Pre-flight: nudge the OS mic permission prompt before LiveKit grabs
      // the device. Without this, a denial gets swallowed inside the SDK and
      // surfaces as a confusing "track failed to publish" later.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(
            err instanceof Error && err.name === 'NotAllowedError'
              ? 'Microphone blocked. Allow it in the browser address bar and try again.'
              : `Mic error: ${err instanceof Error ? err.message : String(err)}`,
          );
          setPhase('error');
        }
        return;
      }

      let token: string;
      let url: string;
      let roomName: string;
      try {
        roomName = `habla-${learnerId.slice(0, 8)}-${Date.now()}`;
        // Pull both the legacy single-string voice id and the new paired
        // provider/voice pref. Backend prefers the paired form when both
        // are present, so the new TtsSettings picker wins seamlessly.
        const ttsPref = getTtsPreference();
        const t = await getToken({
          learnerId,
          room: roomName,
          tts: readTtsChoice(),
          ttsProvider: ttsPref?.provider,
          ttsVoice: ttsPref?.voice,
          stt: readSttChoice(),
        });
        token = t.token;
        url = t.url;
        devBus.setRoom({ roomName, url });
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(
            `Couldn't get a session token. Is the API server running? (${err instanceof Error ? err.message : String(err)})`,
          );
          setPhase('error');
        }
        return;
      }

      const room = new Room({
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        adaptiveStream: true,
      });
      roomRef.current = room;
      setupRoomEvents(room);

      try {
        await room.connect(url, token);
        // Mic stays live for the whole session — no toggle cost on press.
        // The agent gates which audio it *processes* through the ptt_start /
        // ptt_end RPC pair; the client-side bubble filter (see capturingRef)
        // mirrors that gate so the transcript only shows what Sofía heard.
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(
            `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          setPhase('error');
        }
        return;
      }

      if (!cancelled) setPhase('live');
    })();

    return () => {
      cancelled = true;
      if (pttReleaseTimerRef.current) {
        clearTimeout(pttReleaseTimerRef.current);
        pttReleaseTimerRef.current = null;
      }
      capturingRef.current = false;
      admittedLearnerSegsRef.current.clear();
      const room = roomRef.current;
      roomRef.current = null;
      if (room) {
        room.disconnect().catch(() => {});
      }
      audioElsRef.current.forEach((el) => {
        el.pause();
        el.srcObject = null;
        el.remove();
      });
      audioElsRef.current.clear();
      devBus.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll transcript ────────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // ── Hold-to-talk (mouse / touch / space bar) ──────────────────────

  const startPtt = useCallback(async () => {
    const room = roomRef.current;
    if (!room || phase !== 'live') return;
    const target = findAgentIdentity(room);
    if (!target) return;
    // Cancel any pending trailing-edge release from the previous turn — if the
    // user presses again within the trailing window we treat it as one
    // continuous turn rather than starting a second one mid-commit.
    if (pttReleaseTimerRef.current) {
      clearTimeout(pttReleaseTimerRef.current);
      pttReleaseTimerRef.current = null;
    }
    capturingRef.current = true;
    setIsPushing(true);
    devBus.setPtt({ capturing: true, lastStart: Date.now() });
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: target,
        method: 'ptt_start',
        payload: '',
      });
    } catch (err) {
      console.warn('ptt_start failed:', err);
      capturingRef.current = false;
      setIsPushing(false);
      devBus.setPtt({ capturing: false });
    }
  }, [phase]);

  const endPtt = useCallback(() => {
    const room = roomRef.current;
    if (!room || phase !== 'live') return;
    setIsPushing(false);
    const target = findAgentIdentity(room);
    if (!target) return;

    // Hold capture open for one extra second on the trailing edge. Deepgram
    // routinely lands the final syllable ~300-500 ms after the button is
    // released; without this delay the learner's last word gets clipped and
    // the agent commits an utterance missing its tail.
    if (pttReleaseTimerRef.current) clearTimeout(pttReleaseTimerRef.current);
    pttReleaseTimerRef.current = setTimeout(() => {
      capturingRef.current = false;
      pttReleaseTimerRef.current = null;
      devBus.setPtt({ capturing: false, lastEnd: Date.now() });
      void room.localParticipant
        .performRpc({
          destinationIdentity: target,
          method: 'ptt_end',
          payload: '',
        })
        .catch((err) => console.warn('ptt_end failed:', err));
    }, TRAILING_CAPTURE_MS);
  }, [phase]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      void startPtt();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      void endPtt();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [startPtt, endPtt]);

  // ── End session + compaction ─────────────────────────────────────

  const handleEnd = useCallback(
    async (compact: boolean) => {
      setShowEndChoice(false);
      const room = roomRef.current;
      if (!room) {
        setLocation('/home');
        return;
      }
      const target = findAgentIdentity(room);
      if (!target) {
        setLocation('/home');
        return;
      }
      setPhase('ending');
      try {
        const resp = await room.localParticipant.performRpc({
          destinationIdentity: target,
          method: 'end_session',
          payload: JSON.stringify({ compact }),
          // Skip-compaction is fast (no LLM); compaction can take 10–15s on a
          // long session. Either path fits comfortably inside 60s.
          responseTimeout: 60_000,
        });
        const parsed = JSON.parse(resp);
        sessionStorage.setItem('habla_last_compaction', JSON.stringify(parsed));
      } catch (err) {
        console.warn('end_session failed:', err);
        sessionStorage.setItem(
          'habla_last_compaction',
          JSON.stringify({ ok: false, error: String(err) }),
        );
      } finally {
        setPhase('ended');
        // If the user explicitly chose not to compact, send them straight home
        // — the Summary screen has nothing meaningful to show them. Otherwise
        // go to /summary to see what changed.
        setLocation(compact ? '/summary' : '/home');
      }
    },
    [setLocation],
  );

  // ── Room event wiring ────────────────────────────────────────────

  function setupRoomEvents(room: Room) {
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      const s = p.attributes?.['lk.agent.state'];
      if (s) {
        setAgentIdentity(p.identity);
        setOrbState(agentStateToOrb(s));
        devBus.setAgent({ identity: p.identity, state: s, ts: Date.now() });
      }
    });

    room.on(
      RoomEvent.ParticipantAttributesChanged,
      (changed: Record<string, string>, p: Participant) => {
        if (changed['lk.agent.state']) {
          setAgentIdentity(p.identity);
          setOrbState(agentStateToOrb(changed['lk.agent.state']));
          devBus.setAgent({
            identity: p.identity,
            state: changed['lk.agent.state'],
            ts: Date.now(),
          });
        }
      },
    );

    room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (track.kind === 'audio') {
          const el = track.attach() as HTMLAudioElement;
          el.style.display = 'none';
          el.setAttribute('aria-hidden', 'true');
          document.body.appendChild(el);
          audioElsRef.current.set(participant.identity, el);
        }
      },
    );

    room.on(
      RoomEvent.TrackUnsubscribed,
      (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (track.kind === 'audio') {
          track.detach().forEach((el) => el.remove());
          audioElsRef.current.delete(participant.identity);
        }
      },
    );

    room.on(
      RoomEvent.TranscriptionReceived,
      (segments: TranscriptionSegment[], participant?: Participant) => {
        const isAgent =
          !!participant && participant.identity !== PARTICIPANT_IDENTITY;
        if (isAgent) {
          setMessages((prev) => {
            const next = mergeSegments(prev, segments, 'tutor');
            publishLastTurn(next, 'tutor');
            return next;
          });
          return;
        }

        // Learner side: Deepgram emits interim transcripts continuously while
        // the mic is live. Only admit segments whose id was first seen inside
        // an active capture window. Once admitted, all later updates for that
        // seg id pass through (so the streaming interim → final upgrade still
        // refines the same bubble after release).
        const admitted = admittedLearnerSegsRef.current;
        const allowed: TranscriptionSegment[] = [];
        for (const seg of segments) {
          if (admitted.has(seg.id)) {
            allowed.push(seg);
          } else if (capturingRef.current) {
            admitted.add(seg.id);
            allowed.push(seg);
          }
          // else: arrived between PTT presses → drop silently.
        }
        if (allowed.length > 0) {
          setMessages((prev) => {
            const next = mergeSegments(prev, allowed, 'learner');
            publishLastTurn(next, 'learner');
            return next;
          });
        }
      },
    );

    // Pronunciation render data published by the agent immediately after the
    // Azure (or SpeechAce) call completes. We stash by normalized reference
    // text so the corresponding learner bubble — already on screen by the
    // time the result arrives — lights up retroactively.
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _participant?, _kind?, topic?: string) => {
        if (topic !== 'pronunciation') return;
        try {
          const data = JSON.parse(
            new TextDecoder().decode(payload),
          ) as PronunciationData & { type: string };
          if (data.type !== 'pronunciation') return;
          const key = normalizeText(data.reference_text);
          setPronunciation((prev) => {
            const m = new Map(prev);
            m.set(key, data);
            return m;
          });
          devBus.setPronunciation({
            reference_text: data.reference_text,
            recognized_text: data.recognized_text,
            overall: data.overall,
            divergence: data.divergence,
            ts: Date.now(),
          });
        } catch (err) {
          console.warn('pronunciation payload parse failed:', err);
        }
      },
    );

    room.on(RoomEvent.Connected, () => {
      for (const [, p] of room.remoteParticipants) {
        const s = p.attributes?.['lk.agent.state'];
        if (s) {
          setAgentIdentity(p.identity);
          setOrbState(agentStateToOrb(s));
          devBus.setAgent({ identity: p.identity, state: s, ts: Date.now() });
        }
      }
    });
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div
      className="h-full min-h-0 flex flex-col relative bg-background"
      data-testid="session-screen"
    >
      {/* Header — menu on the left for mid-session access to Profile /
          Developer (live diagnostics flow into the dev-bus from this page,
          so it's most useful while the conversation is actually running),
          status pill in the middle, end-session X on the right. */}
      <div className="px-6 pt-10 pb-3 flex items-center z-20 shrink-0 gap-2">
        <SettingsDrawer />
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className="w-2 h-2 rounded-full block shrink-0"
            style={{
              background:
                phase === 'live'
                  ? 'hsl(15 85% 52%)'
                  : 'hsl(var(--muted-foreground))',
              boxShadow:
                phase === 'live' ? '0 0 6px hsl(15 85% 52% / 0.6)' : 'none',
              animation:
                phase === 'live' ? 'pulse 1.4s ease-in-out infinite' : 'none',
            }}
          />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest truncate">
            {phase === 'connecting'
              ? 'Connecting…'
              : phase === 'live'
                ? 'Live'
                : phase === 'ending'
                  ? 'Compacting…'
                  : phase === 'ended'
                    ? 'Ended'
                    : 'Offline'}
          </span>
        </div>
        <button
          onClick={() => setShowEndChoice(true)}
          disabled={phase === 'ending'}
          className="p-2 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          data-testid="btn-end-session"
          title="End this session"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* End-of-session choice modal — appears when the user clicks X.
          Two paths: "compact" (current behavior; calls Claude, updates cores,
          seeds FSRS, then routes to /summary) or "just end" (fires the same
          RPC with compact:false so the agent skips the LLM call and FSRS
          writes, then routes straight home). Either choice closes the
          LiveKit room from the cleanup effect on unmount. */}
      {showEndChoice && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center px-6"
          style={{ background: 'hsl(var(--background) / 0.78)' }}
          data-testid="end-choice-modal"
          onClick={() => setShowEndChoice(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="w-full max-w-sm bg-card border border-border rounded-2xl p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-xl text-foreground mb-1">
              End this session?
            </h2>
            <p className="text-sm text-muted-foreground mb-5 leading-snug">
              Compacting takes 10–15 seconds — Sofía reviews the transcript,
              updates your cores, and adds new words to your FSRS deck. You can
              also just end without saving any of that.
            </p>

            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleEnd(true)}
                className="w-full h-12 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-white"
                style={{
                  background:
                    'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
                  boxShadow: '0 4px 16px hsl(15 85% 52% / 0.30)',
                }}
                data-testid="btn-end-compact"
              >
                <Save className="w-4 h-4" />
                Compact and save
              </button>
              <button
                onClick={() => void handleEnd(false)}
                className="w-full h-11 rounded-xl flex items-center justify-center gap-2 text-sm font-medium border border-border bg-background text-muted-foreground hover:text-foreground transition-colors"
                data-testid="btn-end-skip"
              >
                <LogOut className="w-4 h-4" />
                End without saving
              </button>
              <button
                onClick={() => setShowEndChoice(false)}
                className="w-full h-9 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                data-testid="btn-end-cancel"
              >
                Keep talking
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Error banner */}
      {phase === 'error' && (
        <div
          className="absolute top-20 left-1/2 -translate-x-1/2 z-30 max-w-md px-4 py-3 rounded-xl text-sm text-center"
          style={{
            background: 'hsl(0 70% 50% / 0.10)',
            border: '1px solid hsl(0 70% 50% / 0.30)',
            color: 'hsl(0 70% 38%)',
          }}
        >
          {errorMsg}
          <div className="mt-2">
            <button
              onClick={() => setLocation('/home')}
              className="text-xs underline opacity-70 hover:opacity-100"
            >
              Back home
            </button>
          </div>
        </div>
      )}

      {/* Transcript — single centered column, no chat bubbles. Generous bottom
          padding so the last entry never scrolls under the orb's sonar/halo
          rings (which animate up to ~70px outside the orb's 96x96 wrapper).
          Sofía's lines render as plain centered text with a small speaker
          label; learner lines get a soft warm-orange pill so the speaker is
          unambiguous without bubble-shape cues. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-5 pt-4 pb-32 flex flex-col items-center gap-7"
        style={{ scrollbarWidth: 'none' }}
      >
        {messages.length === 0 && phase === 'live' && (
          <div className="max-w-md text-center text-sm text-muted-foreground mt-12">
            Sofía is here. Hold the mic button and say{' '}
            <em>“hola”</em>, or wait — she may greet you first.
          </div>
        )}
        <AnimatePresence>
          {messages.map((msg) => {
            const text = bubbleText(msg);
            const pron =
              msg.role === 'learner'
                ? pronunciation.get(normalizeText(text))
                : null;
            const label = msg.role === 'tutor' ? 'Sofía' : 'tú';
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: msg.final ? 1 : 0.65, y: 0 }}
                transition={{ duration: 0.25 }}
                className="w-full max-w-[640px] flex flex-col items-center gap-2"
              >
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
                  style={{ opacity: 0.7 }}
                >
                  {label}
                </span>

                {msg.role === 'tutor' ? (
                  <p
                    className="font-serif text-lg leading-relaxed text-foreground text-center px-2"
                    data-testid="bubble-tutor"
                  >
                    {text || <em className="opacity-50">…</em>}
                  </p>
                ) : (
                  <div
                    className="rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed text-center border"
                    style={{
                      background: 'hsl(15 85% 52% / 0.10)',
                      borderColor: 'hsl(15 85% 52% / 0.22)',
                      color: 'hsl(15 60% 36%)',
                    }}
                    data-testid="bubble-learner"
                  >
                    {text ? (
                      pron ? (
                        <AnnotatedLearnerText text={text} pron={pron} />
                      ) : (
                        text
                      )
                    ) : (
                      <em className="opacity-50">…</em>
                    )}
                  </div>
                )}

                {pron && msg.role === 'learner' && (
                  <PronunciationSummary pron={pron} />
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Bottom — orb + push-to-talk. Fixed top padding (`pt-16`) reserves the
          vertical room the orb's halo/sonar rings need so they don't bleed
          into the transcript area above. A tall fade gradient (~120px) masks
          any bubble that does manage to scroll into this region.
          The waveform sits in a fixed-height row so the orb doesn't jump
          vertically when listening state toggles. */}
      <div
        className="shrink-0 flex flex-col items-center pt-16 pb-6"
        style={{
          background:
            'linear-gradient(to top, hsl(var(--background)) 65%, hsl(var(--background) / 0) 100%)',
        }}
      >
        <div className="h-7 flex items-end justify-center">
          <AnimatePresence>
            {orbState === 'listening' && (
              <motion.div
                key="waveform"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Waveform />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <motion.div
          layoutId="dara-orb"
          style={{ width: 96, height: 96, marginTop: 8 }}
          transition={{ layout: { duration: 1.2, ease: [0.22, 1, 0.36, 1] } }}
        >
          <Orb state={orbState} />
        </motion.div>

        <p className="mt-3 mb-3 text-xs text-muted-foreground font-medium h-4">
          {phase === 'connecting'
            ? 'Connecting to Sofía…'
            : orbState === 'speaking'
              ? 'Sofía is speaking…'
              : isPushing
                ? 'Listening…'
                : 'Sofía'}
        </p>

        <button
          onMouseDown={startPtt}
          onMouseUp={endPtt}
          onMouseLeave={isPushing ? endPtt : undefined}
          onTouchStart={(e) => {
            e.preventDefault();
            void startPtt();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            void endPtt();
          }}
          disabled={phase !== 'live' || !agentIdentity}
          aria-label="Hold to speak. Or press and hold the Space bar."
          className="px-7 h-14 rounded-full text-base font-semibold text-white transition-all disabled:opacity-40 select-none flex items-center gap-2"
          style={{
            background: isPushing
              ? 'linear-gradient(135deg, hsl(0 80% 50%), hsl(15 90% 56%))'
              : 'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
            boxShadow: isPushing
              ? '0 6px 24px hsl(0 80% 50% / 0.45)'
              : '0 4px 18px hsl(15 85% 52% / 0.25)',
            transform: isPushing ? 'scale(0.97)' : 'scale(1)',
          }}
          data-testid="btn-ptt"
        >
          <Mic className="w-4 h-4" />
          {isPushing ? 'Release to send' : 'Hold to speak'}
        </button>
        <p className="mt-2 text-[10px] uppercase tracking-widest text-muted-foreground opacity-60">
          or press and hold <kbd>Space</kbd>
        </p>

        {phase === 'ending' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-4 py-2 rounded-full bg-card border border-border text-sm text-muted-foreground flex items-center gap-2 shadow-md">
              <Sparkles className="w-4 h-4 animate-pulse" />
              Compacting session — this may take up to 15 seconds
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Tokenize the learner's transcript on whitespace, match each token to a
 * pronunciation-engine word (punctuation-stripped, case-insensitive), and
 * decorate flagged words with a colored underline + inline phoneme arrow.
 *
 * Stretch words (FSRS items the tutor is scaffolding) get a green highlight
 * even when scored cleanly — they're a "you reached for it" moment worth
 * celebrating. Mispronunciations (<70) get a warm-red underline; if the
 * engine also captured the substituted phoneme we render it as a small inline
 * citation like  hablo[/h/→/x/] espanol, mirroring the user's mental model
 * for how Sofía should be acting on these.
 */
function AnnotatedLearnerText({
  text,
  pron,
}: {
  text: string;
  pron: PronunciationData;
}) {
  const byKey = new Map<string, PronunciationWord>();
  for (const w of pron.words) {
    byKey.set(normalizeText(w.word), w);
  }

  // Split on whitespace while preserving the inter-word spaces so we can
  // re-render the original spacing untouched.
  const tokens = text.split(/(\s+)/);
  return (
    <span>
      {tokens.map((tok, i) => {
        if (/^\s+$/.test(tok) || tok === '') {
          return <React.Fragment key={i}>{tok}</React.Fragment>;
        }
        const w = byKey.get(normalizeText(tok));
        if (!w) {
          return <React.Fragment key={i}>{tok}</React.Fragment>;
        }
        const flagged = w.score < FLAG_THRESHOLD || w.error_type !== 'None';
        const stretch = w.is_stretch;

        let underline = 'none';
        let color: string | undefined;
        let background: string | undefined;
        if (flagged) {
          underline = '2px solid hsl(0 75% 48%)';
          color = 'hsl(0 65% 32%)';
        } else if (stretch) {
          background = 'hsl(140 60% 50% / 0.18)';
          color = 'hsl(140 60% 28%)';
        }

        const title = `Pronunciation ${w.score}/100${
          w.phoneme_sub
            ? ` — produced /${w.phoneme_sub.to}/ where /${w.phoneme_sub.from}/ was expected`
            : ''
        }${w.error_type !== 'None' ? ` (${w.error_type})` : ''}${
          stretch ? ' · FSRS stretch word' : ''
        }`;

        return (
          <span
            key={i}
            title={title}
            style={{
              textDecoration: underline,
              textUnderlineOffset: '3px',
              textDecorationSkipInk: 'none',
              color,
              background,
              padding: background ? '0 2px' : undefined,
              borderRadius: background ? 3 : undefined,
              transition: 'color 200ms ease, background 200ms ease',
            }}
            data-flagged={flagged ? 'true' : 'false'}
            data-stretch={stretch ? 'true' : 'false'}
          >
            {tok}
            {flagged && w.phoneme_sub && (
              <span
                aria-hidden="true"
                style={{
                  fontSize: '0.7em',
                  marginLeft: 2,
                  color: 'hsl(0 60% 40%)',
                  opacity: 0.85,
                  fontFamily: 'var(--app-font-mono)',
                }}
              >
                [/{w.phoneme_sub.from}/→/{w.phoneme_sub.to}/]
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/**
 * One-line band below a learner bubble that conveys the overall score, any
 * STT/assessor divergence, and persistent prosody flags. Mirrors what the
 * agent sees in its system prompt — the goal is for the learner to register
 * the same signals Sofía is acting on.
 */
function PronunciationSummary({ pron }: { pron: PronunciationData }) {
  const score = Math.round(pron.overall.pronunciation);
  const tone =
    score >= 85
      ? 'hsl(140 60% 28%)'
      : score >= 70
        ? 'hsl(38 70% 30%)'
        : 'hsl(0 65% 35%)';
  const bg =
    score >= 85
      ? 'hsl(140 60% 50% / 0.10)'
      : score >= 70
        ? 'hsl(38 90% 55% / 0.12)'
        : 'hsl(0 75% 50% / 0.10)';
  return (
    <div
      className="text-[11px] font-medium px-2 py-0.5 rounded-md flex items-center gap-2"
      style={{ color: tone, background: bg }}
      data-testid="pronunciation-summary"
    >
      <span>Pronunciation {score}</span>
      {pron.divergence && pron.recognized_text && (
        <span className="opacity-80 italic">
          heard “{pron.recognized_text.trim()}”
        </span>
      )}
      {pron.prosody?.errors?.some((e) => e.type === 'Monotone') && (
        <span className="opacity-80">· monotone</span>
      )}
    </div>
  );
}

/**
 * Merge an incoming batch of segments into the running message list.
 *
 * Two responsibilities:
 *   1. **In-place update** when LiveKit re-emits the same segment id with new
 *      text (the streaming-partial → final pattern).
 *   2. **Coalesce same-role chunks** into a single bubble. The LLM emits text
 *      in clause-sized chunks (see PIPELINE_ARCH § text buffer); each chunk
 *      lands as its own transcription segment with a fresh id. Naively keying
 *      the bubble on `${role}:${segId}` then spawns a new bubble per clause,
 *      producing the "audio flowing down the screen in multiple small bubbles"
 *      effect. We instead attach the new segment as a fragment of the
 *      currently-open bubble for that role; a turn boundary is implicit —
 *      arrival of a segment from the OTHER role.
 */
function mergeSegments(
  prev: Msg[],
  segments: TranscriptionSegment[],
  role: 'tutor' | 'learner',
): Msg[] {
  let next = prev;
  let mutated = false;

  for (const seg of segments) {
    // 1. Update path — segment id already lives in some bubble.
    let updatedExisting = false;
    for (let i = 0; i < next.length; i++) {
      const bubble = next[i];
      const fragIdx = bubble.fragments.findIndex((f) => f.segId === seg.id);
      if (fragIdx < 0) continue;
      if (!mutated) {
        next = [...next];
        mutated = true;
      }
      const newFrags = [...bubble.fragments];
      newFrags[fragIdx] = {
        segId: seg.id,
        text: seg.text,
        final: seg.final,
      };
      next[i] = {
        ...bubble,
        fragments: newFrags,
        final: newFrags.every((f) => f.final),
      };
      updatedExisting = true;
      break;
    }
    if (updatedExisting) continue;

    // 2. New segment id. Is there a still-open bubble for this role at the
    // tail? An "open" bubble is one not yet shouldered aside by a segment
    // from the other speaker.
    let openIdx = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role !== role) break;
      openIdx = i;
      // Only the most recent same-role bubble is "open"; older ones are sealed
      // by the eventual other-role bubble. We want the last bubble of `role`
      // immediately before any other-role bubble — i.e. the first hit walking
      // back from the tail.
      break;
    }

    if (!mutated) {
      next = [...next];
      mutated = true;
    }

    const newFrag: Fragment = {
      segId: seg.id,
      text: seg.text,
      final: seg.final,
    };

    if (openIdx >= 0) {
      const cur = next[openIdx];
      const newFrags = [...cur.fragments, newFrag];
      next[openIdx] = {
        ...cur,
        fragments: newFrags,
        final: newFrags.every((f) => f.final),
      };
    } else {
      next.push({
        id: `${role}:${seg.id}`,
        role,
        fragments: [newFrag],
        final: seg.final,
      });
    }
  }

  return mutated ? next : prev;
}

/**
 * Publish the most recent same-role bubble to the dev bus. Called after each
 * mergeSegments so the Developer tab's "live session" disclosure stays in
 * sync with what the user just saw on screen, including streaming partials.
 */
function publishLastTurn(messages: Msg[], role: 'tutor' | 'learner') {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== role) continue;
    devBus.recordTurn({
      role: m.role,
      text: bubbleText(m),
      final: m.final,
      ts: Date.now(),
    });
    return;
  }
}

function findAgentIdentity(room: Room): string | null {
  for (const [, p] of room.remoteParticipants) {
    if (p.attributes?.['lk.agent.state']) return p.identity;
  }
  return null;
}

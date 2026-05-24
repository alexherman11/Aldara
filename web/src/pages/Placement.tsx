import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { Waveform } from '@/components/Waveform';
import { Mic, Sparkles } from 'lucide-react';
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
  patchStoredLearner,
  readStoredLearner,
  readTtsChoice,
} from '@/lib/api';
import { getTtsPreference } from '@/lib/tts-settings';
import {
  PARTICIPANT_IDENTITY,
  PLACEMENT_CALIBRATION_TOPIC,
  agentStateToOrb,
  bubbleText,
  findAgentIdentity,
  mergeSegments,
  type Msg,
  type OrbState,
  type PlacementCalibrationSnapshot,
} from '@/lib/voice';
import { PlacementCalibrationBar } from '@/components/PlacementCalibrationBar';

/** Total placement length, and how long before the end Sofía is cued to wrap. */
const PLACEMENT_SECONDS = 300;
const WRAP_AT_SECONDS = 25;
/** How long after PTT release we keep accepting learner transcript segments. */
const TRAILING_CAPTURE_MS = 1000;

type Phase = 'connecting' | 'live' | 'finishing' | 'result' | 'error';

interface PlacementResult {
  placedLevel: string;
  placedRatio: number;
  markedLevel: string | null;
  confidence: number;
  converged: boolean;
  calibrationTurns: number;
}

export default function Placement() {
  const [, setLocation] = useLocation();
  const stored = readStoredLearner();
  const learnerIdRef = useRef<string | null>(stored?.id ?? null);
  const markedLevelRef = useRef<string | null>(stored?.cefr_level ?? null);

  const [phase, setPhase] = useState<Phase>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isPushing, setIsPushing] = useState(false);
  const [agentIdentity, setAgentIdentity] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(PLACEMENT_SECONDS);
  const [result, setResult] = useState<PlacementResult | null>(null);
  // Per-turn calibration snapshots from the backend agent. Append-only — we
  // keep the full history so the bar's sparkline can show the trajectory.
  const [calibrationHistory, setCalibrationHistory] = useState<
    PlacementCalibrationSnapshot[]
  >([]);

  const roomRef = useRef<Room | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Capture-window gating — mirrors Session.tsx so the learner transcript only
  // shows speech captured between push-to-talk events.
  const capturingRef = useRef(false);
  const pttReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const admittedLearnerSegsRef = useRef<Set<string>>(new Set());

  // One-shot guards so the timer never fires these twice.
  const wrapSentRef = useRef(false);
  const finishingRef = useRef(false);

  // ── Connect to LiveKit on mount ──────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const learnerId = learnerIdRef.current;
    if (!learnerId) {
      setLocation('/signup');
      return;
    }

    (async () => {
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
      try {
        const ttsPref = getTtsPreference();
        const t = await getToken({
          learnerId,
          mode: 'placement',
          room: `placement-${learnerId.slice(0, 8)}-${Date.now()}`,
          tts: readTtsChoice(),
          ttsProvider: ttsPref?.provider,
          ttsVoice: ttsPref?.voice,
        });
        token = t.token;
        url = t.url;
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
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
        adaptiveStream: true,
      });
      roomRef.current = room;
      setupRoomEvents(room);

      try {
        await room.connect(url, token);
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

      // Guard against a skip that landed during the connect window.
      if (!cancelled && !finishingRef.current) setPhase('live');
    })();

    return () => {
      cancelled = true;
      if (pttReleaseTimerRef.current) clearTimeout(pttReleaseTimerRef.current);
      capturingRef.current = false;
      admittedLearnerSegsRef.current.clear();
      const room = roomRef.current;
      roomRef.current = null;
      if (room) room.disconnect().catch(() => {});
      audioElsRef.current.forEach((el) => {
        el.pause();
        el.srcObject = null;
        el.remove();
      });
      audioElsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll transcript ───────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // ── Countdown ────────────────────────────────────────────────────

  useEffect(() => {
    if (phase !== 'live') return;
    const iv = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(iv);
  }, [phase]);

  // React to the countdown crossing the wrap cue and zero.
  useEffect(() => {
    if (phase !== 'live') return;
    if (remaining <= WRAP_AT_SECONDS && !wrapSentRef.current) {
      wrapSentRef.current = true;
      void sendWrapCue();
    }
    if (remaining <= 0) void endPlacement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, phase]);

  // ── Push-to-talk ─────────────────────────────────────────────────

  const startPtt = useCallback(async () => {
    const room = roomRef.current;
    if (!room || phase !== 'live') return;
    const target = findAgentIdentity(room);
    if (!target) return;
    if (pttReleaseTimerRef.current) {
      clearTimeout(pttReleaseTimerRef.current);
      pttReleaseTimerRef.current = null;
    }
    capturingRef.current = true;
    setIsPushing(true);
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
    }
  }, [phase]);

  const endPtt = useCallback(() => {
    const room = roomRef.current;
    if (!room || phase !== 'live') return;
    setIsPushing(false);
    const target = findAgentIdentity(room);
    if (!target) return;
    if (pttReleaseTimerRef.current) clearTimeout(pttReleaseTimerRef.current);
    pttReleaseTimerRef.current = setTimeout(() => {
      capturingRef.current = false;
      pttReleaseTimerRef.current = null;
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

  // ── Wrap cue + finish ────────────────────────────────────────────

  const sendWrapCue = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const target = findAgentIdentity(room);
    if (!target) return;
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: target,
        method: 'placement_wrap',
        payload: '',
      });
    } catch (err) {
      console.warn('placement_wrap failed:', err);
    }
  }, []);

  const endPlacement = useCallback(async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setPhase('finishing');

    const room = roomRef.current;
    const target = room ? findAgentIdentity(room) : null;
    const markedLevel = markedLevelRef.current;

    let placement: PlacementResult | null = null;
    if (room && target) {
      try {
        const resp = await room.localParticipant.performRpc({
          destinationIdentity: target,
          method: 'end_placement',
          payload: '',
          responseTimeout: 20_000,
        });
        const parsed = JSON.parse(resp);
        if (parsed?.ok) {
          placement = {
            placedLevel: parsed.placedLevel,
            placedRatio: parsed.placedRatio,
            markedLevel: parsed.markedLevel ?? markedLevel,
            confidence: parsed.confidence ?? 0,
            converged: !!parsed.converged,
            calibrationTurns: parsed.calibrationTurns ?? 0,
          };
        }
      } catch (err) {
        console.warn('end_placement failed:', err);
      }
    }

    // Fall back to the self-rated level if the agent never answered — the
    // learner should never be trapped on this screen.
    if (!placement) {
      placement = {
        placedLevel: markedLevel ?? 'A1',
        placedRatio: 0,
        markedLevel,
        confidence: 0,
        converged: false,
        calibrationTurns: 0,
      };
    }

    roomRef.current = null;
    if (room) room.disconnect().catch(() => {});
    setResult(placement);
    setPhase('result');
  }, []);

  // ── Room event wiring ────────────────────────────────────────────

  function setupRoomEvents(room: Room) {
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      if (p.attributes?.['lk.agent.state']) {
        setAgentIdentity(p.identity);
        setOrbState(agentStateToOrb(p.attributes['lk.agent.state']));
      }
    });

    room.on(
      RoomEvent.ParticipantAttributesChanged,
      (changed: Record<string, string>, p: Participant) => {
        if (changed['lk.agent.state']) {
          setAgentIdentity(p.identity);
          setOrbState(agentStateToOrb(changed['lk.agent.state']));
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
          setMessages((prev) => mergeSegments(prev, segments, 'tutor'));
          return;
        }
        const admitted = admittedLearnerSegsRef.current;
        const allowed: TranscriptionSegment[] = [];
        for (const seg of segments) {
          if (admitted.has(seg.id)) {
            allowed.push(seg);
          } else if (capturingRef.current) {
            admitted.add(seg.id);
            allowed.push(seg);
          }
        }
        if (allowed.length > 0) {
          setMessages((prev) => mergeSegments(prev, allowed, 'learner'));
        }
      },
    );

    // Live calibration snapshots from the backend agent — one per learner
    // turn, published right after the calibration LLM call returns. Drives
    // the PlacementCalibrationBar debug card.
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _participant?, _kind?, topic?: string) => {
        if (topic !== PLACEMENT_CALIBRATION_TOPIC) return;
        try {
          const data = JSON.parse(
            new TextDecoder().decode(payload),
          ) as PlacementCalibrationSnapshot;
          if (typeof data?.ratio !== 'number') return;
          setCalibrationHistory((prev) => [...prev, data]);
        } catch (err) {
          console.warn('calibration payload parse failed:', err);
        }
      },
    );

    room.on(RoomEvent.Connected, () => {
      for (const [, p] of room.remoteParticipants) {
        if (p.attributes?.['lk.agent.state']) {
          setAgentIdentity(p.identity);
          setOrbState(agentStateToOrb(p.attributes['lk.agent.state']));
        }
      }
    });
  }

  // ── Result card ──────────────────────────────────────────────────

  if (phase === 'result' && result) {
    return (
      <ResultCard
        result={result}
        onContinue={() => {
          patchStoredLearner({ placed: true });
          setLocation('/daily-goal');
        }}
      />
    );
  }

  // ── Live placement UI ────────────────────────────────────────────

  return (
    <div
      className="h-full min-h-0 flex flex-col relative bg-background"
      data-testid="placement-screen"
    >
      {/* Header */}
      <div className="px-6 pt-10 pb-3 flex justify-between items-center z-20 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            Getting to know you
          </span>
        </div>
        <div className="flex items-center gap-3">
          {phase === 'live' && (
            <CountdownRing remaining={remaining} total={PLACEMENT_SECONDS} />
          )}
          <button
            onClick={() => void endPlacement()}
            disabled={phase === 'finishing'}
            className="text-xs font-medium text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:opacity-40"
            data-testid="btn-skip-placement"
            title="Skip the placement and start using the app"
          >
            Skip →
          </button>
        </div>
      </div>

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
              onClick={() => {
                patchStoredLearner({ placed: true });
                setLocation('/daily-goal');
              }}
              className="text-xs underline opacity-70 hover:opacity-100"
            >
              Continue without placement
            </button>
          </div>
        </div>
      )}

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-5 pt-2 pb-4 flex flex-col gap-3"
        style={{ scrollbarWidth: 'none' }}
      >
        {messages.length === 0 && phase === 'live' && (
          <div className="self-center max-w-md text-center text-sm text-muted-foreground mt-12">
            Sofía will say hello in a moment. Just chat with her like a friend —
            there's no test, and no wrong answers.
          </div>
        )}
        <AnimatePresence>
          {messages.map((msg) => {
            const text = bubbleText(msg);
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: msg.final ? 1 : 0.7, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`max-w-[82%] flex flex-col gap-1.5 ${msg.role === 'tutor' ? 'self-start' : 'self-end'}`}
              >
                <div
                  className={`rounded-2xl px-4 py-3 border text-[15px] leading-relaxed ${
                    msg.role === 'tutor'
                      ? 'bg-card text-foreground rounded-tl-sm border-border'
                      : 'rounded-tr-sm border-primary/20'
                  }`}
                  style={
                    msg.role === 'learner'
                      ? {
                          background: 'hsl(15 85% 52% / 0.12)',
                          color: 'hsl(15 60% 38%)',
                        }
                      : undefined
                  }
                  data-testid={`bubble-${msg.role}`}
                >
                  {text || <em className="opacity-50">…</em>}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Debug — live calibration bar. Default-expanded; toggle to hide. */}
      {phase !== 'error' && (
        <DebugCalibrationCard
          latest={
            calibrationHistory.length > 0
              ? calibrationHistory[calibrationHistory.length - 1]
              : null
          }
          history={calibrationHistory}
        />
      )}

      {/* Bottom — orb + push-to-talk */}
      <div
        className="shrink-0 flex flex-col items-center pb-6 pt-2"
        style={{
          background:
            'linear-gradient(to top, hsl(var(--background)) 80%, hsl(var(--background) / 0.92) 100%)',
        }}
      >
        <AnimatePresence>
          {orbState === 'listening' && (
            <motion.div
              key="waveform"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mb-3"
            >
              <Waveform />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          layoutId="dara-orb"
          style={{ width: 96, height: 96 }}
          transition={{ layout: { duration: 1.2, ease: [0.22, 1, 0.36, 1] } }}
        >
          <Orb state={orbState} />
        </motion.div>

        <p className="mt-2 mb-3 text-xs text-muted-foreground font-medium h-4">
          {phase === 'connecting'
            ? 'Connecting to Sofía…'
            : phase === 'finishing'
              ? 'Finding your level…'
              : orbState === 'speaking'
                ? 'Sofía is speaking…'
                : isPushing
                  ? 'Listening…'
                  : 'Hold to speak'}
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

        {phase === 'finishing' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-4 py-2 rounded-full bg-card border border-border text-sm text-muted-foreground flex items-center gap-2 shadow-md">
              <Sparkles className="w-4 h-4 animate-pulse" />
              Finding your level…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Debug calibration card ──────────────────────────────────────────
// Collapsible card mounted in the live placement screen showing the
// calibration controller's live state — ratio, CEFR, sparkline, latest
// learner snippet. Default-expanded so we always see it during dev; tap the
// header to collapse if it's in the way.

function DebugCalibrationCard({
  latest,
  history,
}: {
  latest: PlacementCalibrationSnapshot | null;
  history: PlacementCalibrationSnapshot[];
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div
      className="shrink-0 px-5 pt-2 pb-1"
      data-testid="debug-calibration-card"
    >
      <div className="rounded-xl border border-border bg-card/60 backdrop-blur-sm shadow-sm">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={expanded}
        >
          <span>Debug · Calibration</span>
          <span className="text-[10px] opacity-60">
            {expanded ? '▾' : '▸'}{' '}
            {history.length > 0 ? `${history.length} turns` : 'no data'}
          </span>
        </button>
        {expanded && (
          <div className="px-3 pb-3">
            <PlacementCalibrationBar latest={latest} history={history} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Countdown ring ──────────────────────────────────────────────────

function CountdownRing({
  remaining,
  total,
}: {
  remaining: number;
  total: number;
}) {
  const size = 42;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remaining / total));
  const mm = Math.floor(remaining / 60);
  const ss = String(Math.max(0, remaining % 60)).padStart(2, '0');
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(15 85% 52%)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold tabular-nums text-foreground">
        {mm}:{ss}
      </span>
    </div>
  );
}

// ── Result card ─────────────────────────────────────────────────────

const CEFR_LABEL: Record<string, string> = {
  A1: 'Beginner',
  A2: 'Elementary',
  B1: 'Intermediate',
  B2: 'Upper Intermediate',
  C1: 'Advanced',
  C2: 'Proficient',
};
const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function ResultCard({
  result,
  onContinue,
}: {
  result: PlacementResult;
  onContinue: () => void;
}) {
  const placed = result.placedLevel?.toUpperCase() ?? 'A1';
  const marked = result.markedLevel?.toUpperCase() ?? null;
  const label = CEFR_LABEL[placed] ?? 'Beginner';

  const placedRank = CEFR_ORDER.indexOf(placed);
  const markedRank = marked ? CEFR_ORDER.indexOf(marked) : placedRank;
  let comparison: string;
  if (!marked || placedRank === markedRank) {
    comparison = `Right where you'd expect — we'll begin at ${label}.`;
  } else if (placedRank < markedRank) {
    comparison = `We'll start a touch gentler than you guessed, at ${label}, and climb fast.`;
  } else {
    comparison = `You sold yourself short — you're already at ${label}.`;
  }

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center px-6"
      style={{
        background:
          'linear-gradient(160deg, hsl(38 30% 94%) 0%, hsl(28 22% 86%) 100%)',
      }}
      data-testid="placement-result"
    >
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm bg-card border border-border rounded-3xl p-8 shadow-lg flex flex-col items-center text-center"
      >
        <motion.div
          layoutId="dara-orb"
          style={{ width: 96, height: 96, marginBottom: 18 }}
          transition={{ layout: { duration: 1.0, ease: [0.22, 1, 0.36, 1] } }}
        >
          <Orb state="idle" />
        </motion.div>

        <p className="text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-2">
          Your starting level
        </p>

        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.25, type: 'spring', stiffness: 220, damping: 16 }}
          className="font-serif text-6xl tracking-wide mb-1"
          style={{ color: 'hsl(15 75% 45%)' }}
        >
          {placed}
        </motion.div>
        <p className="text-lg font-semibold text-foreground mb-3">{label}</p>
        <p className="text-sm text-muted-foreground mb-7">{comparison}</p>

        <button
          onClick={onContinue}
          className="w-full h-12 rounded-xl text-base font-semibold text-white transition-opacity"
          style={{
            background:
              'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
            boxShadow: '0 4px 18px hsl(15 85% 52% / 0.25)',
          }}
          data-testid="btn-continue-result"
        >
          Continue →
        </button>
      </motion.div>
    </div>
  );
}

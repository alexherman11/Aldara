import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { Waveform } from '@/components/Waveform';
import { X, Mic, Sparkles } from 'lucide-react';
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
import { getToken, readStoredLearner } from '@/lib/api';

const PARTICIPANT_IDENTITY = 'learner';

type OrbState = 'idle' | 'speaking' | 'listening';

type Msg = {
  id: string;
  role: 'tutor' | 'learner';
  text: string;
  final: boolean;
};

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

  const roomRef = useRef<Room | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

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
      try {
        const t = await getToken({
          learnerId,
          room: `habla-${learnerId.slice(0, 8)}-${Date.now()}`,
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
    setIsPushing(true);
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: target,
        method: 'ptt_start',
        payload: '',
      });
    } catch (err) {
      console.warn('ptt_start failed:', err);
      setIsPushing(false);
    }
  }, [phase]);

  const endPtt = useCallback(async () => {
    const room = roomRef.current;
    if (!room || phase !== 'live') return;
    setIsPushing(false);
    const target = findAgentIdentity(room);
    if (!target) return;
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: target,
        method: 'ptt_end',
        payload: '',
      });
    } catch (err) {
      console.warn('ptt_end failed:', err);
    }
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

  const handleEnd = useCallback(async () => {
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
        payload: '',
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
      setLocation('/summary');
    }
  }, [setLocation]);

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
        setMessages((prev) =>
          mergeSegments(prev, segments, isAgent ? 'tutor' : 'learner'),
        );
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

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div
      className="flex-1 flex flex-col relative bg-background"
      data-testid="session-screen"
    >
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 px-6 pt-10 pb-6 flex justify-between items-center z-20">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full block"
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
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
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
          onClick={handleEnd}
          disabled={phase === 'ending'}
          className="p-2 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          data-testid="btn-end-session"
          title="End and compact this session"
        >
          <X className="w-4 h-4" />
        </button>
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
              onClick={() => setLocation('/home')}
              className="text-xs underline opacity-70 hover:opacity-100"
            >
              Back home
            </button>
          </div>
        </div>
      )}

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 pt-28 pb-56 flex flex-col gap-3"
        style={{ scrollbarWidth: 'none' }}
      >
        {messages.length === 0 && phase === 'live' && (
          <div className="self-center max-w-md text-center text-sm text-muted-foreground mt-12">
            Sofía is here. Hold the mic button and say{' '}
            <em>“hola”</em>, or wait — she may greet you first.
          </div>
        )}
        <AnimatePresence>
          {messages.map((msg) => (
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
              >
                {msg.text || <em className="opacity-50">…</em>}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Bottom — orb + push-to-talk */}
      <div
        className="absolute bottom-0 left-0 right-0 flex flex-col items-center pb-8 pt-4"
        style={{
          background:
            'linear-gradient(to top, hsl(var(--background)) 70%, transparent)',
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
 * Merge an incoming batch of segments into the running message list. LiveKit
 * fires this event for both interim and final transcripts — update in place
 * by segment id so interim text replaces itself rather than spawning a new
 * bubble every frame.
 */
function mergeSegments(
  prev: Msg[],
  segments: TranscriptionSegment[],
  role: 'tutor' | 'learner',
): Msg[] {
  const next = [...prev];
  for (const seg of segments) {
    const id = `${role}:${seg.id}`;
    const idx = next.findIndex((m) => m.id === id);
    const m: Msg = { id, role, text: seg.text, final: seg.final };
    if (idx >= 0) next[idx] = m;
    else next.push(m);
  }
  return next;
}

function findAgentIdentity(room: Room): string | null {
  for (const [, p] of room.remoteParticipants) {
    if (p.attributes?.['lk.agent.state']) return p.identity;
  }
  return null;
}

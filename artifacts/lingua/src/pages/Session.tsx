import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { Waveform } from '@/components/Waveform';
import { X, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

type MsgNode = {
  id: number;
  text: string;
  sender: 'ai' | 'user';
  correction?: string;
  important?: boolean;
};

const conversation: MsgNode[] = [
  { id: 1, text: "¡Hola! ¿Qué hiciste este fin de semana?", sender: 'ai' },
  { id: 2, text: "Fui al cine con mis amigos.", sender: 'user' },
  { id: 3, text: "¿Qué película vieron?", sender: 'ai' },
  { id: 4, text: "Vimos un pelicula de accion.", sender: 'user', correction: "una película de acción" },
  { id: 5, text: "¡Ah, una película de acción! ¿Te gustó?", sender: 'ai', important: true },
  { id: 6, text: "Sí, fue muy emocionante.", sender: 'user' },
  { id: 7, text: "Excelente. Me encantan las películas emocionantes.", sender: 'ai' },
];

export default function Session() {
  const [, setLocation] = useLocation();
  const [messages, setMessages] = useState<MsgNode[]>([]);
  const [orbState, setOrbState] = useState<'idle' | 'speaking' | 'listening'>('idle');
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distFromBottom < 80;
  }, []);

  useEffect(() => {
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];
    let delay = 800;

    for (const msg of conversation) {
      timeoutIds.push(
        setTimeout(() => {
          setMessages(prev => [...prev, msg]);
          setOrbState(msg.sender === 'ai' ? 'speaking' : 'listening');
          shouldAutoScrollRef.current = true;
        }, delay),
      );
      delay += 4000;
      timeoutIds.push(setTimeout(() => setOrbState('idle'), delay - 1200));
    }

    return () => timeoutIds.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!scrollRef.current || !shouldAutoScrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 flex flex-col relative bg-background" data-testid="session-screen">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 px-6 pt-10 pb-6 flex justify-between items-center z-20">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full animate-pulse block"
            style={{ background: 'hsl(15 85% 52%)', boxShadow: '0 0 6px hsl(15 85% 52% / 0.6)' }}
          />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            Live
          </span>
        </div>
        <button
          onClick={() => setLocation('/summary')}
          className="p-2 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors"
          data-testid="btn-end-session"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-5 pt-28 pb-52 flex flex-col gap-3"
        style={{ scrollbarWidth: 'none' }}
      >
        <AnimatePresence>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className={`max-w-[82%] flex flex-col gap-1.5 ${msg.sender === 'ai' ? 'self-start' : 'self-end'}`}
            >
              <div
                className={`rounded-2xl px-4 py-3 border text-[15px] leading-relaxed ${
                  msg.sender === 'ai'
                    ? 'bg-card text-foreground rounded-tl-sm border-border'
                    : 'rounded-tr-sm border-primary/20'
                }`}
                style={
                  msg.sender === 'user'
                    ? { background: 'hsl(15 85% 52% / 0.12)', color: 'hsl(15 60% 38%)' }
                    : undefined
                }
              >
                {msg.text}
              </div>

              {/* Correction annotation */}
              {msg.correction && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  transition={{ delay: 0.4, duration: 0.3 }}
                  className="self-end flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs"
                  style={{
                    background: 'hsl(44 90% 52% / 0.10)',
                    borderColor: 'hsl(44 90% 52% / 0.30)',
                    color: 'hsl(38 80% 65%)',
                  }}
                >
                  <Sparkles className="w-3 h-3 shrink-0" />
                  <span>→ {msg.correction}</span>
                </motion.div>
              )}

              {/* Important highlight */}
              {msg.important && (
                <div
                  className="self-start text-xs px-2 py-0.5 rounded-md font-semibold"
                  style={{ background: 'hsl(15 85% 52% / 0.15)', color: 'hsl(15 70% 65%)' }}
                >
                  Key phrase
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Bottom — orb area */}
      <div
        className="absolute bottom-0 left-0 right-0 flex flex-col items-center pb-10 pt-4"
        style={{
          background: 'linear-gradient(to top, hsl(var(--background)) 60%, transparent)',
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

        <p className="mt-3 text-xs text-muted-foreground font-medium">
          {orbState === 'speaking' ? 'Dara is speaking...' : orbState === 'listening' ? 'Listening...' : 'Dara'}
        </p>
      </div>
    </div>
  );
}

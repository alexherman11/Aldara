import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { Waveform } from '@/components/Waveform';
import { motion, AnimatePresence } from 'framer-motion';

type Message = {
  id: number;
  text: string;
  sender: 'ai' | 'user';
  cefrLabel?: string;
};

const script: Message[] = [
  { id: 1, text: "¡Hola! Soy Dara, tu tutora de español. ¿Cómo te llamas?", sender: 'ai', cefrLabel: 'A1' },
  { id: 2, text: "Me llamo Alex. Mucho gusto.", sender: 'user' },
  { id: 3, text: "Encantada, Alex. ¿De dónde eres?", sender: 'ai', cefrLabel: 'A1' },
  { id: 4, text: "Soy de los Estados Unidos.", sender: 'user' },
  { id: 5, text: "¿Qué haces normalmente los fines de semana?", sender: 'ai', cefrLabel: 'A2' },
  { id: 6, text: "Salgo con mis amigos o veo películas en casa.", sender: 'user' },
  { id: 7, text: "¿Por qué quieres aprender español? ¿Tienes algún objetivo específico?", sender: 'ai', cefrLabel: 'A2–B1' },
  { id: 8, text: "Quiero viajar a México el año que viene y también hablar con mis colegas.", sender: 'user' },
  { id: 9, text: "¡Qué interesante! Cuéntame sobre algún viaje que hayas hecho. ¿Adónde fuiste y qué te gustó más?", sender: 'ai', cefrLabel: 'B1' },
  { id: 10, text: "Fui a Colombia hace dos años. Me encantó la comida y la música. La gente fue muy amable.", sender: 'user' },
  { id: 11, text: "Perfecto. ¿Crees que aprender idiomas cambia la forma en que ves el mundo? ¿Por qué?", sender: 'ai', cefrLabel: 'B1–B2' },
  { id: 12, text: "Sí, totalmente. Te permite entender otras culturas y ver las cosas desde diferentes perspectivas.", sender: 'user' },
  { id: 13, text: "Si pudieras vivir en cualquier país hispanohablante, ¿cuál elegirías y por qué?", sender: 'ai', cefrLabel: 'B2' },
  { id: 14, text: "Elegiría Argentina porque me parece que tiene una cultura muy rica y me encantaría explorar la Patagonia.", sender: 'user' },
  { id: 15, text: "Excelente, Alex. He evaluado tu nivel. ¡Empecemos tu camino al español!", sender: 'ai' },
];

const CEFR_RESULT = 'B1';

export default function Assessment() {
  const [, setLocation] = useLocation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [orbState, setOrbState] = useState<'idle' | 'speaking' | 'listening'>('idle');
  const [currentCefr, setCurrentCefr] = useState('A1');
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];
    let delay = 1800;

    for (const msg of script) {
      timeoutIds.push(
        setTimeout(() => {
          setMessages(prev => [...prev, msg]);
          setOrbState(msg.sender === 'ai' ? 'speaking' : 'listening');
          if (msg.cefrLabel) setCurrentCefr(msg.cefrLabel);
        }, delay),
      );
      delay += msg.sender === 'ai' ? 3800 : 2800;
      timeoutIds.push(setTimeout(() => setOrbState('idle'), delay - 600));
    }

    timeoutIds.push(
      setTimeout(() => {
        const raw = localStorage.getItem('lingua_user');
        const user = raw ? JSON.parse(raw) : {};
        localStorage.setItem(
          'lingua_user',
          JSON.stringify({ ...user, cefrLevel: CEFR_RESULT, isNew: true }),
        );
        setLocation('/daily-goal');
      }, delay + 1500),
    );

    return () => timeoutIds.forEach(clearTimeout);
  }, [setLocation]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div className="flex-1 flex flex-col relative bg-background overflow-hidden">
      <button
        onClick={() => {
          const raw = localStorage.getItem('lingua_user');
          const user = raw ? JSON.parse(raw) : {};
          localStorage.setItem('lingua_user', JSON.stringify({ ...user, cefrLevel: 'A1', isNew: true }));
          setLocation('/daily-goal');
        }}
        className="absolute top-10 right-6 z-20 text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
        data-testid="btn-skip"
      >
        Skip →
      </button>

      <div className="shrink-0 flex flex-col items-center pt-12 pb-1 px-6 text-center z-10">
        <h1 className="font-serif text-2xl text-foreground mb-0.5">Evaluación de nivel</h1>
        <p className="text-muted-foreground text-sm mb-5">
          CEFR scale · mostly in Spanish · gets harder as you go
        </p>
        <div className="relative" style={{ width: 200, height: 200 }}>
          <Orb state={orbState} />
          <div
            className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-bold tracking-wider text-white"
            style={{
              background: 'linear-gradient(90deg, hsl(15 85% 52%), hsl(28 85% 56%))',
              boxShadow: '0 2px 8px hsl(15 85% 52% / 0.4)',
            }}
          >
            {currentCefr}
          </div>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
          style={{
            height: 72,
            background: 'linear-gradient(to bottom, hsl(var(--background)) 15%, transparent 100%)',
          }}
        />

        <div
          ref={scrollRef}
          className="h-full overflow-y-auto px-5 flex flex-col gap-3 pt-4 pb-24"
          style={{ scrollbarWidth: 'none' }}
        >
          <AnimatePresence>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.32 }}
                className={`max-w-[84%] rounded-2xl px-4 py-3 border text-[15px] leading-relaxed ${
                  msg.sender === 'ai'
                    ? 'bg-card text-muted-foreground self-start rounded-tl-sm border-border'
                    : 'self-end rounded-tr-sm border-primary/20'
                }`}
                style={
                  msg.sender === 'user'
                    ? { background: 'hsl(15 85% 52% / 0.10)', color: 'hsl(15 80% 75%)' }
                    : undefined
                }
              >
                {msg.text}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div
          className="absolute bottom-0 left-0 right-0 pb-7 flex flex-col items-center gap-2 pointer-events-none"
          style={{
            background: 'linear-gradient(to top, hsl(var(--background)) 50%, transparent 100%)',
            paddingTop: 36,
          }}
        >
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
          {orbState === 'speaking' && (
            <span className="text-xs font-semibold tracking-widest uppercase" style={{ color: 'hsl(15 85% 52%)' }}>
              Dara is speaking...
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

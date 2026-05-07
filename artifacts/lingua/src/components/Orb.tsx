import React from 'react';
import { cn } from '@/lib/utils';

interface OrbProps {
  state?: 'idle' | 'speaking' | 'listening';
  className?: string;
  onClick?: () => void;
}

export function Orb({ state = 'idle', className, onClick }: OrbProps) {
  return (
    <div
      className={cn('relative w-full h-full rounded-full cursor-pointer select-none', className)}
      onClick={onClick}
    >
      {/* Outer glow halo */}
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          inset: '-22%',
          background:
            'radial-gradient(circle, rgba(255,80,0,0.38) 0%, rgba(255,150,0,0.18) 45%, transparent 70%)',
          filter: 'blur(10px)',
          opacity: state === 'speaking' ? 1 : 0.62,
          transition: 'opacity 1.2s ease',
        }}
      />

      {/* Idle emission rings */}
      <div className="absolute inset-0 rounded-full orb-ring-1 pointer-events-none"
        style={{ border: '1.5px solid rgba(255,255,255,0.42)' }} />
      <div className="absolute inset-0 rounded-full orb-ring-2 pointer-events-none"
        style={{ border: '1.5px solid rgba(255,255,255,0.32)' }} />
      <div className="absolute inset-0 rounded-full orb-ring-3 pointer-events-none"
        style={{ border: '1px solid rgba(255,255,255,0.22)' }} />

      {state === 'speaking' && (
        <>
          <div className="absolute inset-0 rounded-full orb-speak-1 pointer-events-none"
            style={{ border: '2px solid rgba(255,150,30,0.65)' }} />
          <div className="absolute inset-0 rounded-full orb-speak-2 pointer-events-none"
            style={{ border: '1.5px solid rgba(255,210,60,0.48)' }} />
          <div className="absolute inset-0 rounded-full orb-speak-3 pointer-events-none"
            style={{ border: '1px solid rgba(255,230,100,0.32)' }} />
        </>
      )}

      {/* Core — warm orange-red base */}
      <div
        className="absolute inset-0 rounded-full overflow-hidden"
        style={{
          background:
            'radial-gradient(circle at 42% 38%, hsl(25 100% 62%) 0%, hsl(12 100% 54%) 55%, hsl(5 100% 50%) 100%)',
        }}
      >
        {/* Red blob — drifts around */}
        <div
          className="absolute orb-blob-1"
          style={{
            inset: '-35%',
            background:
              'radial-gradient(circle at 50% 50%, hsl(0 100% 58%) 0%, hsl(2 100% 52%) 35%, transparent 65%)',
            opacity: 0.80,
          }}
        />

        {/* Golden-yellow blob */}
        <div
          className="absolute orb-blob-2"
          style={{
            inset: '-35%',
            background:
              'radial-gradient(circle at 50% 50%, hsl(48 100% 70%) 0%, hsl(42 100% 60%) 30%, transparent 62%)',
            opacity: 0.72,
          }}
        />

        {/* Orange blob */}
        <div
          className="absolute orb-blob-3"
          style={{
            inset: '-35%',
            background:
              'radial-gradient(circle at 50% 50%, hsl(22 100% 65%) 0%, hsl(14 100% 55%) 32%, transparent 64%)',
            opacity: 0.60,
          }}
        />

        {/* Glass specular highlight */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 30% 22%, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.12) 30%, transparent 55%)',
          }}
        />

        {/* Warm inner rim */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            boxShadow:
              'inset 0 -4px 20px rgba(200,40,0,0.25), inset 0 4px 10px rgba(255,220,80,0.15)',
          }}
        />
      </div>
    </div>
  );
}

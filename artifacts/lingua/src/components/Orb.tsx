import React from 'react';
import { cn } from '@/lib/utils';

interface OrbProps {
  state?: 'idle' | 'speaking' | 'listening';
  className?: string;
  onClick?: () => void;
}

export function Orb({ state = 'idle', className, onClick }: OrbProps) {
  const speaking = state === 'speaking';

  /* Sonar ring color shifts orange → red → yellow to match the core */
  const sonarColors = [
    'rgba(255, 110, 20, VAL)',  // orange
    'rgba(220, 40,  10, VAL)',  // red
    'rgba(255, 185, 20, VAL)',  // yellow
  ];

  const makeSonar = (cls: string, color: string, delay: string) => (
    <div
      key={cls}
      className={`absolute inset-0 rounded-full pointer-events-none ${cls}`}
      style={{ border: `1.5px solid ${color}`, animationDelay: delay }}
    />
  );

  return (
    <div
      className={cn('relative w-full h-full rounded-full cursor-pointer select-none', className)}
      onClick={onClick}
    >
      {/* ── Shooting stars — occasional streaks around the orb ── */}
      <div className="absolute pointer-events-none" style={{ top: '50%', left: '50%', width: 0, height: 0, overflow: 'visible' }}>
        {([
          { cls: 'orb-star-1', color: 'rgba(255,248,190,0.94)' },
          { cls: 'orb-star-2', color: 'rgba(255,215,140,0.88)' },
          { cls: 'orb-star-3', color: 'rgba(255,240,170,0.86)' },
          { cls: 'orb-star-4', color: 'rgba(255,255,210,0.90)' },
        ] as const).map(({ cls, color }) => (
          <div
            key={cls}
            className={`absolute ${cls}`}
            style={{
              top: -1,
              left: 0,
              width: 54,
              height: 2,
              background: `linear-gradient(to right, transparent 0%, ${color} 100%)`,
              borderRadius: 2,
              filter: 'blur(0.7px)',
              transformOrigin: 'left center',
            }}
          />
        ))}
      </div>

      {/* ── Ambient glow halo ── */}
      <div
        className="absolute rounded-full pointer-events-none orb-hue-shift"
        style={{
          inset: '-30%',
          filter: 'blur(18px)',
          opacity: speaking ? 0.90 : 0.55,
          transition: 'opacity 1.2s ease',
        }}
      />

      {/* ── Sonar rings — idle (3 staggered pulses) ── */}
      {!speaking && (
        <>
          {makeSonar('orb-sonar-1', 'rgba(235, 90, 20, 0.38)', '0s')}
          {makeSonar('orb-sonar-2', 'rgba(200, 35,  8, 0.28)', '1.07s')}
          {makeSonar('orb-sonar-3', 'rgba(245,175, 15, 0.22)', '2.14s')}
        </>
      )}

      {/* ── Sonar rings — speaking (faster, brighter) ── */}
      {speaking && (
        <>
          {makeSonar('orb-sonar-speak-1', 'rgba(255,120, 20, 0.55)', '0s')}
          {makeSonar('orb-sonar-speak-2', 'rgba(220, 40, 10, 0.42)', '0.53s')}
          {makeSonar('orb-sonar-speak-3', 'rgba(255,200, 30, 0.30)', '1.06s')}
        </>
      )}

      {/* ── Fine emission rings (subtle close glow) ── */}
      <div className="absolute inset-0 rounded-full orb-ring-1 pointer-events-none"
        style={{ border: '1px solid rgba(255,140,30,0.35)' }} />
      <div className="absolute inset-0 rounded-full orb-ring-2 pointer-events-none"
        style={{ border: '1px solid rgba(200,30,10,0.28)' }} />
      <div className="absolute inset-0 rounded-full orb-ring-3 pointer-events-none"
        style={{ border: '1px solid rgba(255,200,40,0.20)' }} />

      {/* ── Speaking close rings ── */}
      {speaking && (
        <>
          <div className="absolute inset-0 rounded-full orb-speak-1 pointer-events-none"
            style={{ border: '2px solid rgba(255,140,30,0.65)' }} />
          <div className="absolute inset-0 rounded-full orb-speak-2 pointer-events-none"
            style={{ border: '1.5px solid rgba(220,40,10,0.48)' }} />
          <div className="absolute inset-0 rounded-full orb-speak-3 pointer-events-none"
            style={{ border: '1px solid rgba(255,210,50,0.35)' }} />
        </>
      )}

      {/* ── Core sphere ── */}
      <div
        className="absolute inset-0 rounded-full overflow-hidden"
        style={{
          background:
            'radial-gradient(circle at 42% 38%, hsl(25 100% 62%) 0%, hsl(12 100% 54%) 55%, hsl(5 100% 50%) 100%)',
        }}
      >
        {/* Hue-shift overlay — cycles orange/red/yellow */}
        <div className="absolute inset-0 rounded-full orb-hue-shift pointer-events-none" />

        {/* Red blob */}
        <div
          className="absolute orb-blob-1"
          style={{
            inset: '-35%',
            background:
              'radial-gradient(circle at 50% 50%, hsl(0 100% 58%) 0%, hsl(2 100% 52%) 35%, transparent 65%)',
            opacity: 0.82,
          }}
        />

        {/* Golden-yellow blob */}
        <div
          className="absolute orb-blob-2"
          style={{
            inset: '-35%',
            background:
              'radial-gradient(circle at 50% 50%, hsl(48 100% 68%) 0%, hsl(42 100% 58%) 30%, transparent 62%)',
            opacity: 0.74,
          }}
        />

        {/* Orange blob */}
        <div
          className="absolute orb-blob-3"
          style={{
            inset: '-35%',
            background:
              'radial-gradient(circle at 50% 50%, hsl(22 100% 63%) 0%, hsl(8 100% 52%) 32%, transparent 64%)',
            opacity: 0.62,
          }}
        />

        {/* Glass specular highlight */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 30% 22%, rgba(255,255,255,0.46) 0%, rgba(255,255,255,0.14) 30%, transparent 55%)',
          }}
        />

        {/* Warm inner rim shadow */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            boxShadow:
              'inset 0 -5px 22px rgba(180,30,0,0.30), inset 0 4px 12px rgba(255,210,70,0.18)',
          }}
        />
      </div>
    </div>
  );
}

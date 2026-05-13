import React from 'react';
import { cn } from '@/lib/utils';

interface WaveformProps {
  className?: string;
}

export function Waveform({ className }: WaveformProps) {
  const heights = [55, 85, 40, 95, 60, 75, 45];
  return (
    <div className={cn("flex items-center justify-center gap-1.5 h-8", className)}>
      {heights.map((h, i) => (
        <div
          key={i}
          className="w-1 rounded-full animate-pulse"
          style={{
            height: `${h}%`,
            background: 'linear-gradient(to top, hsl(15 85% 52%), hsl(38 90% 60%))',
            animationDelay: `${i * 0.12}s`,
            animationDuration: `${0.6 + (i % 3) * 0.2}s`,
            opacity: 0.85,
          }}
        />
      ))}
    </div>
  );
}

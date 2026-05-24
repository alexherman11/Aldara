/**
 * PlacementCalibrationBar — live debug indicator for the Placement screen.
 *
 * Renders the calibration controller's current target as a horizontal
 * Spanish→English bar with an animated dot at the live ratio, a tick at the
 * learner's self-marked starting ratio, a CEFR label, an 8-turn ratio
 * sparkline, and the latest learner snippet. All driven by snapshots received
 * over the LiveKit data channel under the `placement_calibration` topic.
 */

import { motion } from 'framer-motion';
import type { PlacementCalibrationSnapshot } from '@/lib/voice';

interface Props {
  /** Most recent snapshot, or null until the first calibration eval lands. */
  latest: PlacementCalibrationSnapshot | null;
  /** Full ordered history; we plot the trailing 8 in the sparkline. */
  history: PlacementCalibrationSnapshot[];
}

const SPARK_W = 80;
const SPARK_H = 24;
const SPARK_SAMPLES = 8;

export function PlacementCalibrationBar({ latest, history }: Props) {
  if (!latest) {
    return (
      <div className="text-xs text-muted-foreground/70 italic">
        Waiting for the first calibration eval…
      </div>
    );
  }

  const ratioPct = Math.round(latest.ratio * 100);
  const markedPct = Math.round(latest.markedRatio * 100);
  const confPct = Math.round(latest.confidence * 100);

  const series = history.slice(-SPARK_SAMPLES).map((s) => s.ratio);
  // Always anchor the sparkline to [0,1] so the y-axis is comparable across
  // sessions and the dot's vertical position has a stable meaning.
  const sparkPath = buildSparkline(series, SPARK_W, SPARK_H);

  return (
    <div
      className="flex flex-col gap-2 select-none"
      data-testid="placement-calibration-bar"
    >
      {/* CEFR + ratio + confidence label */}
      <div className="flex items-center justify-between text-[11px] font-mono">
        <div className="text-foreground/90 font-semibold tracking-wide">
          {latest.cefr}
          <span className="text-muted-foreground font-normal">
            {' · '}
            {ratioPct}% English
            {' · conf '}
            {latest.confidence.toFixed(2)}
            <span className="opacity-60"> ({confPct}%)</span>
          </span>
        </div>
        <div className="text-muted-foreground/60">
          turn {latest.turnIndex}
        </div>
      </div>

      {/* The bar itself */}
      <div className="relative">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">
          <span>Spanish</span>
          <span>English</span>
        </div>
        <div
          className="relative h-2 rounded-full overflow-visible"
          style={{
            background:
              'linear-gradient(to right, hsl(15 85% 52% / 0.18), hsl(220 70% 55% / 0.18))',
          }}
        >
          {/* Self-marked tick — where the learner said they were starting. */}
          <div
            className="absolute top-[-3px] h-[14px] w-[2px] rounded-full"
            style={{
              left: `calc(${markedPct}% - 1px)`,
              background: 'hsl(45 95% 50%)',
              boxShadow: '0 0 0 1px hsl(45 95% 50% / 0.25)',
            }}
            title={`Self-marked: ${markedPct}% English`}
          />
          {/* Animated live dot. */}
          <motion.div
            className="absolute top-[-4px] h-4 w-4 rounded-full"
            style={{
              background:
                'radial-gradient(circle at 30% 30%, hsl(15 95% 60%), hsl(15 85% 45%))',
              boxShadow: '0 2px 6px hsl(15 85% 45% / 0.45)',
            }}
            animate={{ left: `calc(${ratioPct}% - 8px)` }}
            transition={{ type: 'spring', stiffness: 180, damping: 22 }}
          />
        </div>
      </div>

      {/* Sparkline + snippet */}
      <div className="flex items-center justify-between gap-3 mt-1">
        <svg
          width={SPARK_W}
          height={SPARK_H}
          className="shrink-0"
          aria-label="recent ratio history"
        >
          {/* Subtle baseline so a flat line is still visible. */}
          <line
            x1={0}
            x2={SPARK_W}
            y1={SPARK_H - 0.5}
            y2={SPARK_H - 0.5}
            stroke="hsl(var(--border))"
            strokeWidth={1}
          />
          {series.length > 1 && (
            <path
              d={sparkPath}
              fill="none"
              stroke="hsl(15 85% 50%)"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {/* Mark the latest point with a small filled circle. */}
          {series.length > 0 && (
            <circle
              cx={
                series.length === 1
                  ? SPARK_W - 2
                  : SPARK_W - 2
              }
              cy={ratioToY(series[series.length - 1], SPARK_H)}
              r={2}
              fill="hsl(15 85% 50%)"
            />
          )}
        </svg>
        <div className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate">
          {latest.learnerSnippet ? (
            <span title={latest.learnerSnippet}>
              <span className="opacity-60">last:</span>{' '}
              <span className="italic">{latest.learnerSnippet}</span>
            </span>
          ) : (
            <span className="opacity-50">(no learner snippet yet)</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sparkline helpers ──────────────────────────────────────────────────

function ratioToY(ratio: number, h: number): number {
  // ratio 0 (all Spanish) → bottom; ratio 1 (all English) → top, with a 2px
  // inset so the line doesn't kiss the bounding box.
  const clamped = Math.max(0, Math.min(1, ratio));
  return h - 2 - clamped * (h - 4);
}

function buildSparkline(values: number[], w: number, h: number): string {
  if (values.length === 0) return '';
  if (values.length === 1) {
    const y = ratioToY(values[0], h);
    return `M 0 ${y} L ${w} ${y}`;
  }
  const step = w / (values.length - 1);
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${ratioToY(v, h).toFixed(2)}`)
    .join(' ');
}

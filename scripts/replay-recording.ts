import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { AzureAssessor } from '../src/pronunciation/azure-assessor.js';
import { SegmentedAssessor } from '../src/pronunciation/segmented-assessor.js';
import type { PronunciationAssessment } from '../src/pronunciation/types.js';
import type { SegmentedAssessmentResult } from '../src/pronunciation/segmented-scorer.js';

/**
 * Offline replay harness for tuning the pronunciation pipeline against real
 * recordings captured by RECORD_TURNS=1 in the live agent.
 *
 * Usage:
 *   # Replay a single turn:
 *   npx tsx scripts/replay-recording.ts recordings/<sessionId>/turn_001.wav
 *
 *   # Replay all turns in a session:
 *   npx tsx scripts/replay-recording.ts recordings/<sessionId>
 *
 *   # Replay every turn across all sessions:
 *   npx tsx scripts/replay-recording.ts recordings/
 *
 * For each turn, this script runs:
 *   1. The current Azure pronunciation pipeline (baseline)
 *   2. (Future) gpt-4o-transcribe → segmented Spanish-only Azure (Phase 13.3)
 *   3. Comparison: which pipeline catches more usable signal?
 *
 * Writes a side-by-side report to `replay-results-<timestamp>.json`.
 */

interface TurnFiles {
  wavPath: string;
  jsonPath: string;
}

function discover(target: string): TurnFiles[] {
  const turns: TurnFiles[] = [];
  if (!existsSync(target)) {
    throw new Error(`Path does not exist: ${target}`);
  }
  const stat = statSync(target);

  if (stat.isFile() && target.endsWith('.wav')) {
    const jsonPath = target.replace(/\.wav$/, '.json');
    turns.push({ wavPath: target, jsonPath });
    return turns;
  }

  if (stat.isDirectory()) {
    for (const entry of readdirSync(target)) {
      const full = join(target, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        turns.push(...discover(full));
      } else if (entry.endsWith('.wav')) {
        const jsonPath = full.replace(/\.wav$/, '.json');
        turns.push({ wavPath: full, jsonPath });
      }
    }
  }
  return turns;
}

interface ReplayRow {
  turn_path: string;
  duration_sec: number;
  reference_text: string;
  baseline: {
    recognized_text?: string;
    overall_accuracy: number;
    overall_pronunciation: number;
    flagged_words: Array<{ word: string; score: number }>;
    latency_ms: number;
    divergence: boolean;
  };
  segmented?: {
    overall_accuracy: number;
    overall_pronunciation: number;
    phrase_count: number;
    spanish_phrase_count: number;
    english_phrase_count: number;
    phrases: Array<{
      text: string;
      language: string;
      duration_sec: number;
      accuracy?: number;
    }>;
    stt_provider: string;
    stt_latency_ms: number;
    total_latency_ms: number;
  };
  saved_baseline?: {
    accuracy: number;
    pronunciation: number;
  };
  notes: string[];
}

async function runBaseline(
  assessor: AzureAssessor,
  wav: Buffer,
  referenceText: string,
  sampleRate: number,
): Promise<PronunciationAssessment> {
  return assessor.assess({
    audio: wav,
    reference_text: referenceText,
    sample_rate: sampleRate,
    language: 'es-MX',
  });
}

function normalize(s: string | undefined): string {
  return (s || '').replace(/[.,!?;:¿¡]/g, '').trim().toLowerCase();
}

async function main() {
  const target = process.argv[2] || 'recordings';
  console.log(`\nReplay harness — scanning: ${target}\n`);

  const turns = discover(target);
  if (turns.length === 0) {
    console.error('No .wav recordings found under', target);
    console.error('Tip: enable RECORD_TURNS=1 in .env and run a live session first.');
    process.exit(1);
  }
  console.log(`Found ${turns.length} turn recording(s)\n`);

  const assessor = new AzureAssessor();
  const segmented = new SegmentedAssessor();
  const skipSegmented = process.env.REPLAY_SKIP_SEGMENTED === '1';
  if (skipSegmented) {
    console.log('(REPLAY_SKIP_SEGMENTED=1 — running baseline only)\n');
  }
  const rows: ReplayRow[] = [];

  for (const t of turns) {
    const wav = readFileSync(t.wavPath);
    const meta = existsSync(t.jsonPath)
      ? (JSON.parse(readFileSync(t.jsonPath, 'utf8')) as Record<string, unknown>)
      : {};
    const referenceText = String(meta.reference_text ?? '(missing reference)');
    const sampleRate = Number(meta.sample_rate ?? 16000);
    const durationSec = Number(meta.duration_sec ?? wav.length / 2 / sampleRate);

    console.log(`── ${basename(t.wavPath)} (${durationSec.toFixed(2)}s) ──`);
    console.log(`   ref: "${referenceText.slice(0, 120)}${referenceText.length > 120 ? '...' : ''}"`);

    // Baseline: current Azure pipeline against the original reference text
    const baseline = await runBaseline(assessor, wav, referenceText, sampleRate);

    const flagged = baseline.words
      .filter((w) => w.accuracy_score < 70 || w.error_type !== 'None')
      .map((w) => ({ word: w.word, score: Math.round(w.accuracy_score) }));

    const divergence =
      normalize(baseline.recognized_text) !== normalize(referenceText);

    const savedBaseline = (meta.assessment as { overall?: { accuracy: number; pronunciation: number } } | undefined)
      ?.overall;

    const notes: string[] = [];
    if (savedBaseline) {
      const drift = baseline.overall.accuracy - savedBaseline.accuracy;
      if (Math.abs(drift) > 5) {
        notes.push(
          `score drift vs saved: ${drift > 0 ? '+' : ''}${drift.toFixed(1)} (env or model change?)`,
        );
      }
    }
    if (divergence) {
      notes.push('divergence — STT heard differently than reference');
    }
    if (baseline.overall.accuracy < 30) {
      notes.push('very low score — likely contamination by silence or wrong-language audio');
    }

    const row: ReplayRow = {
      turn_path: t.wavPath,
      duration_sec: durationSec,
      reference_text: referenceText,
      baseline: {
        recognized_text: baseline.recognized_text,
        overall_accuracy: baseline.overall.accuracy,
        overall_pronunciation: baseline.overall.pronunciation,
        flagged_words: flagged.slice(0, 10),
        latency_ms: baseline.latency_ms,
        divergence,
      },
      saved_baseline: savedBaseline,
      notes,
    };

    console.log(
      `   baseline:   acc=${baseline.overall.accuracy.toFixed(0)} pron=${baseline.overall.pronunciation.toFixed(0)} ` +
        `div=${divergence ? 'Y' : 'N'} flagged=${flagged.length} lat=${baseline.latency_ms}ms`,
    );

    // Run the segmented pipeline on the same audio. Catches its own errors
    // so a single problematic turn doesn't abort the whole replay.
    if (!skipSegmented) {
      const segStart = Date.now();
      try {
        const segResult = (await segmented.assess({
          audio: wav,
          reference_text: referenceText,
          sample_rate: sampleRate,
          language: 'es-MX',
        })) as SegmentedAssessmentResult;
        const totalMs = Date.now() - segStart;
        const phrases = segResult.phrases ?? [];
        row.segmented = {
          overall_accuracy: segResult.overall.accuracy,
          overall_pronunciation: segResult.overall.pronunciation,
          phrase_count: phrases.length,
          spanish_phrase_count: phrases.filter((p) => p.language === 'es').length,
          english_phrase_count: phrases.filter((p) => p.language === 'en').length,
          phrases: phrases.map((p) => ({
            text: p.text,
            language: p.language,
            duration_sec: Number((p.end_sec - p.start_sec).toFixed(2)),
            accuracy: p.assessment?.accuracy,
          })),
          stt_provider: segResult.stt.provider,
          stt_latency_ms: segResult.stt.latency_ms,
          total_latency_ms: totalMs,
        };
        const delta = segResult.overall.accuracy - baseline.overall.accuracy;
        const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(1);
        console.log(
          `   segmented:  acc=${segResult.overall.accuracy.toFixed(0)} pron=${segResult.overall.pronunciation.toFixed(0)} ` +
            `phrases=${phrases.length} (es=${row.segmented.spanish_phrase_count}/en=${row.segmented.english_phrase_count}) ` +
            `lat=${totalMs}ms  Δ${deltaStr}`,
        );
        for (const p of phrases) {
          const score = p.assessment ? p.assessment.accuracy.toFixed(0) : '—';
          console.log(`     [${p.language}] ${(p.end_sec - p.start_sec).toFixed(2)}s acc=${score.padStart(3)}  "${p.text.slice(0, 80)}"`);
        }
      } catch (err) {
        row.notes.push(`segmented pipeline error: ${String(err).slice(0, 100)}`);
        console.log(`   segmented:  ERROR — ${String(err).slice(0, 120)}`);
      }
    }

    rows.push(row);
    if (notes.length) {
      console.log(`   notes: ${notes.join(' | ')}`);
    }
    console.log();
  }

  // Aggregate summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Replay summary');
  console.log('═══════════════════════════════════════════════════════════');
  const accs = rows.map((r) => r.baseline.overall_accuracy);
  const avg = accs.reduce((a, b) => a + b, 0) / accs.length;
  const min = Math.min(...accs);
  const max = Math.max(...accs);
  const flaggedCount = rows.reduce((a, r) => a + r.baseline.flagged_words.length, 0);
  const divergenceCount = rows.filter((r) => r.baseline.divergence).length;
  const lowScoreCount = rows.filter((r) => r.baseline.overall_accuracy < 30).length;

  console.log(`\n  BASELINE (monolithic Azure on full transcript)`);
  console.log(`    Turns replayed:           ${rows.length}`);
  console.log(`    Avg accuracy:             ${avg.toFixed(1)}`);
  console.log(`    Range:                    [${min.toFixed(0)}, ${max.toFixed(0)}]`);
  console.log(`    Turns with divergence:    ${divergenceCount}/${rows.length}`);
  console.log(`    Turns scoring <30 (bad):  ${lowScoreCount}/${rows.length}`);
  console.log(`    Total flagged words:      ${flaggedCount}`);

  // Segmented pipeline aggregate — only over rows where it ran
  const segRows = rows.filter((r) => r.segmented);
  if (segRows.length > 0) {
    const segAccs = segRows.map((r) => r.segmented!.overall_accuracy);
    const segAvg = segAccs.reduce((a, b) => a + b, 0) / segAccs.length;
    const segMin = Math.min(...segAccs);
    const segMax = Math.max(...segAccs);
    const segLowScore = segRows.filter((r) => r.segmented!.overall_accuracy < 30).length;
    const totalSpanishPhrases = segRows.reduce((s, r) => s + r.segmented!.spanish_phrase_count, 0);
    const totalEnglishPhrases = segRows.reduce((s, r) => s + r.segmented!.english_phrase_count, 0);

    // Delta analysis: how many turns improved, stayed similar, regressed?
    let improved = 0;
    let similar = 0;
    let regressed = 0;
    let totalDelta = 0;
    for (const r of segRows) {
      const delta = r.segmented!.overall_accuracy - r.baseline.overall_accuracy;
      totalDelta += delta;
      if (delta > 5) improved++;
      else if (delta < -5) regressed++;
      else similar++;
    }

    console.log(`\n  SEGMENTED (Deepgram + per-phrase Azure)`);
    console.log(`    Avg accuracy:             ${segAvg.toFixed(1)}`);
    console.log(`    Range:                    [${segMin.toFixed(0)}, ${segMax.toFixed(0)}]`);
    console.log(`    Turns scoring <30 (bad):  ${segLowScore}/${segRows.length}`);
    console.log(`    Spanish phrases scored:   ${totalSpanishPhrases}`);
    console.log(`    English phrases skipped:  ${totalEnglishPhrases}`);
    console.log(`\n  COMPARISON`);
    console.log(`    Avg delta (seg - base):   ${totalDelta / segRows.length >= 0 ? '+' : ''}${(totalDelta / segRows.length).toFixed(1)}`);
    console.log(`    Improved (>+5 points):    ${improved}/${segRows.length}`);
    console.log(`    Similar (±5 points):      ${similar}/${segRows.length}`);
    console.log(`    Regressed (<-5 points):   ${regressed}/${segRows.length}`);
  }

  const outPath = `replay-results-${Date.now()}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        rows,
        summary: {
          baseline: { avg, min, max, divergenceCount, lowScoreCount },
          segmented: segRows.length > 0
            ? {
                count: segRows.length,
                avg: segRows.reduce((s, r) => s + r.segmented!.overall_accuracy, 0) / segRows.length,
              }
            : null,
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n  Full results: ${outPath}`);
}

main().catch((err) => {
  console.error('Replay failed:', err);
  process.exit(1);
});

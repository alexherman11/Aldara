/**
 * Layer 1 unit test runner — no network, no DB, no Anthropic.
 *
 * Each entry is the path to a test file that exits 0 on success and 1 on
 * failure, prints its own per-assertion output, and ends with a single
 * RESULT line. This runner aggregates them and fails fast on the first
 * failing suite so CI shows the exact suite that broke.
 *
 * To add a suite here it must be fully offline. Anything that hits the
 * Anthropic / OpenAI / Deepgram / Azure / Cartesia / Postgres APIs belongs
 * in Layer 2 and runs via its own command.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const SUITES = [
  'scripts/test-segmenter.ts',
  'scripts/test-segmented-sample-rate.ts',
  'scripts/test-prompt-builder.ts',
  'scripts/test-difficulty-math.ts',
  'scripts/test-calibration-math.ts',
  'scripts/test-annotation-render.ts',
  'scripts/test-wav-roundtrip.ts',
  'scripts/test-learner-eou.ts',
];

let failedSuite: string | null = null;
const startedAt = Date.now();

for (const suite of SUITES) {
  console.log(`\n══════ ${suite} ══════`);
  const result = spawnSync(
    'npx',
    ['tsx', join(repoRoot, suite)],
    { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.status !== 0) {
    failedSuite = suite;
    break;
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
console.log('\n════════════════════════════════════════════════');
if (failedSuite) {
  console.log(`FAILED in ${relative(repoRoot, failedSuite)} (${elapsed}s)`);
  console.log('════════════════════════════════════════════════');
  process.exit(1);
} else {
  console.log(`All ${SUITES.length} Layer 1 suites passed (${elapsed}s)`);
  console.log('════════════════════════════════════════════════');
}

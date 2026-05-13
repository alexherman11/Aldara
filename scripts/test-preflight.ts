import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Client } from 'pg';

/**
 * Pre-flight checks before bringing up the full stack.
 * Verifies each external dependency is reachable and configured.
 */

let passed = 0;
let failed = 0;

function pass(label: string, info?: string) {
  console.log(`  PASS  ${label}${info ? ` — ${info}` : ''}`);
  passed++;
}
function fail(label: string, info?: string) {
  console.log(`  FAIL  ${label}${info ? ` — ${info}` : ''}`);
  failed++;
}

async function checkEnv() {
  console.log('── 1. Environment variables ──');
  const required = [
    'DATABASE_URL',
    'LEARNER_ID',
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'DEEPGRAM_API_KEY',
    'ANTHROPIC_API_KEY',
    'CARTESIA_API_KEY',
    'OPENAI_API_KEY',
    'PRONUNCIATION_PROVIDER',
    'AZURE_SPEECH_KEY',
    'AZURE_SPEECH_REGION',
  ];
  for (const k of required) {
    const v = process.env[k] || '';
    if (v.length === 0) fail(`${k} is set`, 'value is empty');
    else pass(`${k} is set`, `len=${v.length}`);
  }
}

async function checkPostgres() {
  console.log('\n── 2. Postgres ──');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    pass('Postgres connection');

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    const required = ['learners', 'sessions', 'fsrs_cards'];
    for (const t of required) {
      if (names.includes(t)) pass(`Table ${t} exists`);
      else fail(`Table ${t} exists`, `tables: ${names.join(', ') || '(none)'}`);
    }

    const learner = await client.query<{ count: string }>(
      `SELECT count(*) FROM learners WHERE id = $1`,
      [process.env.LEARNER_ID],
    );
    const n = Number(learner.rows[0]?.count || 0);
    if (n > 0) pass('Learner row exists', `learner_id=${process.env.LEARNER_ID}`);
    else
      pass(
        'Learner row will be auto-created on first agent connect',
        'getOrCreateLearner seeds a fresh row',
      );
  } catch (err) {
    fail('Postgres connection', String(err).slice(0, 200));
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkLiveKit() {
  console.log('\n── 3. LiveKit reachability ──');
  const url = process.env.LIVEKIT_URL || '';
  if (!url) {
    fail('LIVEKIT_URL', 'not set');
    return;
  }
  // Convert wss:// to https:// for healthz/whip endpoint check
  const httpsUrl = url.replace(/^wss?:\/\//, 'https://');
  const probe = httpsUrl.replace(/\/$/, '') + '/';
  try {
    const startedAt = Date.now();
    const resp = await fetch(probe, { method: 'GET' });
    const ms = Date.now() - startedAt;
    // LiveKit cloud returns 200 with a small JSON or HTML page on the root.
    // Anything that isn't a network error means the host is reachable.
    pass(
      'LiveKit host reachable',
      `${probe} → HTTP ${resp.status} (${ms}ms)`,
    );
  } catch (err) {
    fail('LiveKit host reachable', String(err).slice(0, 200));
  }
}

async function checkAzure() {
  console.log('\n── 4. Azure Speech token endpoint ──');
  const key = process.env.AZURE_SPEECH_KEY || '';
  const region = process.env.AZURE_SPEECH_REGION || '';
  if (!key || !region) {
    fail('Azure credentials', 'key or region missing');
    return;
  }
  const url = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  try {
    const startedAt = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
    });
    const ms = Date.now() - startedAt;
    if (resp.status === 200) {
      const body = await resp.text();
      pass(
        'Azure token issued',
        `region=${region} JWT-shape=${body.split('.').length === 3} (${ms}ms)`,
      );
    } else {
      fail('Azure token issued', `HTTP ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    fail('Azure token issued', String(err).slice(0, 200));
  }
}

async function main() {
  console.log('Pre-flight checks for Lingua/Habla stack\n');
  await checkEnv();
  await checkPostgres();
  await checkLiveKit();
  await checkAzure();

  console.log('\n════════════════════════════════════════════════');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Pre-flight fatal:', err);
  process.exit(1);
});

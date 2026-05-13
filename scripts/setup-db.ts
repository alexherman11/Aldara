/**
 * One-shot DB setup: ensures the `habla` database exists and applies the
 * canonical schema from src/db/schema.sql.
 *
 * Idempotent — re-running is safe. CREATE DATABASE is a no-op if it already
 * exists; CREATE TABLE uses IF NOT EXISTS semantics via the schema file's
 * "applied to the habla database" comment (and we re-run the file each time
 * to catch any drift).
 *
 * Usage: npx tsx scripts/setup-db.ts
 */

import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.replace(/^\//, '');
  const adminUrl = new URL(process.env.DATABASE_URL!);
  adminUrl.pathname = '/postgres'; // connect to default db to create the new one

  console.log(`Ensuring database "${dbName}" exists…`);
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  );
  if (exists.rows.length === 0) {
    // CREATE DATABASE doesn't allow placeholders — name is identifier, not value.
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
    console.log(`  created database "${dbName}"`);
  } else {
    console.log(`  database "${dbName}" already exists`);
  }
  await admin.end();

  console.log('\nApplying schema…');
  const schemaPath = join(__dirname, '..', 'src', 'db', 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');

  // The schema as shipped uses CREATE TABLE without IF NOT EXISTS, which is
  // fine for a brand-new database. If the tables already exist we'll just
  // log and skip — safer than tearing them down.
  const targetUrl = new URL(process.env.DATABASE_URL!);
  const target = new Client({ connectionString: targetUrl.toString() });
  await target.connect();

  // Schema is idempotent (CREATE TABLE IF NOT EXISTS + ALTER ... ADD COLUMN
  // IF NOT EXISTS) — always re-run so newly-added columns get picked up on
  // existing databases.
  await target.query(schemaSql);
  console.log('  schema applied (idempotent)');

  // Verify
  const verify = await target.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' ORDER BY table_name`,
  );
  console.log(`\nTables in habla: ${verify.rows.map((r) => r.table_name).join(', ')}`);
  await target.end();

  console.log('\n✓ DB setup complete.');
}

main().catch((err) => {
  console.error('DB setup failed:', err);
  process.exit(1);
});

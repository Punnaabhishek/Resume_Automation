/**
 * Minimal forward-only migration runner. Each .sql file in db/migrations runs once, in
 * filename order, inside its own transaction, and is recorded in schema_migrations.
 *
 *   npm run migrate         apply pending migrations
 *   npm run migrate:status  list applied/pending
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPool, closePool, type RowDataPacket } from './pool';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

interface MigrationRow extends RowDataPacket {
  name: string;
  checksum: string;
  applied_at: Date;
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum   CHAR(64)     NOT NULL,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function readMigrations(): { name: string; sql: string; checksum: string }[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Split on semicolons that end a statement. Good enough for our DDL, which has no stored
 * procedures or semicolons inside string literals.
 */
function splitStatements(sql: string): string[] {
  const withoutComments = sql.replace(/^\s*--[^\n]*$/gm, '');
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applied(): Promise<Map<string, MigrationRow>> {
  const [rows] = await getPool().query<MigrationRow[]>('SELECT * FROM schema_migrations');
  return new Map(rows.map((r) => [r.name, r]));
}

async function up(): Promise<void> {
  await ensureMigrationsTable();
  const done = await applied();
  const all = readMigrations();
  const pending = all.filter((m) => !done.has(m.name));

  for (const m of all) {
    const prior = done.get(m.name);
    if (prior && prior.checksum !== m.checksum) {
      throw new Error(
        `Migration ${m.name} changed after it was applied (checksum mismatch). ` +
          `Forward-only: add a new migration instead of editing this one.`,
      );
    }
  }

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  for (const m of pending) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      for (const statement of splitStatements(m.sql)) {
        await conn.query(statement);
      }
      await conn.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [m.name, m.checksum]);
      await conn.commit();
      console.log(`Applied ${m.name}`);
    } catch (err) {
      await conn.rollback();
      console.error(`Failed ${m.name}:`, err instanceof Error ? err.message : err);
      throw err;
    } finally {
      conn.release();
    }
  }
}

async function status(): Promise<void> {
  await ensureMigrationsTable();
  const done = await applied();
  for (const m of readMigrations()) {
    const row = done.get(m.name);
    console.log(`${row ? 'applied ' : 'pending '} ${m.name}${row ? `  (${row.applied_at.toISOString()})` : ''}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (command === 'up') await up();
  else if (command === 'status') await status();
  else throw new Error(`Unknown command: ${command}. Use "up" or "status".`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });

import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
  type ResultSetHeader,
  type FieldPacket,
} from 'mysql2/promise';
import { env } from '../config/env';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      connectionLimit: env.db.connectionLimit,
      waitForConnections: true,
      namedPlaceholders: false,
      dateStrings: false,
      timezone: 'Z',
      supportBigNumbers: true,
      decimalNumbers: true,
    });
  }
  return pool;
}

/**
 * Parameters accepted by the query helpers. mysql2's own `ExecuteValues` type rejects
 * `unknown`, which every dynamically-built parameter list in this codebase is. The driver
 * serializes them fine, so the cast is confined here rather than repeated at each call site.
 */
export type SqlParams = readonly unknown[];

const values = (params: SqlParams): any[] => params as any[];

/** SELECT returning many rows. */
export async function query<T extends RowDataPacket>(sql: string, params: SqlParams = []): Promise<T[]> {
  const [rows] = await getPool().query<T[]>(sql, values(params));
  return rows;
}

/** SELECT returning one row or null. */
export async function queryOne<T extends RowDataPacket>(sql: string, params: SqlParams = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** INSERT/UPDATE/DELETE. */
export async function execute(sql: string, params: SqlParams = []): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, values(params));
  return result;
}

/**
 * A transaction handle. Mirrors the driver's `query`/`execute` but accepts `SqlParams`, so
 * transactional code reads the same as the non-transactional helpers above. `raw` is the
 * underlying connection for the rare case something needs it.
 */
export interface Tx {
  query<T extends RowDataPacket[]>(sql: string, params?: SqlParams): Promise<[T, FieldPacket[]]>;
  execute<T extends ResultSetHeader = ResultSetHeader>(sql: string, params?: SqlParams): Promise<[T, FieldPacket[]]>;
  raw: PoolConnection;
}

function wrap(conn: PoolConnection): Tx {
  return {
    query: <T extends RowDataPacket[]>(sql: string, params: SqlParams = []) =>
      conn.query<T>(sql, values(params)) as Promise<[T, FieldPacket[]]>,
    execute: <T extends ResultSetHeader = ResultSetHeader>(sql: string, params: SqlParams = []) =>
      conn.execute<T>(sql, values(params)) as Promise<[T, FieldPacket[]]>,
    raw: conn,
  };
}

/**
 * Run `fn` inside a transaction, rolling back on any throw. Used wherever a write touches
 * more than one table — creating a portal connection also writes a credential and an audit
 * row, and a half-applied version of that is worse than a failure.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(wrap(conn));
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type { PoolConnection, RowDataPacket, ResultSetHeader, FieldPacket };

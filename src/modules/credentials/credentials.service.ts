/**
 * The only path in and out of the credential vault.
 *
 * Rules this module enforces, so nothing else has to remember them:
 *   - Storing a secret always goes through `seal` — nothing writes to `credentials` directly.
 *   - Reading a secret always writes a credential_access_log row, in the same transaction,
 *     so an unlogged decrypt is not a thing a caller can accidentally do.
 *   - `reveal` is not reachable from any ops-dashboard route. Only the worker calls it, at
 *     the moment of login, and only for the connection it has an active run for.
 */
import type { RowDataPacket, Tx } from '../../db/pool';
import { execute, getPool, queryOne, withTransaction } from '../../db/pool';
import { newId } from '../../lib/ids';
import { notFound } from '../../lib/errors';
import { open, seal } from '../../services/vault';

export type CredentialScope = 'portal' | 'proxy';

interface CredentialRow extends RowDataPacket {
  id: string;
  org_id: string;
  scope: CredentialScope;
  identifier: string;
  wrapped_dek: Buffer;
  dek_iv: Buffer;
  dek_tag: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
}

export interface AccessContext {
  actorType: 'worker' | 'org_member' | 'system';
  actorId?: string | null;
  runId?: string | null;
  reason?: string | null;
  ip?: string | null;
}

async function logAccess(
  conn: Tx | null,
  credentialId: string,
  action: 'decrypt' | 'create' | 'rotate' | 'delete',
  ctx: AccessContext,
): Promise<void> {
  const sql = `
    INSERT INTO credential_access_log (credential_id, actor_type, actor_id, action, run_id, reason, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    credentialId,
    ctx.actorType,
    ctx.actorId ?? null,
    action,
    ctx.runId ?? null,
    ctx.reason ?? null,
    ctx.ip ?? null,
  ];
  if (conn) await conn.execute(sql, params);
  else await execute(sql, params);
}

/** Store a new secret. Returns only the id — the plaintext is not retained anywhere. */
export async function store(
  orgId: string,
  scope: CredentialScope,
  identifier: string,
  secret: string,
  ctx: AccessContext,
  conn?: Tx,
): Promise<string> {
  const sealed = seal(secret);
  const id = newId();

  const sql = `
    INSERT INTO credentials
      (id, org_id, scope, identifier, wrapped_dek, dek_iv, dek_tag, ciphertext, iv, auth_tag, key_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    id, orgId, scope, identifier,
    sealed.wrappedDek, sealed.dekIv, sealed.dekTag,
    sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion,
  ];

  if (conn) {
    await conn.execute(sql, params);
    await logAccess(conn, id, 'create', ctx);
  } else {
    await withTransaction(async (tx) => {
      await tx.execute(sql, params);
      await logAccess(tx, id, 'create', ctx);
    });
  }

  return id;
}

/** Replace the secret behind an existing credential id, keeping references intact. */
export async function rotate(
  credentialId: string,
  identifier: string,
  secret: string,
  ctx: AccessContext,
): Promise<void> {
  const existing = await queryOne<CredentialRow>('SELECT id FROM credentials WHERE id = ?', [credentialId]);
  if (!existing) throw notFound('Credential');

  const sealed = seal(secret);
  await withTransaction(async (tx) => {
    await tx.execute(
      `UPDATE credentials
         SET identifier = ?, wrapped_dek = ?, dek_iv = ?, dek_tag = ?,
             ciphertext = ?, iv = ?, auth_tag = ?, key_version = ?, rotated_at = NOW(3)
       WHERE id = ?`,
      [
        identifier, sealed.wrappedDek, sealed.dekIv, sealed.dekTag,
        sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, credentialId,
      ],
    );
    await logAccess(tx, credentialId, 'rotate', ctx);
  });
}

/**
 * Decrypt. Called only by the worker, at point of use. The access log row is written in the
 * same transaction as the read, so a decrypt that is not logged cannot happen.
 */
export async function reveal(
  credentialId: string,
  ctx: AccessContext,
): Promise<{ identifier: string; secret: string }> {
  return withTransaction(async (tx) => {
    const [rows] = await tx.query<CredentialRow[]>('SELECT * FROM credentials WHERE id = ?', [credentialId]);
    const row = rows[0];
    if (!row) throw notFound('Credential');

    await logAccess(tx, credentialId, 'decrypt', ctx);

    const secret = open({
      wrappedDek: row.wrapped_dek,
      dekIv: row.dek_iv,
      dekTag: row.dek_tag,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
    });

    return { identifier: row.identifier, secret };
  });
}

export async function remove(credentialId: string, ctx: AccessContext): Promise<void> {
  await withTransaction(async (tx) => {
    await logAccess(tx, credentialId, 'delete', ctx);
    await tx.execute('DELETE FROM credentials WHERE id = ?', [credentialId]);
  });
}

/** Access history for one credential — what ops sees instead of the secret itself. */
export async function accessHistory(credentialId: string, limit = 100) {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT actor_type, actor_id, action, run_id, reason, ip, created_at
       FROM credential_access_log
      WHERE credential_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [credentialId, limit],
  );
  return rows;
}

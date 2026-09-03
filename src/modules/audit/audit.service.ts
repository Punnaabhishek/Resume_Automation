import type { Tx } from '../../db/pool';
import { execute } from '../../db/pool';

export interface AuditEntry {
  orgId?: string | null;
  userId?: string | null;
  actorType: 'org_member' | 'worker' | 'system';
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

const SQL = `
  INSERT INTO audit_log
    (org_id, user_id, actor_type, actor_id, action, entity_type, entity_id, metadata, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function params(entry: AuditEntry): unknown[] {
  return [
    entry.orgId ?? null,
    entry.userId ?? null,
    entry.actorType,
    entry.actorId ?? null,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.ip ?? null,
    entry.userAgent?.slice(0, 400) ?? null,
  ];
}

export async function record(entry: AuditEntry): Promise<void> {
  await execute(SQL, params(entry));
}

/** Same write, joined to a caller's transaction so the log commits with the change. */
export async function recordIn(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.execute(SQL, params(entry));
}

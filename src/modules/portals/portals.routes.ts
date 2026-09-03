/**
 * Portal connections: the record that a given user's LinkedIn/Indeed/Dice account is
 * provisioned for automation.
 *
 * Note what these routes do NOT do: there is no endpoint that returns a portal password.
 * The password goes in via POST/PUT, straight into the vault, and comes back out only
 * inside the worker's `/worker/runs/:id/credential` call, which logs the access.
 */
import { Router } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { badRequest, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import { env } from '../../config/env';
import * as audit from '../audit/audit.service';
import * as credentials from '../credentials/credentials.service';

const PORTALS = ['linkedin', 'indeed', 'dice'] as const;

interface ConnectionRow extends RowDataPacket {
  id: string;
  user_id: string;
  portal: (typeof PORTALS)[number];
  credential_id: string | null;
  proxy_id: string | null;
  session_state_path: string | null;
  session_updated_at: Date | null;
  connection_status: string;
  status_reason: string | null;
  consecutive_failures: number;
  last_login_at: Date | null;
  last_synced_at: Date | null;
}

const connectSchema = z.object({
  portal: z.enum(PORTALS),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(500),
  proxyId: z.string().uuid().optional(),
});

async function assertUserInOrg(userId: string, orgId: string): Promise<{ id: string; country: string; state: string | null }> {
  const user = await queryOne<RowDataPacket & { id: string; country: string; state: string | null }>(
    'SELECT id, country, state FROM users WHERE id = ? AND org_id = ?',
    [userId, orgId],
  );
  if (!user) throw notFound('User');
  return user;
}

/**
 * Pick a proxy in the user's own country (and region, if one is free there) that still has
 * assignment capacity. Regional match is about the account logging in from where it
 * normally does; capacity is about not stacking many accounts behind one address.
 */
async function autoAssignProxy(orgId: string, country: string, region: string | null): Promise<string | null> {
  const rows = await query<RowDataPacket & { id: string }>(
    `SELECT p.id
       FROM proxies p
       LEFT JOIN portal_connections pc ON pc.proxy_id = p.id
      WHERE p.org_id = ? AND p.country = ? AND p.status = 'available'
      GROUP BY p.id, p.region, p.max_assignments
     HAVING COUNT(pc.id) < p.max_assignments
      ORDER BY (p.region <=> ?) DESC, COUNT(pc.id) ASC
      LIMIT 1`,
    [orgId, country, region],
  );
  return rows[0]?.id ?? null;
}

function present(row: ConnectionRow) {
  return {
    id: row.id,
    userId: row.user_id,
    portal: row.portal,
    hasCredential: row.credential_id !== null,
    proxyId: row.proxy_id,
    hasPersistedSession: row.session_state_path !== null,
    sessionUpdatedAt: row.session_updated_at,
    status: row.connection_status,
    statusReason: row.status_reason,
    consecutiveFailures: row.consecutive_failures,
    lastLoginAt: row.last_login_at,
    lastSyncedAt: row.last_synced_at,
  };
}

export const portalsRouter = Router();
portalsRouter.use(requireMember);

portalsRouter.get(
  '/users/:userId/connections',
  asyncHandler(async (req, res) => {
    await assertUserInOrg(param(req, 'userId'), req.member!.orgId);
    const rows = await query<ConnectionRow>('SELECT * FROM portal_connections WHERE user_id = ?', [param(req, 'userId')]);
    res.json({ data: rows.map(present) });
  }),
);

portalsRouter.post(
  '/users/:userId/connections',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const input = parse(connectSchema, req.body);
    const orgId = req.member!.orgId;
    const user = await assertUserInOrg(param(req, 'userId'), orgId);

    // Storing someone's portal password is only allowed once they have explicitly
    // authorized it. This is checked here rather than trusted to the caller.
    const consent = await queryOne<RowDataPacket>(
      `SELECT id FROM consents
        WHERE user_id = ? AND consent_type = 'credential_storage' AND revoked_at IS NULL
        LIMIT 1`,
      [user.id],
    );
    if (!consent) {
      throw badRequest(
        'This user has no active credential_storage consent on file. Record the signed ' +
          'authorization before storing portal credentials.',
      );
    }

    const proxyId = input.proxyId ?? (await autoAssignProxy(orgId, user.country, user.state));

    const connectionId = await withTransaction(async (tx) => {
      const [existingRows] = await tx.query<ConnectionRow[]>(
        'SELECT * FROM portal_connections WHERE user_id = ? AND portal = ? FOR UPDATE',
        [user.id, input.portal],
      );
      const existing = existingRows[0];

      const ctx = {
        actorType: 'org_member' as const,
        actorId: req.member!.sub,
        reason: `provision ${input.portal} connection`,
        ip: clientIp(req),
      };

      if (existing?.credential_id) {
        await credentials.rotate(existing.credential_id, input.username, input.password, ctx);
        await tx.execute(
          `UPDATE portal_connections
              SET proxy_id = ?, connection_status = 'pending', status_reason = NULL,
                  consecutive_failures = 0
            WHERE id = ?`,
          [proxyId, existing.id],
        );
        return existing.id;
      }

      const credentialId = await credentials.store(orgId, 'portal', input.username, input.password, ctx, tx);
      const id = existing?.id ?? newId();
      const sessionPath = path.join(env.storage.sessions, user.id, `${input.portal}.json`);

      if (existing) {
        await tx.execute(
          `UPDATE portal_connections
              SET credential_id = ?, proxy_id = ?, session_state_path = ?,
                  connection_status = 'pending', status_reason = NULL, consecutive_failures = 0
            WHERE id = ?`,
          [credentialId, proxyId, sessionPath, id],
        );
      } else {
        await tx.execute(
          `INSERT INTO portal_connections
             (id, user_id, portal, credential_id, proxy_id, session_state_path, connection_status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
          [id, user.id, input.portal, credentialId, proxyId, sessionPath],
        );
      }

      await audit.recordIn(tx, {
        orgId,
        userId: user.id,
        actorType: 'org_member',
        actorId: req.member!.sub,
        action: 'connection.provision',
        entityType: 'portal_connection',
        entityId: id,
        // Deliberately records the portal and username, never the secret.
        metadata: { portal: input.portal, username: input.username, proxyAssigned: proxyId !== null },
        ip: clientIp(req),
      });

      return id;
    });

    const row = await queryOne<ConnectionRow>('SELECT * FROM portal_connections WHERE id = ?', [connectionId]);
    res.status(201).json(present(row!));
  }),
);

portalsRouter.patch(
  '/connections/:id',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      proxyId: z.string().uuid().nullable().optional(),
      status: z.enum(['pending', 'connected', 'needs_attention', 'locked', 'disconnected']).optional(),
      statusReason: z.string().max(255).nullable().optional(),
    });
    const input = parse(schema, req.body);

    const row = await queryOne<ConnectionRow>(
      `SELECT pc.* FROM portal_connections pc JOIN users u ON u.id = pc.user_id
        WHERE pc.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Connection');

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.proxyId !== undefined) {
      sets.push('proxy_id = ?');
      params.push(input.proxyId);
    }
    if (input.status !== undefined) {
      sets.push('connection_status = ?');
      params.push(input.status);
      if (input.status === 'connected') sets.push('consecutive_failures = 0');
    }
    if (input.statusReason !== undefined) {
      sets.push('status_reason = ?');
      params.push(input.statusReason);
    }
    if (sets.length === 0) throw badRequest('No changes supplied');

    await execute(`UPDATE portal_connections SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);
    await audit.record({
      orgId: req.member!.orgId,
      userId: row.user_id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'connection.update',
      entityType: 'portal_connection',
      entityId: row.id,
      metadata: input as Record<string, unknown>,
      ip: clientIp(req),
    });

    const updated = await queryOne<ConnectionRow>('SELECT * FROM portal_connections WHERE id = ?', [row.id]);
    res.json(present(updated!));
  }),
);

/** Credential access history — what ops can see about a stored password, instead of it. */
portalsRouter.get(
  '/connections/:id/credential-access',
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await queryOne<ConnectionRow>(
      `SELECT pc.* FROM portal_connections pc JOIN users u ON u.id = pc.user_id
        WHERE pc.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Connection');
    if (!row.credential_id) {
      res.json({ data: [] });
      return;
    }
    res.json({ data: await credentials.accessHistory(row.credential_id) });
  }),
);

portalsRouter.delete(
  '/connections/:id',
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await queryOne<ConnectionRow>(
      `SELECT pc.* FROM portal_connections pc JOIN users u ON u.id = pc.user_id
        WHERE pc.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Connection');

    await execute('DELETE FROM portal_connections WHERE id = ?', [row.id]);
    if (row.credential_id) {
      await credentials.remove(row.credential_id, {
        actorType: 'org_member',
        actorId: req.member!.sub,
        reason: 'connection deleted',
        ip: clientIp(req),
      });
    }
    await audit.record({
      orgId: req.member!.orgId,
      userId: row.user_id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'connection.delete',
      entityType: 'portal_connection',
      entityId: row.id,
      metadata: { portal: row.portal },
      ip: clientIp(req),
    });
    res.status(204).end();
  }),
);

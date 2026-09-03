/**
 * Egress proxy pool. Each portal connection is assigned one so a user's account logs in
 * from their own country rather than from wherever the workers happen to run.
 *
 * `max_assignments` is the knob that matters operationally: stacking many accounts behind
 * one address is what turns a single flagged account into a correlated set of them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { notFound, badRequest } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import * as audit from '../audit/audit.service';
import * as credentials from '../credentials/credentials.service';

interface ProxyRow extends RowDataPacket {
  id: string;
  label: string;
  provider: string | null;
  kind: string;
  country: string;
  region: string | null;
  host: string;
  port: number;
  username: string | null;
  credential_id: string | null;
  status: string;
  max_assignments: number;
  last_checked_at: Date | null;
  assigned_count?: number;
}

const createSchema = z.object({
  label: z.string().min(1).max(120),
  provider: z.string().max(80).optional(),
  kind: z.enum(['residential', 'datacenter', 'mobile']).default('residential'),
  country: z.string().length(2).transform((s) => s.toUpperCase()),
  region: z.string().max(100).optional(),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  password: z.string().max(500).optional(),
  maxAssignments: z.number().int().min(1).max(50).default(1),
});

function present(row: ProxyRow) {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    kind: row.kind,
    country: row.country,
    region: row.region,
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: row.credential_id !== null,
    status: row.status,
    maxAssignments: row.max_assignments,
    assignedCount: Number(row.assigned_count ?? 0),
    lastCheckedAt: row.last_checked_at,
  };
}

export const proxiesRouter = Router();
proxiesRouter.use(requireMember, requireRole('owner', 'admin', 'ops'));

proxiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query<ProxyRow>(
      `SELECT p.*, COUNT(pc.id) AS assigned_count
         FROM proxies p
         LEFT JOIN portal_connections pc ON pc.proxy_id = p.id
        WHERE p.org_id = ?
        GROUP BY p.id
        ORDER BY p.country, p.region, p.label`,
      [req.member!.orgId],
    );
    res.json({ data: rows.map(present) });
  }),
);

proxiesRouter.post(
  '/',
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const input = parse(createSchema, req.body);
    const orgId = req.member!.orgId;
    const id = newId();

    await withTransaction(async (tx) => {
      let credentialId: string | null = null;
      if (input.password) {
        credentialId = await credentials.store(
          orgId,
          'proxy',
          input.username ?? input.label,
          input.password,
          { actorType: 'org_member', actorId: req.member!.sub, reason: 'proxy created', ip: clientIp(req) },
          tx,
        );
      }

      await tx.execute(
        `INSERT INTO proxies
           (id, org_id, label, provider, kind, country, region, host, port, username, credential_id, max_assignments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, orgId, input.label, input.provider ?? null, input.kind, input.country,
          input.region ?? null, input.host, input.port, input.username ?? null,
          credentialId, input.maxAssignments,
        ],
      );

      await audit.recordIn(tx, {
        orgId,
        actorType: 'org_member',
        actorId: req.member!.sub,
        action: 'proxy.create',
        entityType: 'proxy',
        entityId: id,
        metadata: { label: input.label, country: input.country, kind: input.kind },
        ip: clientIp(req),
      });
    });

    const row = await queryOne<ProxyRow>('SELECT * FROM proxies WHERE id = ?', [id]);
    res.status(201).json(present(row!));
  }),
);

proxiesRouter.patch(
  '/:id',
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      label: z.string().max(120).optional(),
      status: z.enum(['available', 'in_use', 'degraded', 'retired']).optional(),
      maxAssignments: z.number().int().min(1).max(50).optional(),
      region: z.string().max(100).nullable().optional(),
    });
    const input = parse(schema, req.body);

    const row = await queryOne<ProxyRow>('SELECT * FROM proxies WHERE id = ? AND org_id = ?', [
      param(req, 'id'),
      req.member!.orgId,
    ]);
    if (!row) throw notFound('Proxy');

    const columns: Record<string, unknown> = {
      label: input.label,
      status: input.status,
      max_assignments: input.maxAssignments,
      region: input.region,
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(columns)) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (sets.length === 0) throw badRequest('No changes supplied');

    await execute(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);

    // Retiring a proxy leaves its connections unrouted rather than silently egressing from
    // the wrong country; they surface as needing attention.
    if (input.status === 'retired') {
      await execute(
        `UPDATE portal_connections
            SET proxy_id = NULL, connection_status = 'needs_attention',
                status_reason = 'Assigned proxy retired'
          WHERE proxy_id = ?`,
        [row.id],
      );
    }

    await audit.record({
      orgId: req.member!.orgId,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'proxy.update',
      entityType: 'proxy',
      entityId: row.id,
      metadata: input as Record<string, unknown>,
      ip: clientIp(req),
    });

    const updated = await queryOne<ProxyRow>('SELECT * FROM proxies WHERE id = ?', [row.id]);
    res.json(present(updated!));
  }),
);

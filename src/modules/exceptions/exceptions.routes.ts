/**
 * The ops exception queue: the screen someone on your team actually sits in front of.
 *
 * On OTP specifically — the flow this supports is: automation hits a verification prompt,
 * ops contacts the user, the user reads back the code they received, ops types it here. The
 * platform has no access to the user's mailbox or phone and does not try to obtain one.
 * `response_value` holds that code for a few minutes and is cleared the moment the worker
 * reads it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import * as audit from '../audit/audit.service';

/** How long a supplied OTP stays usable. Portal codes generally expire faster than this. */
const OTP_TTL_SECONDS = 300;

interface ExceptionRow extends RowDataPacket {
  id: string;
  user_id: string;
  full_name: string;
  portal: string;
  type: string;
  severity: string;
  status: string;
  detail: string | null;
  raised_at: Date;
  assigned_to: string | null;
  assignee_name: string | null;
  resolved_at: Date | null;
  resolution: string | null;
  resolution_note: string | null;
  run_id: string | null;
}

function present(row: ExceptionRow) {
  return {
    id: row.id,
    user: { id: row.user_id, fullName: row.full_name },
    portal: row.portal,
    type: row.type,
    severity: row.severity,
    status: row.status,
    detail: row.detail,
    raisedAt: row.raised_at,
    assignedTo: row.assigned_to ? { id: row.assigned_to, fullName: row.assignee_name } : null,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
    runId: row.run_id,
  };
}

const SELECT = `
  SELECT e.*, u.full_name, m.full_name AS assignee_name
    FROM exception_queue e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN org_members m ON m.id = e.assigned_to
`;

export const exceptionsRouter = Router();
exceptionsRouter.use(requireMember);

exceptionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'open';
    const type = typeof req.query.type === 'string' ? req.query.type : null;
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const where = ['e.org_id = ?'];
    const params: unknown[] = [req.member!.orgId];

    if (status === 'active') where.push("e.status IN ('open','in_progress')");
    else if (status !== 'all') {
      where.push('e.status = ?');
      params.push(status);
    }
    if (type) {
      where.push('e.type = ?');
      params.push(type);
    }

    const rows = await query<ExceptionRow>(
      `${SELECT} WHERE ${where.join(' AND ')}
        ORDER BY FIELD(e.severity,'high','normal','low'), e.raised_at ASC
        LIMIT ?`,
      [...params, limit],
    );

    const counts = await query<RowDataPacket & { type: string; n: number }>(
      `SELECT type, COUNT(*) AS n FROM exception_queue
        WHERE org_id = ? AND status IN ('open','in_progress') GROUP BY type`,
      [req.member!.orgId],
    );

    res.json({
      data: rows.map(present),
      openCountsByType: Object.fromEntries(counts.map((c) => [c.type, Number(c.n)])),
    });
  }),
);

exceptionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await queryOne<ExceptionRow>(`${SELECT} WHERE e.id = ? AND e.org_id = ?`, [
      param(req, 'id'),
      req.member!.orgId,
    ]);
    if (!row) throw notFound('Exception');
    res.json(present(row));
  }),
);

/** Take ownership so two ops members don't work the same lockout at once. */
exceptionsRouter.post(
  '/:id/claim',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const result = await execute(
      `UPDATE exception_queue
          SET status = 'in_progress', assigned_to = ?, claimed_at = NOW(3)
        WHERE id = ? AND org_id = ? AND status = 'open'`,
      [req.member!.sub, param(req, 'id'), req.member!.orgId],
    );
    if (result.affectedRows === 0) throw conflict('Exception is not open, or is already claimed');

    const row = await queryOne<ExceptionRow>(`${SELECT} WHERE e.id = ?`, [param(req, 'id')]);
    res.json(present(row!));
  }),
);

/**
 * Supply the verification code the user forwarded. Held briefly, single-use: the worker's
 * read clears it, and it expires on its own if no worker picks it up.
 */
exceptionsRouter.post(
  '/:id/respond',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const schema = z.object({ code: z.string().min(1).max(60) });
    const { code } = parse(schema, req.body);

    const row = await queryOne<ExceptionRow>('SELECT * FROM exception_queue WHERE id = ? AND org_id = ?', [
      param(req, 'id'),
      req.member!.orgId,
    ]);
    if (!row) throw notFound('Exception');
    if (row.type !== 'otp_required') throw conflict('Only otp_required exceptions accept a code');
    if (row.status === 'resolved' || row.status === 'abandoned') throw conflict(`Exception is already ${row.status}`);

    await execute(
      `UPDATE exception_queue
          SET response_value = ?, response_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND),
              status = 'in_progress', assigned_to = COALESCE(assigned_to, ?)
        WHERE id = ?`,
      [code, OTP_TTL_SECONDS, req.member!.sub, row.id],
    );

    // The code itself is never written to the audit log.
    await audit.record({
      orgId: req.member!.orgId,
      userId: row.user_id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'exception.code_supplied',
      entityType: 'exception_queue',
      entityId: row.id,
      metadata: { portal: row.portal },
      ip: clientIp(req),
    });

    res.json({ ok: true, expiresInSeconds: OTP_TTL_SECONDS });
  }),
);

exceptionsRouter.post(
  '/:id/resolve',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      resolution: z.enum(['code_supplied', 'cleared_manually', 'account_recovered', 'user_contacted', 'abandoned']),
      note: z.string().max(2000).optional(),
      /** Whether the account is fit to be automated again. Defaults to yes unless abandoned. */
      restoreConnection: z.boolean().optional(),
    });
    const input = parse(schema, req.body);

    const row = await queryOne<ExceptionRow & { connection_id: string | null }>(
      'SELECT * FROM exception_queue WHERE id = ? AND org_id = ?',
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Exception');
    if (row.status === 'resolved') throw conflict('Exception is already resolved');

    const restore = input.restoreConnection ?? input.resolution !== 'abandoned';

    await withTransaction(async (tx) => {
      await tx.execute(
        `UPDATE exception_queue
            SET status = ?, resolution = ?, resolution_note = ?, resolved_at = NOW(3),
                resolved_by = ?, response_value = NULL
          WHERE id = ?`,
        [
          input.resolution === 'abandoned' ? 'abandoned' : 'resolved',
          input.resolution, input.note ?? null, req.member!.sub, row.id,
        ],
      );

      if (row.connection_id) {
        if (restore) {
          await tx.execute(
            `UPDATE portal_connections
                SET connection_status = 'connected', status_reason = NULL, consecutive_failures = 0
              WHERE id = ?`,
            [row.connection_id],
          );
        } else {
          await tx.execute(
            `UPDATE portal_connections SET connection_status = 'disconnected', status_reason = ? WHERE id = ?`,
            [`Exception abandoned: ${row.type}`, row.connection_id],
          );
        }
      }

      await audit.recordIn(tx, {
        orgId: req.member!.orgId,
        userId: row.user_id,
        actorType: 'org_member',
        actorId: req.member!.sub,
        action: 'exception.resolve',
        entityType: 'exception_queue',
        entityId: row.id,
        metadata: { resolution: input.resolution, type: row.type, restored: restore },
        ip: clientIp(req),
      });
    });

    res.status(204).end();
  }),
);

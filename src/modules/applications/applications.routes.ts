import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import * as audit from '../audit/audit.service';

interface ApplicationRow extends RowDataPacket {
  id: string;
  user_id: string;
  full_name: string;
  portal: string;
  job_title: string;
  company: string;
  location: string | null;
  job_url: string | null;
  applied_at: Date;
  status: string;
  status_source: string;
  status_detail: string | null;
  last_checked_at: Date | null;
  run_id: string | null;
}

function present(row: ApplicationRow) {
  return {
    id: row.id,
    user: { id: row.user_id, fullName: row.full_name },
    portal: row.portal,
    jobTitle: row.job_title,
    company: row.company,
    location: row.location,
    jobUrl: row.job_url,
    appliedAt: row.applied_at,
    status: row.status,
    // 'bot_confirmed' means we watched the submission succeed. 'portal_scrape' means we
    // read it off the portal's own page and it is only as complete as that page is.
    statusSource: row.status_source,
    statusDetail: row.status_detail,
    lastCheckedAt: row.last_checked_at,
    runId: row.run_id,
  };
}

export const applicationsRouter = Router();
applicationsRouter.use(requireMember);

applicationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = ['u.org_id = ?'];
    const params: unknown[] = [req.member!.orgId];

    for (const [queryKey, column] of [
      ['userId', 'a.user_id'],
      ['portal', 'a.portal'],
      ['status', 'a.status'],
    ] as const) {
      const value = req.query[queryKey];
      if (typeof value === 'string' && value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (typeof req.query.company === 'string' && req.query.company) {
      where.push('a.company LIKE ?');
      params.push(`%${req.query.company}%`);
    }
    if (typeof req.query.from === 'string') {
      where.push('a.applied_at >= ?');
      params.push(new Date(req.query.from));
    }
    if (typeof req.query.to === 'string') {
      where.push('a.applied_at <= ?');
      params.push(new Date(req.query.to));
    }

    const clause = where.join(' AND ');
    const rows = await query<ApplicationRow>(
      `SELECT a.*, u.full_name FROM applications a JOIN users u ON u.id = a.user_id
        WHERE ${clause} ORDER BY a.applied_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const total = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM applications a JOIN users u ON u.id = a.user_id WHERE ${clause}`,
      params,
    );

    res.json({ data: rows.map(present), total: total?.total ?? 0, limit, offset });
  }),
);

applicationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await queryOne<ApplicationRow>(
      `SELECT a.*, u.full_name FROM applications a JOIN users u ON u.id = a.user_id
        WHERE a.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Application');

    const events = await query<RowDataPacket>(
      `SELECT from_status, to_status, source, observed_at
         FROM application_status_events WHERE application_id = ? ORDER BY observed_at`,
      [row.id],
    );

    res.json({ ...present(row), statusHistory: events });
  }),
);

/** Manual correction, e.g. the user tells you they got an interview the portal never showed. */
applicationsRouter.patch(
  '/:id/status',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      status: z.enum(['applied', 'viewed', 'in_consideration', 'interview', 'offer', 'rejected', 'no_response', 'unknown']),
      statusDetail: z.string().max(255).optional(),
    });
    const input = parse(schema, req.body);

    const row = await queryOne<ApplicationRow>(
      `SELECT a.*, u.full_name FROM applications a JOIN users u ON u.id = a.user_id
        WHERE a.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Application');

    await execute(
      `UPDATE applications SET status = ?, status_source = 'manual', status_detail = ? WHERE id = ?`,
      [input.status, input.statusDetail ?? null, row.id],
    );
    await execute(
      `INSERT INTO application_status_events (application_id, from_status, to_status, source, observed_at)
       VALUES (?, ?, ?, 'manual', NOW(3))`,
      [row.id, row.status, input.status],
    );
    await audit.record({
      orgId: req.member!.orgId,
      userId: row.user_id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'application.status_override',
      entityType: 'application',
      entityId: row.id,
      metadata: { from: row.status, to: input.status },
      ip: clientIp(req),
    });

    res.json({ id: row.id, status: input.status, statusSource: 'manual' });
  }),
);

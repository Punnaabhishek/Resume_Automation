/**
 * Per-user periodic summaries. Users have no dashboard to log into, so this is the only
 * thing they actually see — which makes the honesty of the wording part of the product,
 * not a footnote. `caveats` ships inside the payload so whatever renders it cannot present
 * scraped statuses as if they were complete.
 *
 * Generation and storage live here; delivery (email/PDF) is left to the channel you pick,
 * with `sent_at` recorded when it goes out.
 */
import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import * as audit from '../audit/audit.service';

const CAVEATS = [
  'Applications sent is confirmed: each one was submitted and observed to go through.',
  'Statuses beyond “sent” come from each portal’s own applied-jobs page and are incomplete. ' +
    'Most employers never post an outcome there, so no status change does not mean no decision.',
  'Companies on your exclude list were skipped and are not counted here.',
];

export interface ReportPayload {
  user: { id: string; fullName: string };
  period: { start: string; end: string };
  applicationsSent: number;
  byPortal: Record<string, number>;
  byDesignation: { designation: string; count: number }[];
  observedStatuses: { status: string; count: number }[];
  companies: string[];
  caveats: string[];
}

/**
 * Report periods are day-granular — the stored columns are DATE and callers pass
 * "2026-09-03" — but `applied_at` is a DATETIME. Coercing those strings gives midnight, so
 * comparing them directly would make a single-day period cover one instant and a weekly
 * period silently drop its own final day. Expand to whole UTC days instead.
 */
function dayRange(start: Date, end: Date): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0, 0)),
    to: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999)),
  };
}

async function buildPayload(userId: string, periodStart: Date, periodEnd: Date): Promise<ReportPayload> {
  const { from: start, to: end } = dayRange(periodStart, periodEnd);

  const user = await queryOne<RowDataPacket & { id: string; full_name: string }>(
    'SELECT id, full_name FROM users WHERE id = ?',
    [userId],
  );
  if (!user) throw notFound('User');

  const [total, byPortal, byDesignation, byStatus, companies] = await Promise.all([
    queryOne<RowDataPacket & { n: number }>(
      'SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND applied_at BETWEEN ? AND ?',
      [userId, start, end],
    ),
    query<RowDataPacket>(
      'SELECT portal, COUNT(*) AS n FROM applications WHERE user_id = ? AND applied_at BETWEEN ? AND ? GROUP BY portal',
      [userId, start, end],
    ),
    query<RowDataPacket>(
      `SELECT f.designation, COUNT(*) AS n
         FROM applications a JOIN job_filters f ON f.id = a.filter_id
        WHERE a.user_id = ? AND a.applied_at BETWEEN ? AND ?
        GROUP BY f.designation ORDER BY n DESC`,
      [userId, start, end],
    ),
    query<RowDataPacket>(
      `SELECT status, COUNT(*) AS n FROM applications
        WHERE user_id = ? AND applied_at BETWEEN ? AND ? AND status <> 'applied'
        GROUP BY status`,
      [userId, start, end],
    ),
    query<RowDataPacket>(
      `SELECT DISTINCT company FROM applications
        WHERE user_id = ? AND applied_at BETWEEN ? AND ? ORDER BY company LIMIT 200`,
      [userId, start, end],
    ),
  ]);

  return {
    user: { id: user.id, fullName: user.full_name },
    period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    applicationsSent: Number(total?.n ?? 0),
    byPortal: Object.fromEntries(byPortal.map((r) => [r.portal, Number(r.n)])),
    byDesignation: byDesignation.map((r) => ({ designation: String(r.designation), count: Number(r.n) })),
    observedStatuses: byStatus.map((r) => ({ status: String(r.status), count: Number(r.n) })),
    companies: companies.map((r) => String(r.company)),
    caveats: CAVEATS,
  };
}

export const reportsRouter = Router();
reportsRouter.use(requireMember);

reportsRouter.get(
  '/users/:userId/reports',
  asyncHandler(async (req, res) => {
    const user = await queryOne<RowDataPacket>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'userId'),
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    const rows = await query<RowDataPacket>(
      `SELECT id, period_start, period_end, format, generated_at, sent_at
         FROM user_reports WHERE user_id = ? ORDER BY period_end DESC LIMIT 50`,
      [param(req, 'userId')],
    );
    res.json({ data: rows });
  }),
);

/** Preview without persisting — what ops looks at before sending anything. */
reportsRouter.get(
  '/users/:userId/reports/preview',
  asyncHandler(async (req, res) => {
    const schema = z.object({ periodStart: z.coerce.date(), periodEnd: z.coerce.date() });
    const input = parse(schema, req.query);

    const user = await queryOne<RowDataPacket>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'userId'),
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    res.json(await buildPayload(param(req, 'userId'), input.periodStart, input.periodEnd));
  }),
);

reportsRouter.post(
  '/users/:userId/reports',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      periodStart: z.coerce.date(),
      periodEnd: z.coerce.date(),
      format: z.enum(['email', 'pdf', 'link']).default('email'),
    });
    const input = parse(schema, req.body);

    const user = await queryOne<RowDataPacket>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'userId'),
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    const payload = await buildPayload(param(req, 'userId'), input.periodStart, input.periodEnd);
    const id = newId();

    await execute(
      `INSERT INTO user_reports (id, user_id, period_start, period_end, format, payload)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), format = VALUES(format), generated_at = NOW(3)`,
      [
        id, param(req, 'userId'),
        input.periodStart.toISOString().slice(0, 10),
        input.periodEnd.toISOString().slice(0, 10),
        input.format, JSON.stringify(payload),
      ],
    );

    await audit.record({
      orgId: req.member!.orgId,
      userId: param(req, 'userId'),
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'report.generate',
      entityType: 'user_report',
      entityId: id,
      ip: clientIp(req),
    });

    res.status(201).json({ id, payload });
  }),
);

/** Mark a report as delivered, once your email/PDF channel has actually sent it. */
reportsRouter.post(
  '/reports/:id/sent',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const result = await execute(
      `UPDATE user_reports r JOIN users u ON u.id = r.user_id
          SET r.sent_at = NOW(3)
        WHERE r.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (result.affectedRows === 0) throw notFound('Report');
    res.status(204).end();
  }),
);

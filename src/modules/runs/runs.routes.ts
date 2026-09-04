import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import * as audit from '../audit/audit.service';
import { checkEligibility, enqueue, enqueueDueRuns, reapStaleRuns } from './runs.service';

interface RunRow extends RowDataPacket {
  id: string;
  user_id: string;
  full_name: string;
  portal: string;
  trigger_source: string;
  status: string;
  worker_id: string | null;
  scheduled_for: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  jobs_seen: number;
  jobs_matched: number;
  jobs_scored: number;
  jobs_below_threshold: number;
  best_score_missed: number | null;
  jobs_skipped_excluded: number;
  jobs_skipped_duplicate: number;
  applications_submitted: number;
  error_message: string | null;
}

function present(row: RunRow) {
  return {
    id: row.id,
    user: { id: row.user_id, fullName: row.full_name },
    portal: row.portal,
    triggerSource: row.trigger_source,
    status: row.status,
    workerId: row.worker_id,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    counters: {
      jobsSeen: row.jobs_seen,
      jobsMatched: row.jobs_matched,
      jobsSkippedExcluded: row.jobs_skipped_excluded,
      jobsSkippedDuplicate: row.jobs_skipped_duplicate,
      /** Postings actually opened and scored against the resume. */
      jobsScored: row.jobs_scored,
      jobsBelowThreshold: row.jobs_below_threshold,
      /**
       * The closest a rejected posting came to the bar. This is what separates "the
       * threshold is too high" from "the search found nothing" — without it, a run that
       * scored 200 jobs at 94 looks identical to one that found none.
       */
      bestScoreMissed: row.best_score_missed,
      applicationsSubmitted: row.applications_submitted,
    },
    errorMessage: row.error_message,
  };
}

export const runsRouter = Router();
runsRouter.use(requireMember);

runsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const where = ['u.org_id = ?'];
    const params: unknown[] = [req.member!.orgId];

    for (const [queryKey, column] of [
      ['userId', 'r.user_id'],
      ['portal', 'r.portal'],
      ['status', 'r.status'],
    ] as const) {
      const value = req.query[queryKey];
      if (typeof value === 'string' && value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }

    const rows = await query<RunRow>(
      `SELECT r.*, u.full_name FROM automation_runs r JOIN users u ON u.id = r.user_id
        WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`,
      [...params, limit],
    );
    res.json({ data: rows.map(present) });
  }),
);

/** Why an account is or is not being worked right now — the first thing ops asks. */
runsRouter.get(
  '/eligibility',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      userId: z.string().uuid(),
      portal: z.enum(['linkedin', 'indeed', 'dice']),
    });
    const input = parse(schema, req.query);

    const user = await queryOne<RowDataPacket>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      input.userId,
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    res.json(await checkEligibility(input.userId, input.portal));
  }),
);

runsRouter.post(
  '/',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      userId: z.string().uuid(),
      portal: z.enum(['linkedin', 'indeed', 'dice']),
      force: z.boolean().default(false),
    });
    const input = parse(schema, req.body);

    const user = await queryOne<RowDataPacket>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      input.userId,
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    const result = await enqueue({ ...input, triggerSource: 'manual' });
    if (!result.runId) {
      res.status(409).json({ error: { code: 'not_eligible', message: 'Run not queued', details: result.skipped } });
      return;
    }

    await audit.record({
      orgId: req.member!.orgId,
      userId: input.userId,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'run.enqueue',
      entityType: 'automation_run',
      entityId: result.runId,
      metadata: { portal: input.portal, forced: input.force },
      ip: clientIp(req),
    });

    res.status(201).json({ runId: result.runId });
  }),
);

runsRouter.post(
  '/:id/cancel',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const result = await execute(
      `UPDATE automation_runs r JOIN users u ON u.id = r.user_id
          SET r.status = 'cancelled', r.finished_at = NOW(3)
        WHERE r.id = ? AND u.org_id = ? AND r.status IN ('queued','claimed','running')`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (result.affectedRows === 0) throw conflict('Run is not cancellable');
    res.status(204).end();
  }),
);

/**
 * Scheduler hooks. Exposed so an Azure timer or cron can drive them over HTTP rather than
 * needing its own DB access; both are also callable directly from a process.
 */
runsRouter.post(
  '/scheduler/enqueue-due',
  requireRole('owner', 'admin'),
  asyncHandler(async (_req, res) => {
    res.json(await enqueueDueRuns());
  }),
);

runsRouter.post(
  '/scheduler/reap-stale',
  requireRole('owner', 'admin'),
  asyncHandler(async (_req, res) => {
    res.json({ reaped: await reapStaleRuns() });
  }),
);

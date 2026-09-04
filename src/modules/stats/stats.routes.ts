/**
 * Numbers for the ops dashboard.
 *
 * Every response separates `applied` from downstream statuses and carries a `confidence`
 * block saying so, because the distinction is easy to lose once it reaches a chart:
 * applications sent is a fact we observed; viewed/interview/rejected is whatever the portal
 * chose to show, and silence is the most common real outcome rather than a rejection.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { requireMember } from '../../middleware/auth';

const CONFIDENCE = {
  applied: 'bot_confirmed — the automation observed each submission succeed',
  downstream:
    'portal_scrape — read from the portal’s own applied-jobs view. Incomplete by nature: ' +
    'many outcomes, rejections especially, never appear there at all.',
} as const;

const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function defaultRange(input: { from?: Date; to?: Date }): { from: Date; to: Date } {
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

export const statsRouter = Router();
statsRouter.use(requireMember);

/** Org rollup: the landing screen. */
statsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const { from, to } = defaultRange(parse(rangeSchema, req.query));
    const orgId = req.member!.orgId;

    const [totals, byPortal, byStatus, userStates, exceptions, runs] = await Promise.all([
      queryOne<RowDataPacket>(
        `SELECT COUNT(*) AS applications,
                COUNT(DISTINCT a.user_id) AS active_users,
                COUNT(DISTINCT a.company_normalized) AS distinct_companies
           FROM applications a JOIN users u ON u.id = a.user_id
          WHERE u.org_id = ? AND a.applied_at BETWEEN ? AND ?`,
        [orgId, from, to],
      ),
      query<RowDataPacket>(
        `SELECT a.portal, COUNT(*) AS n FROM applications a JOIN users u ON u.id = a.user_id
          WHERE u.org_id = ? AND a.applied_at BETWEEN ? AND ? GROUP BY a.portal`,
        [orgId, from, to],
      ),
      query<RowDataPacket>(
        `SELECT a.status, a.status_source, COUNT(*) AS n
           FROM applications a JOIN users u ON u.id = a.user_id
          WHERE u.org_id = ? AND a.applied_at BETWEEN ? AND ?
          GROUP BY a.status, a.status_source`,
        [orgId, from, to],
      ),
      query<RowDataPacket>('SELECT status, COUNT(*) AS n FROM users WHERE org_id = ? GROUP BY status', [orgId]),
      query<RowDataPacket>(
        `SELECT type, COUNT(*) AS n FROM exception_queue
          WHERE org_id = ? AND status IN ('open','in_progress') GROUP BY type`,
        [orgId],
      ),
      query<RowDataPacket>(
        `SELECT r.status, COUNT(*) AS n FROM automation_runs r JOIN users u ON u.id = r.user_id
          WHERE u.org_id = ? AND r.created_at BETWEEN ? AND ? GROUP BY r.status`,
        [orgId, from, to],
      ),
    ]);

    res.json({
      range: { from, to },
      applications: {
        total: Number(totals?.applications ?? 0),
        activeUsers: Number(totals?.active_users ?? 0),
        distinctCompanies: Number(totals?.distinct_companies ?? 0),
        byPortal: Object.fromEntries(byPortal.map((r) => [r.portal, Number(r.n)])),
        byStatus: byStatus.map((r) => ({ status: r.status, source: r.status_source, count: Number(r.n) })),
      },
      users: Object.fromEntries(userStates.map((r) => [r.status, Number(r.n)])),
      openExceptions: Object.fromEntries(exceptions.map((r) => [r.type, Number(r.n)])),
      runs: Object.fromEntries(runs.map((r) => [r.status, Number(r.n)])),
      confidence: CONFIDENCE,
    });
  }),
);

/** Per-user summary — also the source the periodic report is rendered from. */
statsRouter.get(
  '/users/:userId',
  asyncHandler(async (req, res) => {
    const { from, to } = defaultRange(parse(rangeSchema, req.query));

    const user = await queryOne<RowDataPacket>(
      'SELECT id, full_name, target_designations, daily_application_cap FROM users WHERE id = ? AND org_id = ?',
      [param(req, 'userId'), req.member!.orgId],
    );
    if (!user) throw notFound('User');

    const [totals, byPortal, byStatus, byDesignation, topCompanies] = await Promise.all([
      queryOne<RowDataPacket>(
        `SELECT COUNT(*) AS applications, MIN(applied_at) AS first_applied, MAX(applied_at) AS last_applied
           FROM applications WHERE user_id = ? AND applied_at BETWEEN ? AND ?`,
        [user.id, from, to],
      ),
      query<RowDataPacket>(
        `SELECT portal, COUNT(*) AS n FROM applications
          WHERE user_id = ? AND applied_at BETWEEN ? AND ? GROUP BY portal`,
        [user.id, from, to],
      ),
      query<RowDataPacket>(
        `SELECT status, status_source, COUNT(*) AS n FROM applications
          WHERE user_id = ? AND applied_at BETWEEN ? AND ? GROUP BY status, status_source`,
        [user.id, from, to],
      ),
      query<RowDataPacket>(
        `SELECT f.designation, COUNT(*) AS n
           FROM applications a JOIN job_filters f ON f.id = a.filter_id
          WHERE a.user_id = ? AND a.applied_at BETWEEN ? AND ?
          GROUP BY f.designation ORDER BY n DESC`,
        [user.id, from, to],
      ),
      query<RowDataPacket>(
        `SELECT company, COUNT(*) AS n FROM applications
          WHERE user_id = ? AND applied_at BETWEEN ? AND ?
          GROUP BY company ORDER BY n DESC LIMIT 10`,
        [user.id, from, to],
      ),
    ]);

    const statuses = byStatus.map((r) => ({ status: r.status, source: r.status_source, count: Number(r.n) }));
    const responded = statuses
      .filter((s) => !['applied', 'no_response', 'unknown'].includes(s.status))
      .reduce((sum, s) => sum + s.count, 0);
    const total = Number(totals?.applications ?? 0);

    res.json({
      user: { id: user.id, fullName: user.full_name, targetDesignations: user.target_designations },
      range: { from, to },
      applicationsSent: total,
      firstApplied: totals?.first_applied ?? null,
      lastApplied: totals?.last_applied ?? null,
      byPortal: Object.fromEntries(byPortal.map((r) => [r.portal, Number(r.n)])),
      byStatus: statuses,
      byDesignation: byDesignation.map((r) => ({ designation: r.designation, count: Number(r.n) })),
      topCompanies: topCompanies.map((r) => ({ company: r.company, count: Number(r.n) })),
      // Deliberately not called a "response rate": it is a floor, since responses the
      // portal never displays are invisible to us.
      observedResponses: responded,
      observedResponseFloor: total > 0 ? Number((responded / total).toFixed(4)) : null,
      confidence: CONFIDENCE,
    });
  }),
);


/**
 * One job seeker's activity, grouped by the day it happened.
 *
 * The org-level rollup answers "how much are we doing"; this answers the question an operator
 * actually gets asked, which is "what did you do for *me*, and when". Days are UTC because
 * the daily cap resets on UTC_DATE() — grouping by anything else would show a day whose count
 * disagrees with the cap that governed it.
 */
statsRouter.get(
  '/users/:userId/daily',
  asyncHandler(async (req, res) => {
    const { from, to } = defaultRange(parse(rangeSchema, req.query));

    const user = await queryOne<RowDataPacket>(
      'SELECT id, full_name, daily_application_cap FROM users WHERE id = ? AND org_id = ?',
      [param(req, 'userId'), req.member!.orgId],
    );
    if (!user) throw notFound('User');

    const rows = await query<RowDataPacket>(
      `SELECT DATE(a.applied_at) AS day,
              a.id, a.job_title, a.company, a.portal, a.job_url,
              a.status, a.status_source, a.match_score, a.applied_at,
              f.designation
         FROM applications a
         LEFT JOIN job_filters f ON f.id = a.filter_id
        WHERE a.user_id = ? AND a.applied_at BETWEEN ? AND ?
        ORDER BY a.applied_at DESC`,
      [user.id, from, to],
    );

    // Runs are joined in per day so a day with zero applications still explains itself:
    // "nothing cleared the bar" reads very differently from "we never ran".
    const runs = await query<RowDataPacket>(
      `SELECT DATE(COALESCE(finished_at, started_at, created_at)) AS day,
              COUNT(*) AS runs,
              SUM(jobs_seen) AS jobs_seen,
              SUM(jobs_scored) AS jobs_scored,
              SUM(jobs_below_threshold) AS jobs_below_threshold,
              MAX(best_score_missed) AS best_score_missed
         FROM automation_runs
        WHERE user_id = ? AND COALESCE(finished_at, started_at, created_at) BETWEEN ? AND ?
        GROUP BY day`,
      [user.id, from, to],
    );

    const byDay = new Map<string, any>();
    const dayKey = (value: unknown): string =>
      value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

    for (const row of rows) {
      const key = dayKey(row.day);
      if (!byDay.has(key)) {
        byDay.set(key, { day: key, applications: [], roles: new Set<string>(), companies: new Set<string>() });
      }
      const bucket = byDay.get(key);
      bucket.applications.push({
        id: row.id,
        jobTitle: row.job_title,
        company: row.company,
        portal: row.portal,
        jobUrl: row.job_url,
        status: row.status,
        statusSource: row.status_source,
        matchScore: row.match_score,
        appliedAt: row.applied_at,
        // The role searched, which is what was actually applied *for* — distinct from the
        // job's own title, which is whatever the employer chose to call it.
        designation: row.designation,
      });
      if (row.designation) bucket.roles.add(row.designation);
      bucket.companies.add(row.company);
    }

    for (const row of runs) {
      const key = dayKey(row.day);
      if (!byDay.has(key)) {
        byDay.set(key, { day: key, applications: [], roles: new Set<string>(), companies: new Set<string>() });
      }
      Object.assign(byDay.get(key), {
        runs: Number(row.runs),
        jobsSeen: Number(row.jobs_seen ?? 0),
        jobsScored: Number(row.jobs_scored ?? 0),
        jobsBelowThreshold: Number(row.jobs_below_threshold ?? 0),
        bestScoreMissed: row.best_score_missed === null ? null : Number(row.best_score_missed),
      });
    }

    const days = [...byDay.values()]
      .map((d) => ({
        ...d,
        roles: [...d.roles],
        companies: [...d.companies],
        applied: d.applications.length,
        runs: d.runs ?? 0,
        jobsSeen: d.jobsSeen ?? 0,
        jobsScored: d.jobsScored ?? 0,
        jobsBelowThreshold: d.jobsBelowThreshold ?? 0,
        bestScoreMissed: d.bestScoreMissed ?? null,
      }))
      .sort((a, b) => b.day.localeCompare(a.day));

    res.json({
      user: { id: user.id, fullName: user.full_name, dailyApplicationCap: user.daily_application_cap },
      range: { from, to },
      days,
      confidence: { applied: CONFIDENCE.applied },
    });
  }),
);

/** Applications over time, for the trend chart. */
statsRouter.get(
  '/trend',
  asyncHandler(async (req, res) => {
    const schema = rangeSchema.extend({
      userId: z.string().uuid().optional(),
      interval: z.enum(['day', 'week']).default('day'),
    });
    const input = parse(schema, req.query);
    const { from, to } = defaultRange(input);

    const bucket = input.interval === 'week' ? "DATE_FORMAT(a.applied_at, '%x-W%v')" : 'DATE(a.applied_at)';
    const where = ['u.org_id = ?', 'a.applied_at BETWEEN ? AND ?'];
    const params: unknown[] = [req.member!.orgId, from, to];
    if (input.userId) {
      where.push('a.user_id = ?');
      params.push(input.userId);
    }

    const rows = await query<RowDataPacket>(
      `SELECT ${bucket} AS bucket, a.portal, COUNT(*) AS n
         FROM applications a JOIN users u ON u.id = a.user_id
        WHERE ${where.join(' AND ')}
        GROUP BY bucket, a.portal
        ORDER BY bucket`,
      params,
    );

    res.json({
      range: { from, to },
      interval: input.interval,
      series: rows.map((r) => ({ bucket: String(r.bucket), portal: r.portal, count: Number(r.n) })),
      confidence: { applied: CONFIDENCE.applied },
    });
  }),
);

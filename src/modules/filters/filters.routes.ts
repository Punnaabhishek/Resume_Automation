import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { badRequest, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import * as audit from '../audit/audit.service';

interface FilterRow extends RowDataPacket {
  id: string;
  user_id: string;
  name: string;
  designation: string;
  keywords: string[];
  excluded_keywords: string[] | null;
  locations: string[] | null;
  remote_only: number;
  seniority: string;
  employment_types: string[] | null;
  min_salary: number | null;
  salary_currency: string | null;
  portals: string[];
  posted_within_days: number | null;
  is_active: number;
  priority: number;
}

const filterSchema = z.object({
  name: z.string().min(1).max(120),
  designation: z.string().min(1).max(200),
  keywords: z.array(z.string().min(1)).min(1),
  excludedKeywords: z.array(z.string().min(1)).default([]),
  locations: z.array(z.string().min(1)).default([]),
  remoteOnly: z.boolean().default(false),
  seniority: z
    .enum(['intern', 'entry', 'associate', 'mid', 'senior', 'lead', 'principal', 'director', 'any'])
    .default('any'),
  employmentTypes: z.array(z.enum(['full_time', 'part_time', 'contract', 'internship', 'temporary'])).default([]),
  minSalary: z.number().int().min(0).optional(),
  salaryCurrency: z.string().length(3).optional(),
  portals: z.array(z.enum(['linkedin', 'indeed', 'dice'])).min(1),
  postedWithinDays: z.number().int().min(1).max(90).optional(),
  isActive: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
});

function present(row: FilterRow) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    designation: row.designation,
    keywords: row.keywords,
    excludedKeywords: row.excluded_keywords ?? [],
    locations: row.locations ?? [],
    remoteOnly: row.remote_only === 1,
    seniority: row.seniority,
    employmentTypes: row.employment_types ?? [],
    minSalary: row.min_salary,
    salaryCurrency: row.salary_currency,
    portals: row.portals,
    postedWithinDays: row.posted_within_days,
    isActive: row.is_active === 1,
    priority: row.priority,
  };
}

async function assertUserInOrg(userId: string, orgId: string): Promise<void> {
  const user = await queryOne<RowDataPacket>('SELECT id FROM users WHERE id = ? AND org_id = ?', [userId, orgId]);
  if (!user) throw notFound('User');
}

export const filtersRouter = Router();
filtersRouter.use(requireMember);

filtersRouter.get(
  '/users/:userId/filters',
  asyncHandler(async (req, res) => {
    await assertUserInOrg(param(req, 'userId'), req.member!.orgId);
    const rows = await query<FilterRow>(
      'SELECT * FROM job_filters WHERE user_id = ? ORDER BY priority DESC, created_at',
      [param(req, 'userId')],
    );
    res.json({ data: rows.map(present) });
  }),
);

filtersRouter.post(
  '/users/:userId/filters',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const input = parse(filterSchema, req.body);
    await assertUserInOrg(param(req, 'userId'), req.member!.orgId);

    const id = newId();
    await execute(
      `INSERT INTO job_filters
         (id, user_id, name, designation, keywords, excluded_keywords, locations, remote_only,
          seniority, employment_types, min_salary, salary_currency, portals, posted_within_days,
          is_active, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, param(req, 'userId'), input.name, input.designation,
        JSON.stringify(input.keywords), JSON.stringify(input.excludedKeywords),
        JSON.stringify(input.locations), input.remoteOnly ? 1 : 0, input.seniority,
        JSON.stringify(input.employmentTypes), input.minSalary ?? null, input.salaryCurrency ?? null,
        JSON.stringify(input.portals), input.postedWithinDays ?? null,
        input.isActive ? 1 : 0, input.priority,
      ],
    );

    await audit.record({
      orgId: req.member!.orgId,
      userId: param(req, 'userId'),
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'filter.create',
      entityType: 'job_filter',
      entityId: id,
      metadata: { name: input.name, portals: input.portals },
      ip: clientIp(req),
    });

    const row = await queryOne<FilterRow>('SELECT * FROM job_filters WHERE id = ?', [id]);
    res.status(201).json(present(row!));
  }),
);

filtersRouter.patch(
  '/filters/:id',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const input = parse(filterSchema.partial(), req.body);
    const row = await queryOne<FilterRow>(
      `SELECT f.* FROM job_filters f JOIN users u ON u.id = f.user_id WHERE f.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Filter');

    const columns: Record<string, unknown> = {
      name: input.name,
      designation: input.designation,
      keywords: input.keywords ? JSON.stringify(input.keywords) : undefined,
      excluded_keywords: input.excludedKeywords ? JSON.stringify(input.excludedKeywords) : undefined,
      locations: input.locations ? JSON.stringify(input.locations) : undefined,
      remote_only: input.remoteOnly === undefined ? undefined : input.remoteOnly ? 1 : 0,
      seniority: input.seniority,
      employment_types: input.employmentTypes ? JSON.stringify(input.employmentTypes) : undefined,
      min_salary: input.minSalary,
      salary_currency: input.salaryCurrency,
      portals: input.portals ? JSON.stringify(input.portals) : undefined,
      posted_within_days: input.postedWithinDays,
      is_active: input.isActive === undefined ? undefined : input.isActive ? 1 : 0,
      priority: input.priority,
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

    await execute(`UPDATE job_filters SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);
    await audit.record({
      orgId: req.member!.orgId,
      userId: row.user_id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'filter.update',
      entityType: 'job_filter',
      entityId: row.id,
      ip: clientIp(req),
    });

    const updated = await queryOne<FilterRow>('SELECT * FROM job_filters WHERE id = ?', [row.id]);
    res.json(present(updated!));
  }),
);

filtersRouter.delete(
  '/filters/:id',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const result = await execute(
      `DELETE f FROM job_filters f JOIN users u ON u.id = f.user_id WHERE f.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (result.affectedRows === 0) throw notFound('Filter');

    await audit.record({
      orgId: req.member!.orgId,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'filter.delete',
      entityType: 'job_filter',
      entityId: param(req, 'id'),
      ip: clientIp(req),
    });
    res.status(204).end();
  }),
);

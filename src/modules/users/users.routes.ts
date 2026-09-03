/**
 * Job-seeker records. These people never log in — ops creates and maintains them from
 * intake, so every route here is org-member authenticated and scoped to req.member.orgId.
 */
import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { conflict, notFound } from '../../lib/errors';
import { newId, normalizeCompany } from '../../lib/ids';
import { parse } from '../../lib/validate';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import { env } from '../../config/env';
import * as audit from '../audit/audit.service';

interface UserRow extends RowDataPacket {
  id: string;
  org_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  country: string;
  state: string | null;
  city: string | null;
  timezone: string;
  target_designations: string[];
  key_skills: string[];
  status: string;
  service_plan: string | null;
  intake_channel: string | null;
  intake_completed_at: Date | null;
  daily_application_cap: number;
  min_minutes_between_applications: number;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

const createUserSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  country: z.string().length(2).transform((s) => s.toUpperCase()),
  state: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  timezone: z.string().max(64).default('UTC'),
  targetDesignations: z.array(z.string().min(1)).min(1),
  keySkills: z.array(z.string().min(1)).default([]),
  servicePlan: z.string().max(60).optional(),
  intakeChannel: z.enum(['form', 'whatsapp', 'phone', 'email', 'other']).optional(),
  dailyApplicationCap: z.number().int().min(1).max(200).optional(),
  minMinutesBetweenApplications: z.number().int().min(0).max(1440).optional(),
  excludedCompanies: z
    .array(
      z.object({
        companyName: z.string().min(1).max(200),
        reason: z.enum(['current_employer', 'past_employer', 'competitor', 'personal', 'other']).default('other'),
      }),
    )
    .default([]),
  notes: z.string().optional(),
});

const updateUserSchema = createUserSchema.partial().omit({ excludedCompanies: true }).extend({
  status: z.enum(['intake', 'active', 'paused', 'suspended', 'offboarded']).optional(),
});

function present(row: UserRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    location: { country: row.country, state: row.state, city: row.city, timezone: row.timezone },
    targetDesignations: row.target_designations,
    keySkills: row.key_skills,
    status: row.status,
    servicePlan: row.service_plan,
    intake: { channel: row.intake_channel, completedAt: row.intake_completed_at },
    pacing: {
      dailyApplicationCap: row.daily_application_cap,
      minMinutesBetweenApplications: row.min_minutes_between_applications,
    },
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const usersRouter = Router();
usersRouter.use(requireMember);

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where: string[] = ['org_id = ?'];
    const params: unknown[] = [req.member!.orgId];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (search) {
      where.push('(full_name LIKE ? OR email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const rows = await query<UserRow>(
      `SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const countRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM users WHERE ${where.join(' AND ')}`,
      params,
    );

    res.json({ data: rows.map(present), total: countRow?.total ?? 0, limit, offset });
  }),
);

usersRouter.post(
  '/',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const input = parse(createUserSchema, req.body);
    const orgId = req.member!.orgId;

    const existing = await queryOne<UserRow>('SELECT id FROM users WHERE org_id = ? AND email = ?', [
      orgId,
      input.email.toLowerCase(),
    ]);
    if (existing) throw conflict('A user with this email already exists in this organization');

    const id = newId();
    await withTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO users
           (id, org_id, full_name, email, phone, country, state, city, timezone,
            target_designations, key_skills, service_plan, intake_channel,
            daily_application_cap, min_minutes_between_applications, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, orgId, input.fullName, input.email.toLowerCase(), input.phone ?? null,
          input.country, input.state ?? null, input.city ?? null, input.timezone,
          JSON.stringify(input.targetDesignations), JSON.stringify(input.keySkills),
          input.servicePlan ?? null, input.intakeChannel ?? null,
          input.dailyApplicationCap ?? env.pacing.defaultDailyCap,
          input.minMinutesBetweenApplications ?? env.pacing.defaultMinMinutesBetween,
          input.notes ?? null,
        ],
      );

      for (const company of input.excludedCompanies) {
        await tx.execute(
          `INSERT INTO excluded_companies (id, user_id, company_name, normalized_name, reason)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), reason = VALUES(reason)`,
          [newId(), id, company.companyName, normalizeCompany(company.companyName), company.reason],
        );
      }

      await audit.recordIn(tx, {
        orgId,
        userId: id,
        actorType: 'org_member',
        actorId: req.member!.sub,
        action: 'user.create',
        entityType: 'user',
        entityId: id,
        metadata: { excludedCompanyCount: input.excludedCompanies.length },
        ip: clientIp(req),
        userAgent: req.header('user-agent'),
      });
    });

    const row = await queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
    res.status(201).json(present(row!));
  }),
);

usersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await queryOne<UserRow>('SELECT * FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'id'),
      req.member!.orgId,
    ]);
    if (!row) throw notFound('User');

    const [excluded, filters, connections, consents] = await Promise.all([
      query<RowDataPacket>('SELECT id, company_name, reason FROM excluded_companies WHERE user_id = ? ORDER BY company_name', [row.id]),
      query<RowDataPacket>('SELECT id, name, designation, is_active FROM job_filters WHERE user_id = ?', [row.id]),
      query<RowDataPacket>(
        `SELECT id, portal, connection_status, status_reason, last_login_at, last_synced_at, consecutive_failures
           FROM portal_connections WHERE user_id = ?`,
        [row.id],
      ),
      query<RowDataPacket>(
        'SELECT consent_type, version, granted_at, revoked_at FROM consents WHERE user_id = ? ORDER BY granted_at DESC',
        [row.id],
      ),
    ]);

    res.json({
      ...present(row),
      excludedCompanies: excluded.map((e) => ({ id: e.id, companyName: e.company_name, reason: e.reason })),
      filters,
      connections,
      consents,
    });
  }),
);

usersRouter.patch(
  '/:id',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const input = parse(updateUserSchema, req.body);
    const existing = await queryOne<UserRow>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'id'),
      req.member!.orgId,
    ]);
    if (!existing) throw notFound('User');

    const columns: Record<string, unknown> = {
      full_name: input.fullName,
      email: input.email?.toLowerCase(),
      phone: input.phone,
      country: input.country,
      state: input.state,
      city: input.city,
      timezone: input.timezone,
      target_designations: input.targetDesignations ? JSON.stringify(input.targetDesignations) : undefined,
      key_skills: input.keySkills ? JSON.stringify(input.keySkills) : undefined,
      status: input.status,
      service_plan: input.servicePlan,
      intake_channel: input.intakeChannel,
      daily_application_cap: input.dailyApplicationCap,
      min_minutes_between_applications: input.minMinutesBetweenApplications,
      notes: input.notes,
    };

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(columns)) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (sets.length > 0) {
      await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, param(req, 'id')]);
      await audit.record({
        orgId: req.member!.orgId,
        userId: param(req, 'id'),
        actorType: 'org_member',
        actorId: req.member!.sub,
        action: 'user.update',
        entityType: 'user',
        entityId: param(req, 'id'),
        metadata: { fields: Object.keys(columns).filter((k) => columns[k] !== undefined) },
        ip: clientIp(req),
      });
    }

    const row = await queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [param(req, 'id')]);
    res.json(present(row!));
  }),
);

// --- Exclude list -----------------------------------------------------------------------
// Per the spec this is the cheapest real safeguard in a no-review model, so it is editable
// on its own rather than only at intake.

const excludeSchema = z.object({
  companyName: z.string().min(1).max(200),
  reason: z.enum(['current_employer', 'past_employer', 'competitor', 'personal', 'other']).default('other'),
});

usersRouter.post(
  '/:id/excluded-companies',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const input = parse(excludeSchema, req.body);
    const user = await queryOne<UserRow>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'id'),
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    const id = newId();
    await execute(
      `INSERT INTO excluded_companies (id, user_id, company_name, normalized_name, reason)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), reason = VALUES(reason)`,
      [id, user.id, input.companyName, normalizeCompany(input.companyName), input.reason],
    );
    await audit.record({
      orgId: req.member!.orgId,
      userId: user.id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'user.exclude_company.add',
      entityType: 'excluded_company',
      entityId: id,
      metadata: { companyName: input.companyName },
      ip: clientIp(req),
    });

    res.status(201).json({ id, companyName: input.companyName, reason: input.reason });
  }),
);

usersRouter.delete(
  '/:id/excluded-companies/:excludeId',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const result = await execute(
      `DELETE ec FROM excluded_companies ec
         JOIN users u ON u.id = ec.user_id
        WHERE ec.id = ? AND ec.user_id = ? AND u.org_id = ?`,
      [param(req, 'excludeId'), param(req, 'id'), req.member!.orgId],
    );
    if (result.affectedRows === 0) throw notFound('Excluded company');

    await audit.record({
      orgId: req.member!.orgId,
      userId: param(req, 'id'),
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'user.exclude_company.remove',
      entityType: 'excluded_company',
      entityId: param(req, 'excludeId'),
      ip: clientIp(req),
    });
    res.status(204).end();
  }),
);

// --- Consent ----------------------------------------------------------------------------
// A user with no unrevoked automated_apply consent cannot have runs queued; the queue
// checks this before handing work to a worker.

const consentSchema = z.object({
  consentType: z.enum(['automated_apply', 'credential_storage', 'data_processing']),
  version: z.string().min(1).max(20),
  grantedAt: z.coerce.date().optional(),
  capturedVia: z.string().max(60).optional(),
  evidenceRef: z.string().max(500).optional(),
});

usersRouter.post(
  '/:id/consents',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const input = parse(consentSchema, req.body);
    const user = await queryOne<UserRow>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'id'),
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    const id = newId();
    await execute(
      `INSERT INTO consents (id, user_id, consent_type, version, granted_at, captured_by, captured_via, evidence_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, user.id, input.consentType, input.version,
        input.grantedAt ?? new Date(), req.member!.sub,
        input.capturedVia ?? null, input.evidenceRef ?? null,
      ],
    );
    await audit.record({
      orgId: req.member!.orgId,
      userId: user.id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'user.consent.grant',
      entityType: 'consent',
      entityId: id,
      metadata: { consentType: input.consentType, version: input.version },
      ip: clientIp(req),
    });

    res.status(201).json({ id, ...input });
  }),
);

usersRouter.post(
  '/:id/consents/:consentId/revoke',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const result = await execute(
      `UPDATE consents c JOIN users u ON u.id = c.user_id
          SET c.revoked_at = NOW(3)
        WHERE c.id = ? AND c.user_id = ? AND u.org_id = ? AND c.revoked_at IS NULL`,
      [param(req, 'consentId'), param(req, 'id'), req.member!.orgId],
    );
    if (result.affectedRows === 0) throw notFound('Active consent');

    // Revoking authorization stops future work immediately: pause the user and drop any
    // runs that have not been claimed yet.
    await execute(`UPDATE users SET status = 'paused' WHERE id = ?`, [param(req, 'id')]);
    await execute(`UPDATE automation_runs SET status = 'cancelled' WHERE user_id = ? AND status = 'queued'`, [
      param(req, 'id'),
    ]);

    await audit.record({
      orgId: req.member!.orgId,
      userId: param(req, 'id'),
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'user.consent.revoke',
      entityType: 'consent',
      entityId: param(req, 'consentId'),
      ip: clientIp(req),
    });
    res.status(204).end();
  }),
);

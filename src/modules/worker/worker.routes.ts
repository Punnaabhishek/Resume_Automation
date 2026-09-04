/**
 * The automation service's API. Authenticated with the shared worker token plus an
 * X-Worker-Id header; every route here is machine-to-machine.
 *
 * Shape of a worker's loop:
 *   POST /worker/runs/claim              -> a run id, or 204
 *   GET  /worker/runs/:id/context        -> profile, resume, filters, exclude list, budget
 *   GET  /worker/runs/:id/credential     -> the password, decrypted and logged, once
 *   POST /worker/runs/:id/session        -> persist storageState after login
 *   POST /worker/runs/:id/applications   -> record each submitted application
 *   POST /worker/runs/:id/exceptions     -> OTP/CAPTCHA/lockout, then stop
 *   GET  /worker/exceptions/:id          -> poll for the code ops entered
 *   POST /worker/runs/:id/finish         -> counters and final status
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { execute, query, queryOne, withTransaction, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { newId, normalizeCompany } from '../../lib/ids';
import { parse } from '../../lib/validate';
import { requireWorker } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import { env } from '../../config/env';
import * as audit from '../audit/audit.service';
import * as credentials from '../credentials/credentials.service';
import { checkEligibility, claimNext, type Portal } from '../runs/runs.service';
import { MIN_ALLOWED_MATCH_SCORE, scoreMatch, thresholdFor } from '../../services/matching';

/** users.key_skills and target_designations are JSON columns; mysql2 may hand back either. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return [];
    }
  }
  return [];
}

interface RunRow extends RowDataPacket {
  id: string;
  user_id: string;
  connection_id: string;
  portal: Portal;
  status: string;
  worker_id: string | null;
  applications_submitted: number;
}

/** Loads the run and refuses if it belongs to a different worker or is already finished. */
async function loadOwnedRun(runId: string, workerId: string): Promise<RunRow> {
  const run = await queryOne<RunRow>('SELECT * FROM automation_runs WHERE id = ?', [runId]);
  if (!run) throw notFound('Run');
  if (run.worker_id !== workerId) throw conflict('This run is assigned to a different worker');
  if (!['claimed', 'running'].includes(run.status)) {
    throw conflict(`Run is ${run.status}; it no longer accepts updates`);
  }
  return run;
}

export const workerRouter = Router();
workerRouter.use(requireWorker);

workerRouter.post(
  '/runs/claim',
  asyncHandler(async (req, res) => {
    const schema = z.object({ portals: z.array(z.enum(['linkedin', 'indeed', 'dice'])).optional() });
    const { portals } = parse(schema, req.body ?? {});

    const runId = await claimNext(req.workerId!, portals);
    if (!runId) {
      res.status(204).end();
      return;
    }
    res.json({ runId });
  }),
);

workerRouter.get(
  '/runs/:id/context',
  asyncHandler(async (req, res) => {
    const run = await loadOwnedRun(param(req, 'id'), req.workerId!);

    // Re-check eligibility at hand-off: consent may have been revoked, or the daily cap
    // reached, between enqueue and claim.
    const eligibility = await checkEligibility(run.user_id, run.portal);
    if (!eligibility.eligible) {
      await execute(
        `UPDATE automation_runs SET status = 'blocked', error_message = ?, finished_at = NOW(3) WHERE id = ?`,
        [eligibility.reasons.join('; '), run.id],
      );
      throw conflict('Account is no longer eligible for this run', { reasons: eligibility.reasons });
    }

    const [user, connection, resume, filters, excluded, appliedIds] = await Promise.all([
      queryOne<RowDataPacket>(
        `SELECT id, full_name, first_name, middle_name, last_name, email, phone,
                country, state, city, timezone,
                target_designations, key_skills, daily_application_cap,
                min_minutes_between_applications, min_match_score
           FROM users WHERE id = ?`,
        [run.user_id],
      ),
      queryOne<RowDataPacket>(
        `SELECT pc.id, pc.portal, pc.credential_id, pc.session_state_path, pc.connection_status,
                p.host AS proxy_host, p.port AS proxy_port, p.username AS proxy_username,
                p.credential_id AS proxy_credential_id, p.country AS proxy_country
           FROM portal_connections pc
           LEFT JOIN proxies p ON p.id = pc.proxy_id
          WHERE pc.id = ?`,
        [run.connection_id],
      ),
      queryOne<RowDataPacket>(
        `SELECT id, file_name, mime_type, storage_path, parsed, raw_text
           FROM resumes WHERE user_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
        [run.user_id],
      ),
      query<RowDataPacket>(
        `SELECT * FROM job_filters
          WHERE user_id = ? AND is_active = 1 AND JSON_CONTAINS(portals, JSON_QUOTE(?))
          ORDER BY priority DESC`,
        [run.user_id, run.portal],
      ),
      query<RowDataPacket>('SELECT company_name, normalized_name FROM excluded_companies WHERE user_id = ?', [
        run.user_id,
      ]),
      query<RowDataPacket>(
        'SELECT portal_job_id FROM applications WHERE user_id = ? AND portal = ?',
        [run.user_id, run.portal],
      ),
    ]);

    await execute(`UPDATE automation_runs SET status = 'running', started_at = NOW(3) WHERE id = ?`, [run.id]);

    res.json({
      runId: run.id,
      portal: run.portal,
      user,
      connection: {
        id: connection?.id,
        status: connection?.connection_status,
        sessionStatePath: connection?.session_state_path,
        // Present so the browser context egresses from the user's own region. The password
        // is fetched separately, through the logged credential route.
        proxy: connection?.proxy_host
          ? {
              host: connection.proxy_host,
              port: connection.proxy_port,
              username: connection.proxy_username,
              credentialId: connection.proxy_credential_id,
              country: connection.proxy_country,
            }
          : null,
      },
      resume: resume
        ? {
            id: resume.id,
            fileName: resume.file_name,
            mimeType: resume.mime_type,
            absolutePath: path.join(env.storage.root, resume.storage_path as string),
            parsed: resume.parsed,
            /** The prose the matcher scores against. Without it nothing can be scored. */
            rawText: resume.raw_text ?? '',
          }
        : null,
      filters,
      excludedCompanies: excluded.map((e) => e.normalized_name),
      /** Already applied to; the worker skips these rather than round-tripping per job. */
      alreadyAppliedJobIds: appliedIds.map((a) => a.portal_job_id),
      budget: {
        remainingToday: eligibility.remainingToday,
        minMinutesBetweenApplications: user?.min_minutes_between_applications ?? env.pacing.defaultMinMinutesBetween,
      },
      /**
       * The bar this run must clear. The worker uses it to avoid opening applications it
       * would only have thrown away; the API re-checks it at the write regardless.
       */
      matching: {
        threshold: thresholdFor(user?.min_match_score),
        minAllowed: MIN_ALLOWED_MATCH_SCORE,
      },
    });
  }),
);

/**
 * Decrypt a credential for this run. Deliberately a separate call from /context: it is the
 * only route in the system that returns a plaintext secret, and it writes an access log row
 * naming the run and worker every time.
 */
workerRouter.get(
  '/runs/:id/credential',
  asyncHandler(async (req, res) => {
    const run = await loadOwnedRun(param(req, 'id'), req.workerId!);
    const kind = req.query.kind === 'proxy' ? 'proxy' : 'portal';

    const connection = await queryOne<RowDataPacket & { credential_id: string | null; proxy_credential_id: string | null }>(
      `SELECT pc.credential_id, p.credential_id AS proxy_credential_id
         FROM portal_connections pc
         LEFT JOIN proxies p ON p.id = pc.proxy_id
        WHERE pc.id = ?`,
      [run.connection_id],
    );
    const credentialId = kind === 'proxy' ? connection?.proxy_credential_id : connection?.credential_id;
    if (!credentialId) throw notFound(`${kind} credential`);

    const { identifier, secret } = await credentials.reveal(credentialId, {
      actorType: 'worker',
      actorId: req.workerId,
      runId: run.id,
      reason: `${kind} login for run ${run.id}`,
      ip: clientIp(req),
    });

    res.set('Cache-Control', 'no-store');
    res.json({ identifier, secret });
  }),
);

/** Persist Playwright storageState so the account keeps one browser profile across runs. */
workerRouter.post(
  '/runs/:id/session',
  asyncHandler(async (req, res) => {
    const run = await loadOwnedRun(param(req, 'id'), req.workerId!);
    const schema = z.object({ storageState: z.record(z.unknown()) });
    const { storageState } = parse(schema, req.body);

    const connection = await queryOne<RowDataPacket & { session_state_path: string | null }>(
      'SELECT session_state_path FROM portal_connections WHERE id = ?',
      [run.connection_id],
    );
    const target = connection?.session_state_path
      ? path.resolve(env.storage.root, connection.session_state_path)
      : path.join(env.storage.sessions, run.user_id, `${run.portal}.json`);

    if (!path.resolve(target).startsWith(path.resolve(env.storage.sessions))) {
      throw badRequest('Session path resolves outside the session store');
    }

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, JSON.stringify(storageState), { mode: 0o600 });

    await execute(
      `UPDATE portal_connections
          SET session_state_path = ?, session_updated_at = NOW(3), last_login_at = NOW(3),
              connection_status = 'connected', status_reason = NULL, consecutive_failures = 0
        WHERE id = ?`,
      [path.relative(env.storage.root, target), run.connection_id],
    );

    res.status(204).end();
  }),
);

const applicationSchema = z.object({
  portalJobId: z.string().min(1).max(190),
  jobTitle: z.string().min(1).max(300),
  company: z.string().min(1).max(200),
  location: z.string().max(200).optional(),
  jobUrl: z.string().max(1000).optional(),
  filterId: z.string().uuid().optional(),
  resumeId: z.string().uuid().optional(),
  appliedAt: z.coerce.date().optional(),
  /**
   * The job's own description, as read from its page. Required, because the score is
   * recomputed here rather than trusted: the worker's score decides whether to open an
   * application at all, but this is the write that matters. A worker that scored generously —
   * through a bug, a stale build, or a selector returning an empty page — must not be able to
   * get a weak match into the record.
   */
  jobDescription: z.string().max(60_000).optional(),
  /** What the worker scored it. Advisory; stored only if it agrees with our own. */
  matchScore: z.number().int().min(0).max(100).optional(),
});

/**
 * Record a submitted application. This is the "bot-confirmed" number the dashboard treats
 * as solid, so the worker must only call it after a submission actually went through.
 *
 * Re-checks the exclude list and the daily cap server-side: the worker was handed both at
 * context time, but this is the write that matters and it is cheap to verify.
 */
workerRouter.post(
  '/runs/:id/applications',
  asyncHandler(async (req, res) => {
    const run = await loadOwnedRun(param(req, 'id'), req.workerId!);
    const input = parse(applicationSchema, req.body);
    const normalized = normalizeCompany(input.company);

    const excluded = await queryOne<RowDataPacket>(
      'SELECT id FROM excluded_companies WHERE user_id = ? AND normalized_name = ?',
      [run.user_id, normalized],
    );
    if (excluded) {
      throw conflict(`"${input.company}" is on this user's exclude list; the application should not have been sent`, {
        company: input.company,
      });
    }

    // --- match score, recomputed here rather than trusted ---------------------------------
    const scoring = await queryOne<
      RowDataPacket & {
        min_match_score: number;
        key_skills: unknown;
        target_designations: unknown;
        raw_text: string | null;
        parsed: { skills?: string[]; yearsExperience?: number | null } | null;
      }
    >(
      `SELECT u.min_match_score, u.key_skills, u.target_designations,
              r.raw_text, r.parsed
         FROM users u
         LEFT JOIN resumes r ON r.user_id = u.id AND r.is_primary = 1
        WHERE u.id = ?
        ORDER BY r.created_at DESC
        LIMIT 1`,
      [run.user_id],
    );

    const threshold = thresholdFor(scoring?.min_match_score);
    const verdict = scoreMatch(
      {
        rawText: scoring?.raw_text ?? '',
        skills: asStringArray(scoring?.parsed?.skills ?? scoring?.key_skills),
        yearsExperience: scoring?.parsed?.yearsExperience ?? null,
        targetDesignations: asStringArray(scoring?.target_designations),
      },
      {
        title: input.jobTitle,
        company: input.company,
        location: input.location ?? null,
        description: input.jobDescription ?? '',
      },
    );

    if (verdict.score < threshold) {
      throw conflict(
        verdict.unscorable
          ? `Could not judge this posting against the resume: ${verdict.unscorable}`
          : `Match score ${verdict.score} is below this user's threshold of ${threshold}; the application should not have been sent`,
        {
          score: verdict.score,
          threshold,
          workerScore: input.matchScore ?? null,
          missingSkills: verdict.missingSkills,
        },
      );
    }

    const result = await withTransaction(async (tx) => {
      const [capRows] = await tx.query<(RowDataPacket & { cap: number; used: number })[]>(
        `SELECT u.daily_application_cap AS cap,
                (SELECT COUNT(*) FROM applications a WHERE a.user_id = u.id AND a.applied_at >= UTC_DATE()) AS used
           FROM users u WHERE u.id = ? FOR UPDATE`,
        [run.user_id],
      );
      const cap = capRows[0];
      if (cap && cap.used >= cap.cap) {
        return { capped: true as const, cap: cap.cap };
      }

      const id = newId();
      const [insert] = await tx.execute<import('mysql2/promise').ResultSetHeader>(
        `INSERT IGNORE INTO applications
           (id, user_id, run_id, filter_id, resume_id, match_score, match_breakdown,
            portal, portal_job_id, job_title, company,
            company_normalized, location, job_url, applied_at, status, status_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', 'bot_confirmed')`,
        [
          id, run.user_id, run.id, input.filterId ?? null, input.resumeId ?? null,
          verdict.score,
          JSON.stringify({
            threshold,
            components: verdict.components,
            matchedSkills: verdict.matchedSkills,
            missingSkills: verdict.missingSkills,
          }),
          run.portal,
          input.portalJobId, input.jobTitle, input.company, normalized,
          input.location ?? null, input.jobUrl ?? null, input.appliedAt ?? new Date(),
        ],
      );

      if (insert.affectedRows === 0) {
        return { duplicate: true as const };
      }

      await tx.execute(
        `INSERT INTO application_status_events (application_id, from_status, to_status, source, observed_at)
         VALUES (?, NULL, 'applied', 'bot_confirmed', ?)`,
        [id, input.appliedAt ?? new Date()],
      );
      await tx.execute(
        'UPDATE automation_runs SET applications_submitted = applications_submitted + 1 WHERE id = ?',
        [run.id],
      );
      await audit.recordIn(tx, {
        userId: run.user_id,
        actorType: 'worker',
        actorId: req.workerId,
        action: 'application.submit',
        entityType: 'application',
        entityId: id,
        metadata: { portal: run.portal, company: input.company, jobTitle: input.jobTitle, runId: run.id },
      });

      return { id, score: verdict.score };
    });

    if ('capped' in result) {
      throw conflict(`Daily cap of ${result.cap} reached; stop applying for this account today`);
    }
    if ('duplicate' in result) {
      res.status(200).json({ duplicate: true });
      return;
    }
    res.status(201).json({ id: result.id, matchScore: result.score, threshold });
  }),
);

/** Batch status updates from re-reading the portal's own applied-jobs view. */
workerRouter.post(
  '/runs/:id/status-sync',
  asyncHandler(async (req, res) => {
    const run = await loadOwnedRun(param(req, 'id'), req.workerId!);
    const schema = z.object({
      updates: z
        .array(
          z.object({
            portalJobId: z.string().min(1),
            status: z.enum(['applied', 'viewed', 'in_consideration', 'interview', 'offer', 'rejected', 'no_response', 'unknown']),
            statusDetail: z.string().max(255).optional(),
            observedAt: z.coerce.date().optional(),
          }),
        )
        .max(500),
    });
    const { updates } = parse(schema, req.body);

    let changed = 0;
    for (const update of updates) {
      const existing = await queryOne<RowDataPacket & { id: string; status: string }>(
        'SELECT id, status FROM applications WHERE user_id = ? AND portal = ? AND portal_job_id = ?',
        [run.user_id, run.portal, update.portalJobId],
      );
      if (!existing) continue;

      await execute('UPDATE applications SET last_checked_at = NOW(3) WHERE id = ?', [existing.id]);
      if (existing.status === update.status) continue;

      // Scraped status never overwrites the bot-confirmed fact that we applied; it only
      // moves the record forward from 'applied'.
      await execute(
        `UPDATE applications
            SET status = ?, status_source = 'portal_scrape', status_detail = ?, last_checked_at = NOW(3)
          WHERE id = ?`,
        [update.status, update.statusDetail ?? null, existing.id],
      );
      await execute(
        `INSERT INTO application_status_events (application_id, from_status, to_status, source, observed_at)
         VALUES (?, ?, ?, 'portal_scrape', ?)`,
        [existing.id, existing.status, update.status, update.observedAt ?? new Date()],
      );
      changed += 1;
    }

    await execute('UPDATE portal_connections SET last_synced_at = NOW(3) WHERE id = ?', [run.connection_id]);
    res.json({ received: updates.length, changed });
  }),
);

/**
 * Raise an exception and stop. This is the wall-hit path: OTP prompt, CAPTCHA, lockout.
 * Nothing here attempts to solve the challenge — it goes to a human.
 */
workerRouter.post(
  '/runs/:id/exceptions',
  asyncHandler(async (req, res) => {
    const run = await loadOwnedRun(param(req, 'id'), req.workerId!);
    const schema = z.object({
      type: z.enum(['otp_required', 'captcha', 'locked_account', 'login_failed', 'session_expired', 'unknown']),
      detail: z.string().max(2000).optional(),
      severity: z.enum(['low', 'normal', 'high']).optional(),
      screenshotPath: z.string().max(500).optional(),
    });
    const input = parse(schema, req.body);

    const user = await queryOne<RowDataPacket & { org_id: string }>('SELECT org_id FROM users WHERE id = ?', [
      run.user_id,
    ]);
    const id = newId();

    await withTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO exception_queue
           (id, org_id, user_id, connection_id, run_id, portal, type, severity, detail, screenshot_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, user!.org_id, run.user_id, run.connection_id, run.id, run.portal,
          input.type, input.severity ?? (input.type === 'locked_account' ? 'high' : 'normal'),
          input.detail ?? null, input.screenshotPath ?? null,
        ],
      );

      const connectionStatus = input.type === 'locked_account' ? 'locked' : 'needs_attention';
      await tx.execute(
        `UPDATE portal_connections
            SET connection_status = ?, status_reason = ?, consecutive_failures = consecutive_failures + 1
          WHERE id = ?`,
        [connectionStatus, input.type, run.connection_id],
      );

      await audit.recordIn(tx, {
        orgId: user!.org_id,
        userId: run.user_id,
        actorType: 'worker',
        actorId: req.workerId,
        action: 'exception.raise',
        entityType: 'exception_queue',
        entityId: id,
        metadata: { type: input.type, portal: run.portal, runId: run.id },
      });
    });

    res.status(201).json({ exceptionId: id });
  }),
);

/**
 * Poll one exception for a resolution. For otp_required this returns the code an ops member
 * entered after the user forwarded it, and clears it in the same read so a code is usable
 * once and cannot be replayed.
 */
workerRouter.get(
  '/exceptions/:id',
  asyncHandler(async (req, res) => {
    interface ExceptionPollRow extends RowDataPacket {
      id: string;
      type: string;
      status: string;
      resolution: string | null;
      response_value: string | null;
      response_expires_at: Date | null;
    }

    const row = await withTransaction(async (tx) => {
      const [rows] = await tx.query<ExceptionPollRow[]>(
        `SELECT id, type, status, resolution, response_value, response_expires_at
           FROM exception_queue WHERE id = ? FOR UPDATE`,
        [param(req, 'id')],
      );
      const exception = rows[0];
      if (!exception) return null;

      const expired = exception.response_expires_at !== null && exception.response_expires_at < new Date();

      // Either way the stored code is cleared: consumed if still valid, discarded if not.
      // A code is therefore usable exactly once and cannot be replayed by a later poll.
      const usable = exception.response_value !== null && !expired;
      if (exception.response_value !== null) {
        await tx.execute('UPDATE exception_queue SET response_value = NULL WHERE id = ?', [exception.id]);
      }

      return {
        id: exception.id,
        type: exception.type,
        status: exception.status,
        resolution: exception.resolution,
        responseValue: usable ? exception.response_value : null,
      };
    });

    if (!row) throw notFound('Exception');
    res.set('Cache-Control', 'no-store');
    res.json(row);
  }),
);

workerRouter.post(
  '/runs/:id/finish',
  asyncHandler(async (req, res) => {
    const run = await loadOwnedRun(param(req, 'id'), req.workerId!);
    const schema = z.object({
      status: z.enum(['succeeded', 'partial', 'failed', 'blocked']),
      jobsSeen: z.number().int().min(0).default(0),
      jobsMatched: z.number().int().min(0).default(0),
      jobsSkippedExcluded: z.number().int().min(0).default(0),
      jobsSkippedDuplicate: z.number().int().min(0).default(0),
      jobsScored: z.number().int().min(0).default(0),
      jobsBelowThreshold: z.number().int().min(0).default(0),
      bestScoreMissed: z.number().int().min(0).max(100).optional(),
      errorMessage: z.string().max(2000).optional(),
    });
    const input = parse(schema, req.body);

    await execute(
      `UPDATE automation_runs
          SET status = ?, jobs_seen = ?, jobs_matched = ?, jobs_skipped_excluded = ?,
              jobs_skipped_duplicate = ?, jobs_scored = ?, jobs_below_threshold = ?,
              best_score_missed = ?, error_message = ?, finished_at = NOW(3)
        WHERE id = ?`,
      [
        input.status, input.jobsSeen, input.jobsMatched, input.jobsSkippedExcluded,
        input.jobsSkippedDuplicate, input.jobsScored, input.jobsBelowThreshold,
        input.bestScoreMissed ?? null, input.errorMessage ?? null, run.id,
      ],
    );

    if (input.status === 'succeeded') {
      await execute(
        `UPDATE portal_connections SET consecutive_failures = 0, last_synced_at = NOW(3) WHERE id = ?`,
        [run.connection_id],
      );
    }

    res.status(204).end();
  }),
);

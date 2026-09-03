/**
 * The automation queue. A run is one pass for one user on one portal.
 *
 * Eligibility is enforced here rather than in the worker, so there is exactly one place
 * that decides whether an account may be acted on. A worker that skipped these checks
 * would still get nothing to do.
 */
import { execute, query, queryOne, withTransaction, type RowDataPacket } from '../../db/pool';
import { newId } from '../../lib/ids';

export type Portal = 'linkedin' | 'indeed' | 'dice';

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  remainingToday: number;
}

interface EligibilityRow extends RowDataPacket {
  user_id: string;
  user_status: string;
  daily_application_cap: number;
  min_minutes_between_applications: number;
  connection_id: string;
  connection_status: string;
  has_credential: number;
  has_consent: number;
  active_filters: number;
  has_resume: number;
  applied_today: number;
  open_blocking_exceptions: number;
  minutes_since_last: number | null;
}

const ELIGIBILITY_SQL = `
  SELECT
    u.id AS user_id,
    u.status AS user_status,
    u.daily_application_cap,
    u.min_minutes_between_applications,
    pc.id AS connection_id,
    pc.connection_status,
    (pc.credential_id IS NOT NULL) AS has_credential,
    (SELECT COUNT(*) FROM consents c
      WHERE c.user_id = u.id AND c.consent_type = 'automated_apply' AND c.revoked_at IS NULL) AS has_consent,
    (SELECT COUNT(*) FROM job_filters f
      WHERE f.user_id = u.id AND f.is_active = 1
        AND JSON_CONTAINS(f.portals, JSON_QUOTE(pc.portal))) AS active_filters,
    (SELECT COUNT(*) FROM resumes r WHERE r.user_id = u.id) AS has_resume,
    (SELECT COUNT(*) FROM applications a
      WHERE a.user_id = u.id AND a.applied_at >= UTC_DATE()) AS applied_today,
    (SELECT COUNT(*) FROM exception_queue e
      WHERE e.user_id = u.id AND e.portal = pc.portal
        AND e.status IN ('open','in_progress')
        AND e.type IN ('locked_account','captcha','login_failed')) AS open_blocking_exceptions,
    (SELECT TIMESTAMPDIFF(MINUTE, MAX(a.applied_at), NOW(3)) FROM applications a
      WHERE a.user_id = u.id) AS minutes_since_last
  FROM users u
  JOIN portal_connections pc ON pc.user_id = u.id
  WHERE u.id = ? AND pc.portal = ?
`;

export async function checkEligibility(userId: string, portal: Portal): Promise<EligibilityResult> {
  const row = await queryOne<EligibilityRow>(ELIGIBILITY_SQL, [userId, portal]);
  if (!row) {
    return { eligible: false, reasons: ['No portal connection for this user and portal'], remainingToday: 0 };
  }

  const reasons: string[] = [];
  if (row.user_status !== 'active') reasons.push(`User status is "${row.user_status}", not active`);
  if (!row.has_consent) reasons.push('No active automated_apply consent on file');
  if (!row.has_credential) reasons.push('Connection has no stored credential');
  if (row.connection_status === 'locked') reasons.push('Portal connection is locked');
  if (row.connection_status === 'disconnected') reasons.push('Portal connection is disconnected');
  if (!row.active_filters) reasons.push('No active job filter targets this portal');
  if (!row.has_resume) reasons.push('No resume on file');
  if (row.open_blocking_exceptions > 0) {
    reasons.push('An open exception is blocking this account (locked, CAPTCHA, or failed login)');
  }

  const remainingToday = Math.max(row.daily_application_cap - row.applied_today, 0);
  if (remainingToday === 0) reasons.push(`Daily cap of ${row.daily_application_cap} already reached`);

  // Pacing: don't fire applications back-to-back.
  if (
    row.minutes_since_last !== null &&
    row.minutes_since_last < row.min_minutes_between_applications
  ) {
    reasons.push(
      `Last application was ${row.minutes_since_last}m ago; minimum spacing is ` +
        `${row.min_minutes_between_applications}m`,
    );
  }

  return { eligible: reasons.length === 0, reasons, remainingToday };
}

export interface EnqueueOptions {
  userId: string;
  portal: Portal;
  triggerSource?: 'schedule' | 'manual' | 'retry';
  scheduledFor?: Date;
  /** Skip eligibility (ops forcing a run). Still refuses without consent. */
  force?: boolean;
}

export interface EnqueueResult {
  runId: string | null;
  skipped?: string[];
}

export async function enqueue(options: EnqueueOptions): Promise<EnqueueResult> {
  const eligibility = await checkEligibility(options.userId, options.portal);

  if (!eligibility.eligible) {
    // Consent is the one check `force` cannot override — acting on an account without
    // recorded authorization is the thing the whole audit trail exists to prevent.
    const consentMissing = eligibility.reasons.some((r) => r.includes('consent'));
    if (!options.force || consentMissing) {
      return { runId: null, skipped: eligibility.reasons };
    }
  }

  const connection = await queryOne<RowDataPacket & { id: string }>(
    'SELECT id FROM portal_connections WHERE user_id = ? AND portal = ?',
    [options.userId, options.portal],
  );
  if (!connection) return { runId: null, skipped: ['No portal connection'] };

  // One in-flight run per user+portal: two workers driving the same account at once is
  // both incoherent and the fastest way to look like a bot.
  const inflight = await queryOne<RowDataPacket>(
    `SELECT id FROM automation_runs
      WHERE user_id = ? AND portal = ? AND status IN ('queued','claimed','running') LIMIT 1`,
    [options.userId, options.portal],
  );
  if (inflight) return { runId: null, skipped: ['A run is already queued or in progress for this account'] };

  const id = newId();
  await execute(
    `INSERT INTO automation_runs (id, user_id, connection_id, portal, trigger_source, scheduled_for)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, options.userId, connection.id, options.portal, options.triggerSource ?? 'manual', options.scheduledFor ?? new Date()],
  );

  return { runId: id };
}

/**
 * Hand the oldest due run to a worker, atomically. `FOR UPDATE SKIP LOCKED` lets several
 * workers poll the same table without handing the same run to two of them.
 */
export async function claimNext(workerId: string, portals?: Portal[]): Promise<string | null> {
  return withTransaction(async (tx) => {
    const portalClause = portals?.length ? `AND portal IN (${portals.map(() => '?').join(',')})` : '';
    const [rows] = await tx.query<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM automation_runs
        WHERE status = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= NOW(3)) ${portalClause}
        ORDER BY scheduled_for ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      portals?.length ? portals : [],
    );

    const run = rows[0];
    if (!run) return null;

    await tx.execute(
      `UPDATE automation_runs SET status = 'claimed', worker_id = ?, claimed_at = NOW(3) WHERE id = ?`,
      [workerId, run.id],
    );
    return run.id;
  });
}

/** Runs stuck in claimed/running past the timeout are returned to the queue. */
export async function reapStaleRuns(timeoutMinutes = 45): Promise<number> {
  const result = await execute(
    `UPDATE automation_runs
        SET status = 'failed',
            error_message = 'Run abandoned: no worker heartbeat within timeout',
            finished_at = NOW(3)
      WHERE status IN ('claimed','running')
        AND COALESCE(started_at, claimed_at) < DATE_SUB(NOW(3), INTERVAL ? MINUTE)`,
    [timeoutMinutes],
  );
  return result.affectedRows;
}

/**
 * Queue a scheduled pass for every account that is currently eligible. Intended to be
 * called by a scheduler (cron/Azure timer), not from an HTTP route.
 */
export async function enqueueDueRuns(): Promise<{ queued: number; skipped: number }> {
  const candidates = await query<RowDataPacket & { user_id: string; portal: Portal }>(
    `SELECT pc.user_id, pc.portal
       FROM portal_connections pc
       JOIN users u ON u.id = pc.user_id
      WHERE u.status = 'active'
        AND pc.connection_status IN ('pending','connected')
        AND pc.credential_id IS NOT NULL`,
  );

  let queued = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const result = await enqueue({
      userId: candidate.user_id,
      portal: candidate.portal,
      triggerSource: 'schedule',
    });
    if (result.runId) queued += 1;
    else skipped += 1;
  }

  return { queued, skipped };
}

/**
 * One run, start to finish. This file owns the decisions; adapters own the selectors.
 *
 *   claim -> context -> (session or login) -> search -> apply* -> status sync -> finish
 *
 * Two rules shape the error handling. A run always reaches POST /finish, including when it
 * throws, because a run left in `running` holds a queue slot and shows up on the dashboard
 * as work in progress that will never complete. And an application is only ever recorded
 * after the adapter confirms a real submission — see PortalAdapter.apply.
 */
import { api, isConflict, type ApplicationInput, type FinishInput, type RunContext } from './api.js';
import { openSession, screenshot, type Session } from './browser.js';
import { config } from './config.js';
import { log, setContext, clearContext } from './log.js';
import { decide, type JobCandidate } from './matching.js';
import { RunClock, pauseBetweenApplications, sleep, think } from './pacing.js';
import { adapterFor } from './portals/index.js';
import type { PortalAdapter } from './portals/types.js';

interface Counters {
  jobsSeen: number;
  jobsMatched: number;
  jobsSkippedExcluded: number;
  jobsSkippedDuplicate: number;
  submitted: number;
}

type LoginFailure = 'otp_required' | 'captcha' | 'locked_account' | 'login_failed' | 'unknown';

/**
 * Raise the exception, then poll until ops supplies the code or we run out of patience.
 * The API clears the stored code on the first read, so a code arrives here exactly once —
 * if we drop it, the run fails rather than silently retrying with a stale value.
 */
async function waitForOtp(runId: string, session: Session): Promise<string | null> {
  const shot = await screenshot(session.page, `otp-${runId}`);
  const exceptionId = await api.raiseException(runId, {
    type: 'otp_required',
    detail: 'Portal requested a verification code at login',
    screenshotPath: shot,
  });
  log.info('raised OTP exception; waiting for ops', { exceptionId });

  const deadline = Date.now() + config.otpWaitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(config.otpPollSeconds * 1000);
    const state = await api.pollException(exceptionId);
    if (state.responseValue) {
      log.info('received verification code from ops', { exceptionId });
      return state.responseValue;
    }
    if (state.status === 'resolved' || state.status === 'cancelled') {
      log.warn('exception closed without a code', { exceptionId, status: state.status });
      return null;
    }
  }
  log.warn('timed out waiting for a verification code', { exceptionId });
  return null;
}

/** Establish a logged-in page, or return the exception type that stopped us. */
async function ensureLoggedIn(
  ctx: RunContext,
  adapter: PortalAdapter,
  session: Session,
): Promise<{ ok: true } | { ok: false; type: LoginFailure; detail?: string }> {
  if (await adapter.isLoggedIn(session.page)) {
    log.info('stored session is still valid; skipping login');
    return { ok: true };
  }

  // Fetched here rather than at run start so the plaintext exists for the shortest window
  // we can manage, and so a run served entirely from a stored session never decrypts at all.
  const { identifier, secret } = await api.credential(ctx.runId, 'portal');
  log.info('logging in', { identifier });

  let outcome = await adapter.login(session.page, identifier, secret);

  if (!outcome.ok && outcome.kind === 'otp_required') {
    const code = await waitForOtp(ctx.runId, session);
    if (!code) return { ok: false, type: 'otp_required', detail: 'No verification code supplied in time' };
    outcome = await adapter.submitOtp(session.page, code);
  }

  if (outcome.ok) return { ok: true };
  return { ok: false, type: outcome.kind, detail: outcome.detail };
}

async function applyToJob(
  ctx: RunContext,
  adapter: PortalAdapter,
  session: Session,
  job: JobCandidate,
  filterId: string,
  counters: Counters,
): Promise<'submitted' | 'skipped' | 'capped'> {
  const outcome = await adapter.apply(session.page, job, ctx.resume?.absolutePath ?? null);

  if (!outcome.ok) {
    log.info('skipped listing', { job: job.portalJobId, kind: outcome.kind, detail: outcome.detail });
    return 'skipped';
  }

  const input: ApplicationInput = {
    portalJobId: job.portalJobId,
    jobTitle: job.jobTitle,
    company: job.company,
    location: job.location,
    jobUrl: job.jobUrl,
    filterId,
    resumeId: ctx.resume?.id,
  };

  try {
    const recorded = await api.recordApplication(ctx.runId, input);
    if (recorded === null) {
      counters.jobsSkippedDuplicate += 1;
      log.info('already recorded; portal served a stale duplicate', { job: job.portalJobId });
      return 'skipped';
    }
    counters.submitted += 1;
    log.info('applied', { company: job.company, title: job.jobTitle, applicationId: recorded.id });
    return 'submitted';
  } catch (err) {
    if (isConflict(err)) {
      const message = (err as Error).message;
      // The submission already happened on the portal; the API is telling us it should not
      // have. That is worth a loud log — it means a client-side guard let something past.
      if (message.includes('exclude list')) {
        counters.jobsSkippedExcluded += 1;
        log.error('submitted to an excluded company; client-side filter missed it', { company: job.company });
        return 'skipped';
      }
      log.warn('daily cap reached; stopping this run', { company: job.company });
      return 'capped';
    }
    throw err;
  }
}

async function workFilters(
  ctx: RunContext,
  adapter: PortalAdapter,
  session: Session,
  counters: Counters,
  clock: RunClock,
): Promise<void> {
  const excluded = new Set(ctx.excludedCompanies);
  const applied = new Set(ctx.alreadyAppliedJobIds);
  let budget = ctx.budget.remainingToday;

  if (budget <= 0) {
    log.info('no budget remaining today; nothing to do');
    return;
  }
  if (!ctx.filters.length) {
    log.warn('user has no active filters for this portal');
    return;
  }

  for (const filter of ctx.filters) {
    if (budget <= 0 || clock.expired) break;
    log.info('working filter', { filter: filter.name, designation: filter.designation });

    for (let pageIndex = 0; pageIndex < config.maxPagesPerFilter; pageIndex += 1) {
      if (budget <= 0 || clock.expired) break;

      const jobs = await adapter.search(session.page, filter, pageIndex);
      if (!jobs.length) break;
      counters.jobsSeen += jobs.length;
      await think();

      for (const job of jobs) {
        if (budget <= 0 || clock.expired) break;

        const verdict = decide(job, filter, excluded, applied);
        if (!verdict.apply) {
          if (verdict.reason === 'excluded_company') counters.jobsSkippedExcluded += 1;
          if (verdict.reason === 'duplicate') counters.jobsSkippedDuplicate += 1;
          continue;
        }
        counters.jobsMatched += 1;

        const result = await applyToJob(ctx, adapter, session, job, filter.id, counters);
        applied.add(job.portalJobId);

        if (result === 'capped') return;
        if (result === 'submitted') {
          budget -= 1;
          if (budget > 0 && !clock.expired) {
            await pauseBetweenApplications(ctx.budget.minMinutesBetweenApplications);
          }
        } else {
          await think();
        }
      }
    }
  }
}

export async function executeRun(runId: string): Promise<void> {
  setContext({ run: runId, worker: config.workerId });
  const clock = new RunClock(config.maxRunMinutes);
  const counters: Counters = {
    jobsSeen: 0,
    jobsMatched: 0,
    jobsSkippedExcluded: 0,
    jobsSkippedDuplicate: 0,
    submitted: 0,
  };

  let session: Session | undefined;
  let finish: FinishInput = { status: 'failed', errorMessage: 'Run did not complete' };
  let alreadyTerminal = false;

  try {
    let ctx: RunContext;
    try {
      ctx = await api.context(runId);
    } catch (err) {
      // The API marks the run blocked itself when eligibility fails at hand-off, so there
      // is nothing left to finish — it is already terminal.
      if (isConflict(err)) {
        log.warn('run is no longer eligible; API marked it blocked', { reason: (err as Error).message });
        alreadyTerminal = true;
        return;
      }
      throw err;
    }

    setContext({ run: runId, worker: config.workerId, portal: ctx.portal, user: ctx.user.id });
    log.info('run context loaded', {
      filters: ctx.filters.length,
      budget: ctx.budget.remainingToday,
      excluded: ctx.excludedCompanies.length,
      resume: ctx.resume?.fileName ?? 'none',
    });

    const adapter = adapterFor(config.forceAdapter ?? ctx.portal);
    if (config.forceAdapter) log.warn('adapter overridden', { adapter: config.forceAdapter, runPortal: ctx.portal });

    let proxyPassword: string | undefined;
    if (ctx.connection.proxy?.credentialId) {
      proxyPassword = (await api.credential(runId, 'proxy')).secret;
    }

    session = await openSession(ctx, proxyPassword);

    const login = await ensureLoggedIn(ctx, adapter, session);
    if (!login.ok) {
      const shot = await screenshot(session.page, `${login.type}-${runId}`);
      // otp_required already has its exception row from waitForOtp; do not raise a second.
      if (login.type !== 'otp_required') {
        await api.raiseException(runId, { type: login.type, detail: login.detail, screenshotPath: shot });
      }
      finish = {
        status: 'blocked',
        errorMessage: `${login.type}: ${login.detail ?? 'login could not complete'}`,
        jobsSeen: 0,
        jobsMatched: 0,
        jobsSkippedExcluded: 0,
        jobsSkippedDuplicate: 0,
      };
      return;
    }

    // Persist immediately after a successful login, before doing anything that might crash.
    // A saved profile is what keeps the next run from triggering another device check.
    await api.saveSession(runId, await session.snapshot());
    log.info('session persisted');

    await workFilters(ctx, adapter, session, counters, clock);

    if (adapter.syncStatuses) {
      try {
        const updates = await adapter.syncStatuses(session.page);
        if (updates.length) {
          const result = await api.statusSync(runId, updates);
          log.info('status sync complete', result);
        }
      } catch (err) {
        // Never fails the run: the applications are the fact, statuses are an extra.
        log.warn('status sync failed', { error: (err as Error).message });
      }
    }

    finish = {
      status: 'succeeded',
      jobsSeen: counters.jobsSeen,
      jobsMatched: counters.jobsMatched,
      jobsSkippedExcluded: counters.jobsSkippedExcluded,
      jobsSkippedDuplicate: counters.jobsSkippedDuplicate,
    };
    if (clock.expired) {
      finish.status = 'partial';
      finish.errorMessage = 'Run hit the per-run time ceiling';
    }
  } catch (err) {
    const message = (err as Error).message;
    log.error('run failed', { error: message });
    if (session) await screenshot(session.page, `failure-${runId}`);
    finish = {
      status: 'failed',
      errorMessage: message.slice(0, 2000),
      jobsSeen: counters.jobsSeen,
      jobsMatched: counters.jobsMatched,
      jobsSkippedExcluded: counters.jobsSkippedExcluded,
      jobsSkippedDuplicate: counters.jobsSkippedDuplicate,
    };
  } finally {
    if (session) await session.close();
    if (!alreadyTerminal) {
      try {
        await api.finish(runId, finish);
        log.info('run finished', { status: finish.status, submitted: counters.submitted });
      } catch (err) {
        log.error('could not report run completion', { error: (err as Error).message });
      }
    }
    clearContext();
  }
}

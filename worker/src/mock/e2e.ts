/**
 * Offline end-to-end test for the worker.
 *
 * Drives the real run loop — the same executeRun() that production uses — against the local
 * mock portal, and asserts on both sides of the ledger: what the portal actually received,
 * and what the API recorded. Those two agreeing is the property that matters. A worker that
 * reports applications it did not send is the worst failure this system can have, because
 * the number reaches a job seeker as fact.
 *
 * Needs: MySQL up, migrations applied, the API running, and `npm run seed` for the ops login.
 *
 *   cd .. && docker compose up -d && npm run migrate && npm run seed && npm run dev
 *   cd worker && npm run e2e
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SAMPLE_JOBS, startMockPortal, type MockServer } from './server.js';

const API = (process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
const OPS_EMAIL = process.env.E2E_OPS_EMAIL ?? 'ops@example.com';
const OPS_PASSWORD = process.env.E2E_OPS_PASSWORD ?? 'ChangeMe123!';

const PORTAL_PASSWORD = 'mock-portal-p@ssw0rd';
const OTP_CODE = '482913';
const MOCK_PORT = 4310;
/** Low enough that the cap fires inside the sample job set, so the guard is exercised. */
const DAILY_CAP = 3;

const suffix = crypto.randomBytes(4).toString('hex');
const seekerEmail = `worker-e2e-${suffix}@example.com`;

let opsToken = '';

async function call<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (opsToken) headers.authorization = `Bearer ${opsToken}`;
  // FormData sets its own multipart content-type, boundary included; do not override it.
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

const steps: { name: string; run: () => Promise<void> }[] = [];
const step = (name: string, run: () => Promise<void>) => steps.push({ name, run });

const state = {
  userId: '',
  connectionId: '',
  filterId: '',
  runId: '',
  exceptionId: '',
};

let mock: MockServer | undefined;
/** Resolves when executeRun returns, so the OTP step can run while the worker is blocked. */
let workerDone: Promise<void> | undefined;

step('ops can log in', async () => {
  const res = await call('POST', '/auth/login', { email: OPS_EMAIL, password: OPS_PASSWORD });
  assert.equal(res.status, 200, `seed login failed — run "npm run seed" in the API first: ${JSON.stringify(res.body)}`);
  opsToken = res.body.token;
});

step('provision a job seeker with an exclude list and consents', async () => {
  const user = await call('POST', '/users', {
    fullName: 'Worker E2E Seeker',
    email: seekerEmail,
    country: 'US',
    state: 'Texas',
    city: 'Austin',
    timezone: 'UTC',
    targetDesignations: ['Senior Backend Engineer'],
    keySkills: ['Node.js', 'TypeScript', 'MySQL', 'Redis', 'Docker', 'Kubernetes', 'AWS', 'GraphQL'],
    intakeChannel: 'whatsapp',
    dailyApplicationCap: DAILY_CAP,
    // Zero so the test does not sit through the real inter-application pacing.
    minMinutesBetweenApplications: 0,
    excludedCompanies: [{ companyName: 'Blocked Industries Inc', reason: 'competitor' }],
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  state.userId = user.body.id;

  for (const consentType of ['credential_storage', 'automated_apply', 'data_processing']) {
    const res = await call('POST', `/users/${state.userId}/consents`, {
      consentType,
      version: 'v1',
      capturedVia: 'signed form',
      evidenceRef: 'worker-e2e://form',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
});

step('store the portal credential in the vault', async () => {
  // portal must be one the schema allows; the adapter is overridden to the mock below.
  const res = await call('POST', `/users/${state.userId}/connections`, {
    portal: 'dice',
    username: seekerEmail,
    password: PORTAL_PASSWORD,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  state.connectionId = res.body.id;
  assert.ok(!JSON.stringify(res.body).includes(PORTAL_PASSWORD), 'connection response leaked the password');
});

step('upload a resume', async () => {
  // The API refuses to queue a run for a user with no resume on file, and the adapters
  // need a real path on disk to hand to the portal's file input.
  // Substantial on purpose. The matcher scores the prose, and refuses to score a document
  // shorter than 200 characters at all — a three-line stub would score every posting zero
  // and leave this suite asserting nothing.
  const resume = [
    'Worker E2E Seeker — Senior Backend Engineer, Austin TX',
    `${seekerEmail} | +1 512 555 0142`,
    '',
    'Summary',
    'Senior Backend Engineer with 9 years of experience.',
    'Builds and operates production APIs; 9 years building and operating production APIs,',
    'distributed services and data pipelines on AWS. Deep experience with Node.js and',
    'TypeScript, relational data modelling in MySQL, containerised deployment with',
    'Docker and Kubernetes, caching with Redis, and event-driven architecture.',
    '',
    'Experience',
    'Acme Corp — Senior Backend Engineer',
    '  Owned billing and entitlements services in Node.js and TypeScript. Designed the',
    '  MySQL schema, ran migrations, operated the services on Kubernetes in AWS, and',
    '  built REST and GraphQL APIs consumed by web and mobile clients. Mentored engineers',
    '  and led technical design for distributed systems and microservices.',
    'Globex Inc — Backend Engineer',
    '  Built the internal reporting API and its pipeline. Redis caching, CI/CD, testing.',
    '',
    'Skills',
    'Node.js, TypeScript, JavaScript, MySQL, Redis, Docker, Kubernetes, AWS, REST,',
    'GraphQL, CI/CD, microservices, distributed systems',
  ].join('\n');

  const form = new FormData();
  form.append('resume', new Blob([resume], { type: 'text/plain' }), 'resume.txt');
  form.append('isPrimary', 'true');

  const res = await call('POST', `/users/${state.userId}/resumes`, form);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  // If this is ever false the whole matching suite silently degrades into "nothing scored".
  assert.ok(
    resume.length > 400,
    `resume fixture is only ${resume.length} chars; too short to score against`,
  );
});

step('create a filter and activate the user', async () => {
  const filter = await call('POST', `/users/${state.userId}/filters`, {
    name: 'Backend',
    designation: 'Senior Backend Engineer',
    keywords: ['node.js', 'backend'],
    excludedKeywords: ['internship'],
    locations: ['United States'],
    seniority: 'senior',
    portals: ['dice'],
  });
  assert.equal(filter.status, 201, JSON.stringify(filter.body));
  state.filterId = filter.body.id;

  const activate = await call('PATCH', `/users/${state.userId}`, { status: 'active' });
  assert.equal(activate.status, 200, JSON.stringify(activate.body));
});

step('start the mock portal, demanding device verification at login', async () => {
  mock = await startMockPortal({
    port: MOCK_PORT,
    email: seekerEmail,
    password: PORTAL_PASSWORD,
    requireOtp: true,
    otpCode: OTP_CODE,
    jobs: SAMPLE_JOBS,
  });

  // The worker reads its config at import time, so these must be set before it is loaded.
  process.env.WORKER_FORCE_ADAPTER = 'mock';
  process.env.WORKER_MOCK_BASE_URL = mock.url;
  process.env.WORKER_HEADLESS = 'true';
  process.env.WORKER_OTP_POLL_SECONDS = '2';
  process.env.WORKER_OTP_WAIT_SECONDS = '90';
});

step('enqueue a run and let the worker claim it', async () => {
  const run = await call('POST', '/runs', { userId: state.userId, portal: 'dice' });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  state.runId = run.body.runId;
  assert.ok(state.runId, `enqueue returned no runId: ${JSON.stringify(run.body)}`);

  const { api } = await import('../api.js');
  const claimed = await api.claimRun(['dice']);
  assert.equal(claimed, state.runId, 'worker should have claimed the run we just enqueued');

  const { executeRun } = await import('../run.js');
  workerDone = executeRun(state.runId);
});

step('worker raises an OTP exception; ops answers it', async () => {
  // Poll rather than sleep a fixed amount: the browser launch dominates and varies.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !state.exceptionId) {
    const res = await call('GET', '/exceptions?status=active');
    const match = (res.body?.data ?? []).find((e: any) => e.runId === state.runId);
    if (match) {
      assert.equal(match.type, 'otp_required', `unexpected exception type: ${match.type} — ${match.detail}`);
      state.exceptionId = match.id;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(state.exceptionId, 'worker never raised an OTP exception');

  const claimed = await call('POST', `/exceptions/${state.exceptionId}/claim`);
  assert.ok([200, 204].includes(claimed.status), JSON.stringify(claimed.body));

  const responded = await call('POST', `/exceptions/${state.exceptionId}/respond`, { code: OTP_CODE });
  assert.ok([200, 204].includes(responded.status), JSON.stringify(responded.body));
});

step('the run completes', async () => {
  assert.ok(workerDone, 'worker was never started');
  await workerDone;
});

step('the portal received exactly the applications the API recorded', async () => {
  // Expected from SAMPLE_JOBS under this filter, a cap of 3, and a 95 match threshold:
  //   mock-1 applied  — scores 98
  //   mock-2 applied  — scores 95, exactly at the bar
  //   mock-3 skipped  — Blocked Industries is on the exclude list
  //   mock-4 skipped  — "internship" is an excluded keyword
  //   mock-5 SKIPPED  — scores 87, below the bar
  //   mock-6 skipped  — a frontend design role; nowhere near
  //
  // Note what the binding constraint is here: the run stopped at 2 because only 2 postings
  // cleared the bar, not because the cap of 3 was reached. That is the whole point of the
  // threshold — the cap is a ceiling, never a target to be filled by lowering standards.
  const expected = ['mock-1', 'mock-2'];

  assert.deepEqual(mock!.applied, expected, `mock portal received: ${mock!.applied.join(', ')}`);

  const recorded = await call('GET', `/applications?userId=${state.userId}`);
  assert.equal(recorded.status, 200);
  const rows = recorded.body?.data ?? [];

  // The applications presenter does not expose portalJobId, so recover it from jobUrl —
  // which the adapter set from the listing's own link.
  const recordedIds = rows
    .map((r: any) => String(r.jobUrl ?? '').match(/\/job\/([\w-]+)/)?.[1])
    .filter(Boolean)
    .sort();

  assert.deepEqual(recordedIds, [...expected].sort(), 'API records must match what the portal received');

  // The mock's applied-jobs view reports mock-2 as "viewed", so status sync moves that one
  // forward. The other two are untouched. This is the honest-sourcing rule in action: a
  // status we watched happen is bot_confirmed, a status we read off the portal is
  // portal_scrape, and the two are never conflated.
  const byId = new Map<string, any>(
    rows
      .map((r: any) => [String(r.jobUrl ?? '').match(/\/job\/([\w-]+)/)?.[1], r] as const)
      .filter((entry: readonly [string | undefined, any]): entry is readonly [string, any] => entry[0] !== undefined)
      .map((entry: readonly [string, any]) => [entry[0], entry[1]] as [string, any]),
  );

  for (const id of ['mock-1']) {
    const row = byId.get(id);
    assert.ok(row, `${id} missing from applications`);
    assert.equal(row.status, 'applied', `${id} should still be 'applied'`);
    assert.equal(row.statusSource, 'bot_confirmed', `${id} must be recorded as bot_confirmed`);
  }

  const scraped = byId.get('mock-2');
  assert.ok(scraped, 'mock-2 missing from applications');
  assert.equal(scraped.status, 'viewed', 'status sync should have moved mock-2 forward');
  assert.equal(scraped.statusSource, 'portal_scrape', 'a scraped status must not claim to be bot_confirmed');
});

step('the excluded company was never applied to', async () => {
  assert.ok(!mock!.applied.includes('mock-3'), 'worker applied to a company on the exclude list');
  const recorded = await call('GET', `/applications?userId=${state.userId}`);
  const rows = recorded.body?.data ?? [];
  assert.ok(
    !rows.some((r: any) => /blocked industries/i.test(r.company ?? '')),
    'an excluded company reached the applications table',
  );
});

step('the run is finished with honest counters', async () => {
  const res = await call('GET', `/runs?userId=${state.userId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const run = (res.body?.data ?? []).find((r: any) => r.id === state.runId);
  assert.ok(run, 'run not found in the runs list');

  assert.ok(['succeeded', 'partial'].includes(run.status), `run ended as ${run.status}: ${run.errorMessage ?? ''}`);
  assert.equal(
    run.counters.applicationsSubmitted,
    2,
    'only the postings clearing the 95 threshold should have been applied to',
  );
  assert.ok(run.counters.jobsSeen >= 5, `jobsSeen should cover the first result page, got ${run.counters.jobsSeen}`);
  assert.ok(run.counters.jobsSkippedExcluded >= 1, 'the excluded company should be counted as skipped');
  assert.ok(run.counters.jobsScored >= 3, `expected postings to be read and scored, got ${run.counters.jobsScored}`);
  assert.ok(
    run.counters.jobsBelowThreshold >= 1,
    'a posting below the bar should be counted, or the threshold is not doing anything',
  );
  assert.ok(
    run.counters.bestScoreMissed > 0 && run.counters.bestScoreMissed < 95,
    `the closest miss should be recorded and below the bar, got ${run.counters.bestScoreMissed}`,
  );
  assert.ok(run.finishedAt, 'run must be finished, not left running');
  assert.equal(run.workerId, process.env.WORKER_ID ?? `worker-${process.pid}`);
});

step('the browser session was persisted for reuse', async () => {
  const res = await call('GET', `/users/${state.userId}/connections`);
  const connection = (res.body?.data ?? []).find((c: any) => c.id === state.connectionId);
  assert.ok(connection, 'connection not found');
  assert.equal(connection.status, 'connected');
  assert.equal(
    connection.hasPersistedSession,
    true,
    'storageState was never persisted; the next run would trigger another device check',
  );
  assert.ok(connection.sessionUpdatedAt, 'session timestamp not recorded');
  assert.equal(connection.consecutiveFailures, 0);
});

step('a second run reuses the stored session instead of logging in again', async () => {
  // This is the property that keeps accounts alive. If every run logged in fresh, every run
  // would trip a new-device check, and the OTP queue would be the whole system.
  const raise = await call('PATCH', `/users/${state.userId}`, { dailyApplicationCap: DAILY_CAP + 2 });
  assert.equal(raise.status, 200, JSON.stringify(raise.body));

  const run = await call('POST', '/runs', { userId: state.userId, portal: 'dice' });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const secondRunId = run.body.runId;

  const { api } = await import('../api.js');
  assert.equal(await api.claimRun(['dice']), secondRunId);

  const before = mock!.applied.length;
  const { executeRun } = await import('../run.js');
  await executeRun(secondRunId);

  // No new OTP exception: the mock still demands verification on a fresh login, so if the
  // stored session had not been reused this run would have blocked exactly like the first.
  const exceptions = await call('GET', '/exceptions?status=active');
  const raised = (exceptions.body?.data ?? []).filter((e: any) => e.runId === secondRunId);
  assert.equal(raised.length, 0, 'second run logged in again instead of reusing the session');

  // Deliberately NOT asserting that more applications happened. Everything left in the
  // sample set is below the bar, so the correct outcome of a second run with more budget is
  // that it still applies to nothing. Raising the cap must not lower the standard.
  assert.equal(
    mock!.applied.length,
    before,
    `second run applied to something below the threshold: ${mock!.applied.join(', ')}`,
  );
});

step('the fixtures clean up after themselves', async () => {
  // Without this, every run of this suite leaves an in_progress OTP exception and an active
  // job seeker behind, and the real exception queue fills up with test rows that look
  // exactly like work waiting on a human.
  if (state.exceptionId) {
    const res = await call('POST', `/exceptions/${state.exceptionId}/resolve`, {
      resolution: 'cleared_manually',
      note: 'worker e2e fixture',
    });
    assert.ok([200, 204, 409].includes(res.status), JSON.stringify(res.body));
  }
  const stop = await call('PATCH', `/users/${state.userId}`, { status: 'offboarded' });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
});

step('decrypting the portal password was logged against this worker', async () => {
  const res = await call('GET', `/connections/${state.connectionId}/credential-access`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body?.data ?? [];

  const byWorker = rows.filter((r: any) => r.actorType === 'worker' || r.actor_type === 'worker');
  assert.ok(byWorker.length >= 1, 'the worker decrypted a password but no access log row was written');
});

async function main(): Promise<void> {
  let passed = 0;
  let failed = false;

  for (const s of steps) {
    try {
      await s.run();
      passed += 1;
      console.log(`  ok    ${s.name}`);
    } catch (err) {
      failed = true;
      console.error(`  FAIL  ${s.name}`);
      console.error(`        ${(err as Error).message}`);
      break; // later steps depend on earlier ones; continuing would only add noise
    }
  }

  if (mock) await mock.close();

  console.log(`\n${passed}/${steps.length} steps passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  if (mock) await mock.close();
  process.exit(1);
});

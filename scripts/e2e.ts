/**
 * End-to-end test against a real MySQL. Drives the full intake -> provision -> queue ->
 * worker -> exception -> report path over HTTP, and asserts the guarantees the README
 * claims: consent gating, no plaintext leaving the vault, exclude-list and daily-cap
 * enforcement at the write, single-use OTP codes, and honest status sourcing.
 *
 *   docker compose up -d
 *   npm run migrate
 *   npx tsx scripts/e2e.ts
 *
 * Creates its own org-scoped fixtures under a unique email and cleans them up at the end.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app';
import { closePool, execute, queryOne, type RowDataPacket } from '../src/db/pool';
import { hashPassword } from '../src/lib/password';
import { newId } from '../src/lib/ids';

const PORTAL_PASSWORD = 'sup3r-s3cret-linkedin-p@ss';
const WORKER_TOKEN = process.env.WORKER_API_TOKEN!;
const WORKER_ID = 'e2e-worker-1';

let base = '';
let memberToken = '';

interface Res<T> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; worker?: boolean; raw?: FormData } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (options.worker) {
    headers.authorization = `Bearer ${WORKER_TOKEN}`;
    headers['x-worker-id'] = WORKER_ID;
  } else if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  } else if (memberToken) {
    headers.authorization = `Bearer ${memberToken}`;
  }

  let payload: string | FormData | undefined;
  if (options.raw) {
    payload = options.raw;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}


/**
 * A posting that genuinely matches the résumé fixture. Applications now carry a match score
 * that the API recomputes at the write, so a worker call without a real description scores
 * zero and is refused — which is the point of the feature, and means every application in
 * this suite has to look like a real one.
 */
const MATCHING_DESCRIPTION = [
  'We are hiring a Senior Backend Engineer to own our core services platform.',
  'You will design, build and operate production APIs serving millions of requests a day.',
  'Responsibilities: build and maintain backend services in Node.js and TypeScript;',
  'model and evolve data in MySQL; deploy and operate services with Docker on AWS;',
  'build REST APIs for web and mobile clients; mentor engineers and lead technical',
  'design for distributed systems. Requirements: 5+ years of professional backend',
  'engineering experience, deep knowledge of Node.js, TypeScript and relational',
  'databases, production experience with Docker and AWS, and a strong grounding in',
  'microservices and distributed systems architecture.',
].join(' ');

const steps: { name: string; run: () => Promise<void> }[] = [];
const step = (name: string, run: () => Promise<void>) => steps.push({ name, run });

// Fixtures shared across steps.
const suffix = crypto.randomBytes(4).toString('hex');
const state = {
  orgId: '',
  memberId: '',
  userId: '',
  connectionId: '',
  credentialId: '',
  resumeId: '',
  filterId: '',
  runId: '',
  exceptionId: '',
};

step('bootstrap: org and owner member exist', async () => {
  state.orgId = newId();
  state.memberId = newId();
  await execute('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)', [
    state.orgId,
    `E2E Org ${suffix}`,
    `e2e-${suffix}`,
  ]);
  await execute(
    `INSERT INTO org_members (id, org_id, email, password_hash, full_name, role)
     VALUES (?, ?, ?, ?, 'E2E Owner', 'owner')`,
    [state.memberId, state.orgId, `e2e-${suffix}@example.com`, await hashPassword('E2ePassword!1')],
  );
});

step('login rejects a wrong password, accepts the right one', async () => {
  const bad = await call('POST', '/api/v1/auth/login', {
    body: { email: `e2e-${suffix}@example.com`, password: 'wrong' },
  });
  assert.equal(bad.status, 401);

  const ok = await call('POST', '/api/v1/auth/login', {
    body: { email: `e2e-${suffix}@example.com`, password: 'E2ePassword!1' },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  memberToken = ok.body.token;

  const me = await call('GET', '/api/v1/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'owner');
});

step('create a job seeker with an exclude list captured at intake', async () => {
  const res = await call('POST', '/api/v1/users', {
    body: {
      fullName: 'E2E Seeker',
      email: `seeker-${suffix}@example.com`,
      country: 'US',
      state: 'Texas',
      city: 'Austin',
      timezone: 'UTC',
      targetDesignations: ['Senior Backend Engineer'],
      keySkills: ['Node.js', 'MySQL'],
      intakeChannel: 'whatsapp',
      dailyApplicationCap: 3,
      minMinutesBetweenApplications: 0,
      excludedCompanies: [
        { companyName: 'Acme Technologies Pvt. Ltd.', reason: 'current_employer' },
        { companyName: 'Globex Corporation', reason: 'competitor' },
      ],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  state.userId = res.body.id;
  assert.equal(res.body.status, 'intake');
  assert.equal(res.body.pacing.dailyApplicationCap, 3);
});

step('provisioning a connection is refused without credential_storage consent', async () => {
  const res = await call('POST', `/api/v1/users/${state.userId}/connections`, {
    body: { portal: 'linkedin', username: `seeker-${suffix}@example.com`, password: PORTAL_PASSWORD },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error.message, /consent/i);
});

step('record consents, then provisioning succeeds and returns no secret', async () => {
  for (const consentType of ['credential_storage', 'automated_apply', 'data_processing']) {
    const res = await call('POST', `/api/v1/users/${state.userId}/consents`, {
      body: { consentType, version: 'v1', capturedVia: 'signed form', evidenceRef: 'e2e://form' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const res = await call('POST', `/api/v1/users/${state.userId}/connections`, {
    body: { portal: 'linkedin', username: `seeker-${suffix}@example.com`, password: PORTAL_PASSWORD },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  state.connectionId = res.body.id;

  assert.equal(res.body.hasCredential, true);
  // The response must describe the credential without disclosing it.
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(PORTAL_PASSWORD), 'connection response must not contain the password');
  assert.ok(!('password' in res.body), 'connection response must not carry a password field');

  // Auto-assigned a proxy in the user's own country, if the pool has one.
  const proxy = await queryOne<RowDataPacket & { country: string }>(
    'SELECT p.country FROM portal_connections pc JOIN proxies p ON p.id = pc.proxy_id WHERE pc.id = ?',
    [state.connectionId],
  );
  if (proxy) assert.equal(proxy.country, 'US');
});

step('the stored password is ciphertext at rest', async () => {
  const row = await queryOne<RowDataPacket & { credential_id: string }>(
    'SELECT credential_id FROM portal_connections WHERE id = ?',
    [state.connectionId],
  );
  state.credentialId = row!.credential_id;

  const cred = await queryOne<RowDataPacket & { ciphertext: Buffer; identifier: string }>(
    'SELECT ciphertext, identifier FROM credentials WHERE id = ?',
    [state.credentialId],
  );
  assert.ok(cred, 'credential row should exist');
  assert.ok(
    !cred!.ciphertext.toString('utf8').includes(PORTAL_PASSWORD),
    'password must not be readable in the credentials table',
  );
  assert.equal(cred!.identifier, `seeker-${suffix}@example.com`);
});

step('no dashboard route exposes the password', async () => {
  const detail = await call('GET', `/api/v1/users/${state.userId}`);
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.body).includes(PORTAL_PASSWORD));

  const list = await call('GET', `/api/v1/users/${state.userId}/connections`);
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(PORTAL_PASSWORD));

  // What ops can see instead: who decrypted it, and when.
  const access = await call('GET', `/api/v1/connections/${state.connectionId}/credential-access`);
  assert.equal(access.status, 200);
  assert.equal(access.body.data[0].action, 'create');
});

step('upload and parse a resume', async () => {
  // Substantial on purpose: the matcher refuses to score a document under 200 characters,
  // so a stub here would make every application in this suite score zero and be refused —
  // and the cap and exclude-list assertions below would then pass for the wrong reason.
  const resume = [
    'E2E Seeker — Senior Backend Engineer, Austin TX',
    'seeker@example.com | +1 512 555 0142',
    '',
    'Summary',
    'Senior Backend Engineer with 9 years of experience.',
    'Builds and operates production APIs; 9 years building and operating production APIs and',
    'distributed services on AWS. Deep experience with Node.js and TypeScript, relational',
    'data modelling in MySQL, and containerised deployment with Docker.',
    '',
    'Experience',
    'Acme Corp — Senior Backend Engineer',
    '  Owned billing services in Node.js and TypeScript. Designed the MySQL schema, ran',
    '  migrations, operated services on AWS, and built REST APIs for web and mobile',
    '  clients. Mentored engineers and led design for distributed systems.',
    'Globex Inc — Backend Engineer',
    '  Built the internal reporting API and pipeline. CI/CD, testing, observability.',
    '',
    'Skills',
    'Node.js, TypeScript, JavaScript, MySQL, Docker, AWS, REST, CI/CD, microservices,',
    'distributed systems',
  ].join('\n');

  const form = new FormData();
  form.append('resume', new Blob([resume], { type: 'text/plain' }), 'resume.txt');
  form.append('isPrimary', 'true');

  const res = await call('POST', `/api/v1/users/${state.userId}/resumes`, { raw: form });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  state.resumeId = res.body.id;
  assert.equal(res.body.parseStatus, 'parsed', res.body.parseError ?? '');
  // A range rather than an exact number: the fixture now contains employment date ranges as
  // well as a stated figure, and pinning this to one value makes any future wording change
  // look like a parser regression when it is not.
  assert.ok(
    typeof res.body.parsed.yearsExperience === 'number' && res.body.parsed.yearsExperience >= 5,
    `expected a plausible years-of-experience figure, got ${res.body.parsed.yearsExperience}`,
  );
  assert.ok(res.body.parsed.skills.includes('Node.js'));

  // The matcher scores the prose, not the extracted skill list, so the full text has to be
  // stored. Without this the whole matching path degrades to "nothing is ever scorable".
  const stored = await queryOne<RowDataPacket & { len: number }>(
    "SELECT CHAR_LENGTH(COALESCE(raw_text, '')) AS len FROM resumes WHERE id = ?",
    [state.resumeId],
  );
  assert.ok(
    Number(stored!.len) > 400,
    `resume raw_text is ${stored!.len} characters; too short for the matcher to use`,
  );
});

step('create a filter targeting linkedin', async () => {
  const res = await call('POST', `/api/v1/users/${state.userId}/filters`, {
    body: {
      name: 'Backend',
      designation: 'Senior Backend Engineer',
      keywords: ['node.js', 'backend'],
      locations: ['Austin', 'Remote'],
      seniority: 'senior',
      portals: ['linkedin'],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  state.filterId = res.body.id;
});

step('an intake-status user is not yet eligible; activating makes them eligible', async () => {
  const before = await call('GET', `/api/v1/runs/eligibility?userId=${state.userId}&portal=linkedin`);
  assert.equal(before.status, 200);
  assert.equal(before.body.eligible, false);
  assert.ok(before.body.reasons.some((r: string) => /not active/i.test(r)), JSON.stringify(before.body.reasons));

  const activate = await call('PATCH', `/api/v1/users/${state.userId}`, { body: { status: 'active' } });
  assert.equal(activate.status, 200);

  const after = await call('GET', `/api/v1/runs/eligibility?userId=${state.userId}&portal=linkedin`);
  assert.equal(after.body.eligible, true, JSON.stringify(after.body.reasons));
  assert.equal(after.body.remainingToday, 3);
});

step('queue a run; a second is refused while one is in flight', async () => {
  const res = await call('POST', '/api/v1/runs', { body: { userId: state.userId, portal: 'linkedin' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  state.runId = res.body.runId;

  const duplicate = await call('POST', '/api/v1/runs', { body: { userId: state.userId, portal: 'linkedin' } });
  assert.equal(duplicate.status, 409);
  assert.ok(JSON.stringify(duplicate.body).match(/already queued or in progress/i));
});

step('worker claims the run and receives its context', async () => {
  const claim = await call('POST', '/api/v1/worker/runs/claim', { worker: true, body: { portals: ['linkedin'] } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.runId, state.runId);

  const context = await call('GET', `/api/v1/worker/runs/${state.runId}/context`, { worker: true });
  assert.equal(context.status, 200, JSON.stringify(context.body));

  assert.equal(context.body.user.full_name, 'E2E Seeker');
  assert.equal(context.body.filters.length, 1);
  assert.equal(context.body.budget.remainingToday, 3);
  assert.ok(context.body.resume.absolutePath.endsWith('.txt'));

  // Exclude list arrives normalized, so worker-side matching agrees with the server's.
  assert.deepEqual(context.body.excludedCompanies.sort(), ['acme technologies', 'globex']);

  // Context must not carry the secret; that is a separate, logged call.
  assert.ok(!JSON.stringify(context.body).includes(PORTAL_PASSWORD));
});

step('another worker cannot touch a run it does not own', async () => {
  const res = await fetch(`${base}/api/v1/worker/runs/${state.runId}/context`, {
    headers: { authorization: `Bearer ${WORKER_TOKEN}`, 'x-worker-id': 'someone-else' },
  });
  assert.equal(res.status, 409);
});

step('worker decrypts the credential, and the access is logged', async () => {
  const res = await call('GET', `/api/v1/worker/runs/${state.runId}/credential`, { worker: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.secret, PORTAL_PASSWORD, 'round-trip through the vault must be exact');
  assert.equal(res.body.identifier, `seeker-${suffix}@example.com`);

  const log = await queryOne<RowDataPacket & { actor_id: string; run_id: string }>(
    `SELECT actor_id, run_id FROM credential_access_log
      WHERE credential_id = ? AND action = 'decrypt' ORDER BY created_at DESC LIMIT 1`,
    [state.credentialId],
  );
  assert.ok(log, 'a decrypt must produce an access log row');
  assert.equal(log!.actor_id, WORKER_ID);
  assert.equal(log!.run_id, state.runId);
});

step('worker persists the session so the profile survives between runs', async () => {
  const res = await call('POST', `/api/v1/worker/runs/${state.runId}/session`, {
    worker: true,
    body: { storageState: { cookies: [{ name: 'li_at', value: 'x' }], origins: [] } },
  });
  assert.equal(res.status, 204);

  const row = await queryOne<RowDataPacket & { connection_status: string; session_state_path: string }>(
    'SELECT connection_status, session_state_path FROM portal_connections WHERE id = ?',
    [state.connectionId],
  );
  assert.equal(row!.connection_status, 'connected');
  assert.ok(row!.session_state_path);
});

step('recording an application is bot-confirmed and idempotent', async () => {
  const res = await call('POST', `/api/v1/worker/runs/${state.runId}/applications`, {
    worker: true,
    body: {
      portalJobId: 'li-1001',
      jobTitle: 'Senior Backend Engineer',
      company: 'Initech',
      location: 'Austin, TX',
      filterId: state.filterId,
      resumeId: state.resumeId,
      jobDescription: MATCHING_DESCRIPTION,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  // A retrying worker must not double-count.
  const again = await call('POST', `/api/v1/worker/runs/${state.runId}/applications`, {
    worker: true,
    body: {
      portalJobId: 'li-1001',
      jobTitle: 'Senior Backend Engineer',
      company: 'Initech',
      jobDescription: MATCHING_DESCRIPTION,
    },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);

  const row = await queryOne<RowDataPacket & { status: string; status_source: string; n: number }>(
    `SELECT status, status_source, (SELECT COUNT(*) FROM applications WHERE user_id = ?) AS n
       FROM applications WHERE user_id = ? AND portal_job_id = 'li-1001'`,
    [state.userId, state.userId],
  );
  assert.equal(row!.status, 'applied');
  assert.equal(row!.status_source, 'bot_confirmed');
  assert.equal(Number(row!.n), 1, 'the duplicate must not have inserted a second row');
});

step('the exclude list is enforced at the write, however it is spelled', async () => {
  // Intake captured "Acme Technologies Pvt. Ltd."; the posting lists it differently.
  const res = await call('POST', `/api/v1/worker/runs/${state.runId}/applications`, {
    worker: true,
    body: { portalJobId: 'li-1002', jobTitle: 'Backend Engineer', company: 'ACME TECHNOLOGIES PRIVATE LIMITED' },
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error.message, /exclude list/i);

  const count = await queryOne<RowDataPacket & { n: number }>(
    "SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND portal_job_id = 'li-1002'",
    [state.userId],
  );
  assert.equal(Number(count!.n), 0, 'an excluded application must not be recorded');
});

step('the daily cap is enforced at the write', async () => {
  for (const id of ['li-1003', 'li-1004']) {
    const res = await call('POST', `/api/v1/worker/runs/${state.runId}/applications`, {
      worker: true,
      body: {
        portalJobId: id,
        jobTitle: 'Backend Engineer',
        company: `Company ${id}`,
        jobDescription: MATCHING_DESCRIPTION,
      },
    });
    assert.equal(res.status, 201, `${id}: ${JSON.stringify(res.body)}`);
  }

  // Cap is 3; this is the fourth.
  const over = await call('POST', `/api/v1/worker/runs/${state.runId}/applications`, {
    worker: true,
    // A genuinely matching posting, so the 409 below is unambiguously the cap and not a
    // low match score. Without the description this would still be refused, but for the
    // wrong reason, and the assertion would pass while testing nothing.
    body: {
      portalJobId: 'li-1005',
      jobTitle: 'Backend Engineer',
      company: 'Overflow Inc',
      jobDescription: MATCHING_DESCRIPTION,
    },
  });
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.match(over.body.error.message, /daily cap/i);
});

step('scraped status moves a record forward without rewriting the applied fact', async () => {
  const res = await call('POST', `/api/v1/worker/runs/${state.runId}/status-sync`, {
    worker: true,
    body: { updates: [{ portalJobId: 'li-1001', status: 'viewed', statusDetail: 'Application viewed' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 1);

  const row = await queryOne<RowDataPacket & { status: string; status_source: string }>(
    "SELECT status, status_source FROM applications WHERE user_id = ? AND portal_job_id = 'li-1001'",
    [state.userId],
  );
  assert.equal(row!.status, 'viewed');
  assert.equal(row!.status_source, 'portal_scrape', 'downstream status must be marked as scraped');

  const events = await queryOne<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM application_status_events e
       JOIN applications a ON a.id = e.application_id
      WHERE a.user_id = ? AND a.portal_job_id = 'li-1001'`,
    [state.userId],
  );
  assert.equal(Number(events!.n), 2, 'applied + viewed should both be on the history');
});

step('OTP: worker raises, ops supplies, worker consumes exactly once', async () => {
  const raised = await call('POST', `/api/v1/worker/runs/${state.runId}/exceptions`, {
    worker: true,
    body: { type: 'otp_required', detail: 'LinkedIn asked for a verification code' },
  });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  state.exceptionId = raised.body.exceptionId;

  // It shows up on the ops queue.
  const queue = await call('GET', '/api/v1/exceptions?status=active');
  assert.equal(queue.status, 200);
  assert.ok(queue.body.data.some((e: any) => e.id === state.exceptionId));
  assert.equal(queue.body.openCountsByType.otp_required, 1);

  // Nothing to read before ops enters anything.
  const empty = await call('GET', `/api/v1/worker/exceptions/${state.exceptionId}`, { worker: true });
  assert.equal(empty.body.responseValue, null);

  const claim = await call('POST', `/api/v1/exceptions/${state.exceptionId}/claim`);
  assert.equal(claim.status, 200);

  // The user forwarded "482913" to ops, who types it here.
  const respond = await call('POST', `/api/v1/exceptions/${state.exceptionId}/respond`, { body: { code: '482913' } });
  assert.equal(respond.status, 200, JSON.stringify(respond.body));

  const first = await call('GET', `/api/v1/worker/exceptions/${state.exceptionId}`, { worker: true });
  assert.equal(first.body.responseValue, '482913');

  // Single use: a replayed poll gets nothing.
  const second = await call('GET', `/api/v1/worker/exceptions/${state.exceptionId}`, { worker: true });
  assert.equal(second.body.responseValue, null, 'an OTP must not be replayable');

  // The code must never reach the audit log.
  const leaked = await queryOne<RowDataPacket & { n: number }>(
    "SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND metadata LIKE '%482913%'",
    [state.userId],
  );
  assert.equal(Number(leaked!.n), 0, 'the OTP must not be written to the audit log');

  const resolve = await call('POST', `/api/v1/exceptions/${state.exceptionId}/resolve`, {
    body: { resolution: 'code_supplied', note: 'User forwarded the code' },
  });
  assert.equal(resolve.status, 204);
});

step('finishing the run records counters', async () => {
  const res = await call('POST', `/api/v1/worker/runs/${state.runId}/finish`, {
    worker: true,
    body: { status: 'succeeded', jobsSeen: 40, jobsMatched: 8, jobsSkippedExcluded: 1, jobsSkippedDuplicate: 1 },
  });
  assert.equal(res.status, 204);

  const list = await call('GET', `/api/v1/runs?userId=${state.userId}`);
  const run = list.body.data.find((r: any) => r.id === state.runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.counters.applicationsSubmitted, 3);
  assert.equal(run.counters.jobsSeen, 40);

  // A finished run stops accepting writes.
  const late = await call('POST', `/api/v1/worker/runs/${state.runId}/applications`, {
    worker: true,
    body: { portalJobId: 'li-9999', jobTitle: 'Late', company: 'Late Inc' },
  });
  assert.equal(late.status, 409);
});

step('stats and reports label their confidence', async () => {
  const overview = await call('GET', '/api/v1/stats/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.body.confidence.applied.includes('bot_confirmed'));
  assert.ok(overview.body.confidence.downstream.includes('Incomplete'));

  const perUser = await call('GET', `/api/v1/stats/users/${state.userId}`);
  assert.equal(perUser.status, 200);
  assert.equal(perUser.body.applicationsSent, 3);
  assert.equal(perUser.body.byPortal.linkedin, 3);
  // One 'viewed' out of three sent.
  assert.equal(perUser.body.observedResponses, 1);
  assert.ok(perUser.body.observedResponseFloor !== undefined);
  assert.ok(!('responseRate' in perUser.body), 'must not present a "response rate"');

  const today = new Date().toISOString().slice(0, 10);
  const report = await call('POST', `/api/v1/users/${state.userId}/reports`, {
    body: { periodStart: today, periodEnd: today, format: 'email' },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  assert.equal(report.body.payload.applicationsSent, 3);
  assert.ok(report.body.payload.caveats.length >= 3);
  assert.ok(report.body.payload.caveats.some((c: string) => /never appear|incomplete/i.test(c)));
  // A user's report must not name a company they excluded.
  assert.ok(!report.body.payload.companies.some((c: string) => /acme/i.test(c)));
});

step('an analyst cannot make changes', async () => {
  const analystId = newId();
  await execute(
    `INSERT INTO org_members (id, org_id, email, password_hash, full_name, role)
     VALUES (?, ?, ?, ?, 'E2E Analyst', 'analyst')`,
    [analystId, state.orgId, `analyst-${suffix}@example.com`, await hashPassword('E2ePassword!1')],
  );

  const login = await call('POST', '/api/v1/auth/login', {
    body: { email: `analyst-${suffix}@example.com`, password: 'E2ePassword!1' },
  });
  const analystToken = login.body.token;

  const read = await call('GET', '/api/v1/applications', { token: analystToken });
  assert.equal(read.status, 200, 'analyst should be able to read');

  const write = await call('POST', '/api/v1/runs', {
    token: analystToken,
    body: { userId: state.userId, portal: 'linkedin' },
  });
  assert.equal(write.status, 403, 'analyst must not be able to queue runs');
});

step('revoking consent pauses the user and cancels queued work', async () => {
  // Queue something first so there is work to cancel.
  await execute(
    `INSERT INTO automation_runs (id, user_id, connection_id, portal, trigger_source, status)
     VALUES (?, ?, ?, 'linkedin', 'manual', 'queued')`,
    [newId(), state.userId, state.connectionId],
  );

  const consent = await queryOne<RowDataPacket & { id: string }>(
    `SELECT id FROM consents WHERE user_id = ? AND consent_type = 'automated_apply' AND revoked_at IS NULL`,
    [state.userId],
  );
  const res = await call('POST', `/api/v1/users/${state.userId}/consents/${consent!.id}/revoke`);
  assert.equal(res.status, 204);

  const user = await queryOne<RowDataPacket & { status: string }>('SELECT status FROM users WHERE id = ?', [
    state.userId,
  ]);
  assert.equal(user!.status, 'paused');

  const queued = await queryOne<RowDataPacket & { n: number }>(
    "SELECT COUNT(*) AS n FROM automation_runs WHERE user_id = ? AND status = 'queued'",
    [state.userId],
  );
  assert.equal(Number(queued!.n), 0, 'queued runs must be cancelled on revocation');

  // And the account is no longer eligible, on the consent ground specifically.
  const eligibility = await call('GET', `/api/v1/runs/eligibility?userId=${state.userId}&portal=linkedin`);
  assert.equal(eligibility.body.eligible, false);
  assert.ok(eligibility.body.reasons.some((r: string) => /consent/i.test(r)));

  // `force` must not be able to override a missing consent.
  const forced = await call('POST', '/api/v1/runs', {
    body: { userId: state.userId, portal: 'linkedin', force: true },
  });
  assert.equal(forced.status, 409, JSON.stringify(forced.body));
  assert.ok(JSON.stringify(forced.body).match(/consent/i), 'force must still refuse without consent');
});

async function cleanup(): Promise<void> {
  // Cascades take out users, connections, applications, runs, exceptions and reports.
  await execute('DELETE FROM organizations WHERE id = ?', [state.orgId]);
  await execute('DELETE FROM credentials WHERE org_id = ?', [state.orgId]);
}

async function main(): Promise<void> {
  const server = createApp().listen(0);
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('failed to bind');
  base = `http://127.0.0.1:${address.port}`;

  let failed = 0;
  for (const { name, run } of steps) {
    try {
      await run();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err instanceof Error ? err.message : String(err)}`);
      break; // Steps build on each other; continuing would just cascade noise.
    }
  }

  await cleanup().catch(() => {});
  server.close();
  await closePool();

  console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();

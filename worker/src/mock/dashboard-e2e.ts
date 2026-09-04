/**
 * The three services together: worker blocks on a verification prompt, an operator clears it
 * *through the dashboard UI*, and the worker carries on and applies.
 *
 * This is the one path none of the other suites cover. The worker e2e supplies the OTP over
 * HTTP, and the dashboard smoke test only proves screens render. Neither shows that a code
 * typed into a form by a human reaches a waiting worker — which is the entire reason the
 * dashboard exists.
 *
 * Needs: MySQL up, API running and seeded, and the dashboard running on :3000.
 *
 *   cd .. && npm run dev          # API
 *   cd dashboard && npm run dev   # dashboard
 *   cd worker && npx tsx src/mock/dashboard-e2e.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { SAMPLE_JOBS, startMockPortal, type MockServer } from './server.js';

const API = (process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
const OPS_EMAIL = process.env.E2E_OPS_EMAIL ?? 'ops@example.com';
const OPS_PASSWORD = process.env.E2E_OPS_PASSWORD ?? 'ChangeMe123!';

const PORTAL_PASSWORD = 'mock-portal-p@ssw0rd';
const OTP_CODE = '714205';
const MOCK_PORT = 4311;

const suffix = crypto.randomBytes(4).toString('hex');
const seekerEmail = `dash-e2e-${suffix}@example.com`;
const seekerName = `Dashboard E2E ${suffix}`;

let opsToken = '';
let mock: MockServer | undefined;
let browser: Browser | undefined;
let page: Page;
let workerDone: Promise<void> | undefined;

const state = { userId: '', runId: '' };

async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (opsToken) headers.authorization = `Bearer ${opsToken}`;
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

step('provision a job seeker ready to be automated', async () => {
  const login = await call('POST', '/auth/login', { email: OPS_EMAIL, password: OPS_PASSWORD });
  assert.equal(login.status, 200, `seed login failed — run "npm run seed" in the API: ${JSON.stringify(login.body)}`);
  opsToken = login.body.token;

  const user = await call('POST', '/users', {
    fullName: seekerName,
    email: seekerEmail,
    country: 'US',
    city: 'Austin',
    timezone: 'UTC',
    targetDesignations: ['Senior Backend Engineer'],
    keySkills: ['Node.js', 'TypeScript', 'MySQL', 'Redis', 'Docker', 'Kubernetes', 'AWS', 'GraphQL'],
    intakeChannel: 'whatsapp',
    dailyApplicationCap: 2,
    minMinutesBetweenApplications: 0,
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  state.userId = user.body.id;

  for (const consentType of ['credential_storage', 'automated_apply', 'data_processing']) {
    const res = await call('POST', `/users/${state.userId}/consents`, {
      consentType,
      version: 'v1',
      capturedVia: 'signed form',
      evidenceRef: 'dash-e2e://form',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const connection = await call('POST', `/users/${state.userId}/connections`, {
    portal: 'dice',
    username: seekerEmail,
    password: PORTAL_PASSWORD,
  });
  assert.equal(connection.status, 201, JSON.stringify(connection.body));

  // Substantial on purpose: the matcher refuses to score a document under 200 characters, so
  // a one-line stub would score every posting zero and this suite would prove nothing beyond
  // "the worker started".
  const resumeText = [
    'Dashboard E2E Seeker — Senior Backend Engineer, Austin TX',
    'Summary',
    'Senior Backend Engineer with 9 years of experience building and operating production',
    'APIs and distributed services on AWS. Deep experience with Node.js and TypeScript,',
    'relational data modelling in MySQL, caching with Redis, and containerised deployment',
    'with Docker and Kubernetes.',
    '',
    'Experience',
    'Acme Corp — Senior Backend Engineer',
    '  Owned billing and entitlements services in Node.js and TypeScript. Designed the',
    '  MySQL schema, operated services on Kubernetes in AWS, and built REST and GraphQL',
    '  APIs for web and mobile clients. Mentored engineers and led design for',
    '  distributed systems and microservices.',
    '',
    'Skills',
    'Node.js, TypeScript, JavaScript, MySQL, Redis, Docker, Kubernetes, AWS, REST,',
    'GraphQL, CI/CD, microservices, distributed systems',
  ].join('\n');

  const resume = new FormData();
  resume.append('resume', new Blob([resumeText], { type: 'text/plain' }), 'r.txt');
  resume.append('isPrimary', 'true');
  const uploaded = await call('POST', `/users/${state.userId}/resumes`, resume);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

  const filter = await call('POST', `/users/${state.userId}/filters`, {
    name: 'Backend',
    designation: 'Senior Backend Engineer',
    keywords: ['node.js', 'backend'],
    locations: ['United States'],
    seniority: 'senior',
    portals: ['dice'],
  });
  assert.equal(filter.status, 201, JSON.stringify(filter.body));

  const activate = await call('PATCH', `/users/${state.userId}`, { status: 'active' });
  assert.equal(activate.status, 200, JSON.stringify(activate.body));
});

step('start a run that will hit a verification prompt and wait', async () => {
  mock = await startMockPortal({
    port: MOCK_PORT,
    email: seekerEmail,
    password: PORTAL_PASSWORD,
    requireOtp: true,
    otpCode: OTP_CODE,
    jobs: SAMPLE_JOBS,
  });

  process.env.WORKER_FORCE_ADAPTER = 'mock';
  process.env.WORKER_MOCK_BASE_URL = mock.url;
  process.env.WORKER_HEADLESS = 'true';
  process.env.WORKER_OTP_POLL_SECONDS = '2';
  // Long enough that a human clicking through the UI is not racing a timeout.
  process.env.WORKER_OTP_WAIT_SECONDS = '240';

  const run = await call('POST', '/runs', { userId: state.userId, portal: 'dice' });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  state.runId = run.body.runId;

  const { api } = await import('../api.js');
  assert.equal(await api.claimRun(['dice']), state.runId);

  const { executeRun } = await import('../run.js');
  workerDone = executeRun(state.runId);
});

step('an operator signs in to the dashboard', async () => {
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  page = await context.newPage();

  await page.goto(`${DASHBOARD}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', OPS_EMAIL);
  await page.fill('input[type="password"]', OPS_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/overview$/, { timeout: 20000 });
});

step('the exception surfaces in the sidebar badge and the queue', async () => {
  // The badge polls, so give it the poll interval rather than assuming it is instant.
  await page.waitForSelector('.nav-count', { timeout: 40000 });

  await page.click('.nav-link:has-text("Exceptions")');
  await page.waitForURL(/\/exceptions$/);

  // The card for *our* job seeker, not whatever else is in the queue.
  const card = page.locator('.otp-card', { hasText: seekerName });
  await card.waitFor({ timeout: 40000 });

  const text = (await card.textContent()) ?? '';
  assert.match(text, /Otp Required/i, 'card did not label the exception type');
  assert.match(text, /read back the verification code/i, 'card did not tell the operator what to do');
  assert.ok(!text.includes(PORTAL_PASSWORD), 'the portal password appeared on screen');
});

step('claiming it reveals the code entry form', async () => {
  const card = page.locator('.otp-card', { hasText: seekerName });
  await card.locator('button:has-text("Claim this")').click();

  // The list reloads after a claim, so re-resolve the card.
  const claimed = page.locator('.otp-card', { hasText: seekerName });
  await claimed.locator('input.code').waitFor({ timeout: 20000 });
});

step('the operator types the code and the worker picks it up', async () => {
  const card = page.locator('.otp-card', { hasText: seekerName });
  await card.locator('input.code').fill(OTP_CODE);
  await card.locator('button:has-text("Send to worker")').click();

  // The UI confirms with a single-use countdown.
  const banner = card.locator('.banner-ok');
  await banner.waitFor({ timeout: 20000 });
  const text = (await banner.textContent()) ?? '';
  assert.match(text, /only be used once/i, `unexpected confirmation: ${text}`);

  await page.screenshot({ path: 'otp-flow-verified.png' }).catch(() => {});
});

step('the run completes and the applications land', async () => {
  assert.ok(workerDone, 'worker never started');
  await workerDone;

  // Ground truth: the mock portal actually received submissions.
  assert.ok(mock!.applied.length > 0, 'the worker never applied to anything after the code was accepted');

  const runs = await call('GET', `/runs?userId=${state.userId}`);
  const run = (runs.body?.data ?? []).find((r: any) => r.id === state.runId);
  assert.ok(run, 'run not found');
  assert.ok(
    ['succeeded', 'partial'].includes(run.status),
    `run ended as ${run.status}: ${run.errorMessage ?? ''}`,
  );
  assert.equal(
    run.counters.applicationsSubmitted,
    mock!.applied.length,
    'the API and the portal disagree on how many applications were sent',
  );
});

step('the dashboard shows those applications as confirmed', async () => {
  await page.goto(`${DASHBOARD}/users/${state.userId}`, { waitUntil: 'networkidle' });
  // The page opens on Activity, where the applications table lives.
  await page.waitForSelector('.tile-value', { timeout: 30000 });
  await page.locator('.panel', { hasText: 'Applications' }).first().waitFor({ timeout: 30000 });

  const body = (await page.textContent('body')) ?? '';
  assert.match(body, /Confirmed/, 'applications did not render with a Confirmed source pill');
  assert.equal(await page.locator('.banner-error').count(), 0, 'user detail showed an error');

  // Readiness tiles must agree that this person is runnable — no warning state left.
  assert.equal(
    await page.locator('.tile.is-warn').count(),
    0,
    'a readiness tile is still warning after a successful run',
  );
});

step('the fixtures clean up after themselves', async () => {
  // The operator resolved nothing in this flow — they only supplied the code — so the
  // exception is still in_progress. Close it and stop the seeker, or the real queue fills
  // with test rows indistinguishable from work waiting on a human.
  const active = await call('GET', '/exceptions?status=active');
  for (const e of active.body?.data ?? []) {
    if (e.runId !== state.runId) continue;
    await call('POST', `/exceptions/${e.id}/resolve`, {
      resolution: 'cleared_manually',
      note: 'dashboard e2e fixture',
    });
  }
  const stop = await call('PATCH', `/users/${state.userId}`, { status: 'offboarded' });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
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
      if (page!) await page.screenshot({ path: `dash-e2e-failure-${Date.now()}.png` }).catch(() => {});
      break;
    }
  }

  // Let the worker unwind before tearing down the portal it is talking to.
  if (workerDone) await workerDone.catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (mock) await mock.close();

  console.log(`\n${passed}/${steps.length} steps passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  if (browser) await browser.close().catch(() => {});
  if (mock) await mock.close();
  process.exit(1);
});

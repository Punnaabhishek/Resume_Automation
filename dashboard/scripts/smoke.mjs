/**
 * Browser smoke test for the console. Drives the real dashboard against the real API and
 * asserts that each screen renders actual data rather than an error state — a dashboard
 * that renders its own empty state on a failed fetch looks fine in a screenshot and is
 * broken in practice, so every check here reads a value that could only come from the API.
 *
 * Playwright is borrowed from ../worker rather than added as a dependency here; the
 * dashboard itself ships no browser automation.
 *
 *   node scripts/smoke.mjs
 *
 * Needs: MySQL up, API running with seed data, and `npm run dev` in this folder.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromWorker = createRequire(path.join(here, '..', '..', 'worker', 'package.json'));
const { chromium } = requireFromWorker('playwright');

const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
const OPS_EMAIL = process.env.E2E_OPS_EMAIL ?? 'ops@example.com';
const OPS_PASSWORD = process.env.E2E_OPS_PASSWORD ?? 'ChangeMe123!';

const checks = [];
const check = (name, run) => checks.push({ name, run });

let page;

check('the root path sends an unauthenticated visitor to the login screen', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/login$/, `expected /login, landed on ${page.url()}`);
  await page.waitForSelector('input[type="email"]');
});

check('a wrong password is refused in plain words', async () => {
  await page.fill('input[type="email"]', OPS_EMAIL);
  await page.fill('input[type="password"]', 'definitely-not-the-password');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.banner-error');
  const text = await page.textContent('.banner-error');
  assert.match(text ?? '', /do not match/i, `unhelpful error: ${text}`);
});

check('the seeded operator can sign in', async () => {
  await page.fill('input[type="password"]', OPS_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/overview$/, { timeout: 15000 });
  // The sidebar renders the member's name from the login response, not from a placeholder.
  await page.waitForSelector('.whoami strong');
  const who = await page.textContent('.whoami strong');
  assert.ok(who && who.trim().length > 0, 'sidebar did not render the signed-in member');
});

check('the overview loads real figures, not an error state', async () => {
  await page.waitForSelector('.tile-value');
  assert.equal(await page.locator('.banner-error').count(), 0, 'overview showed an error banner');

  const values = await page.locator('.tile-value').allTextContents();
  assert.ok(values.length >= 4, `expected 4 stat tiles, found ${values.length}`);
  for (const value of values) {
    assert.match(value.trim(), /^\d+$/, `stat tile did not render a number: "${value}"`);
  }
});

check('the applications screen lists what the worker recorded', async () => {
  await page.click('.nav-link:has-text("Applications")');
  await page.waitForURL(/\/applications$/);
  await page.waitForSelector('table tbody tr, .empty');
  assert.equal(await page.locator('.banner-error').count(), 0, 'applications showed an error banner');

  const rows = await page.locator('table tbody tr').count();
  assert.ok(rows > 0, 'no applications listed — the worker e2e should have left some behind');

  // The bot_confirmed / portal_scrape distinction has to reach the screen, not just the DB.
  const sources = await page.locator('table tbody .pill').allTextContents();
  assert.ok(
    sources.some((s) => /confirmed/i.test(s)),
    'no "Confirmed" source pill rendered; the honest-sourcing label is missing',
  );
});

check('the runs screen shows finished runs with their counters', async () => {
  await page.click('.nav-link:has-text("Runs")');
  await page.waitForURL(/\/runs$/);
  await page.waitForSelector('table tbody tr, .empty');
  assert.equal(await page.locator('.banner-error').count(), 0, 'runs showed an error banner');

  const rows = await page.locator('table tbody tr').count();
  assert.ok(rows > 0, 'no runs listed');
  const statuses = await page.locator('table tbody .pill').allTextContents();
  assert.ok(
    statuses.some((s) => /succeeded|partial|failed|blocked/i.test(s)),
    `no terminal run status rendered: ${statuses.slice(0, 5).join(', ')}`,
  );
});

check('the job seekers screen lists records and links to one', async () => {
  await page.click('.nav-link:has-text("Job seekers")');
  await page.waitForURL(/\/users$/);
  await page.waitForSelector('table tbody tr, .empty');
  assert.equal(await page.locator('.banner-error').count(), 0, 'users showed an error banner');

  const rows = await page.locator('table tbody tr').count();
  assert.ok(rows > 0, 'no job seekers listed');
});

check('a job seeker detail page opens on Activity with readiness up front', async () => {
  await page.locator('table tbody tr td.primary a').first().click();
  await page.waitForURL(/\/users\/[0-9a-f-]{36}$/);
  await page.waitForSelector('.tile-value');
  assert.equal(await page.locator('.banner-error').count(), 0, 'user detail showed an error banner');

  // The four readiness tiles are what decide whether a run can start at all.
  const tiles = (await page.locator('.tile').allTextContents()).join(' | ');
  for (const expected of ['STATUS', 'PORTALS CONNECTED', 'RESUME', 'APPLICATIONS']) {
    assert.ok(tiles.toUpperCase().includes(expected), `missing "${expected}" tile; got ${tiles}`);
  }

  const headings = await page.locator('.panel-head h2').allTextContents();
  for (const expected of ['Portal connections', 'Runs', 'Applications']) {
    assert.ok(headings.includes(expected), `missing "${expected}" panel; got ${headings.join(', ')}`);
  }
});

check('the Setup tab exposes the write forms', async () => {
  await page.click('button:has-text("Setup")');
  await page.waitForSelector('.dl-val', { timeout: 20000 });
  assert.equal(await page.locator('.banner-error').count(), 0, 'setup tab showed an error banner');

  const headings = await page.locator('.panel-head h2').allTextContents();
  for (const expected of ['Profile', 'Consent on file', 'Add or rotate a portal login', 'Search filters', 'Never apply to']) {
    assert.ok(headings.includes(expected), `missing "${expected}" panel; got ${headings.join(', ')}`);
  }
});

check('the Reporting tab renders its charts', async () => {
  await page.click('button:has-text("Reporting")');
  await page.waitForSelector('h2:has-text("Applications over time")', { timeout: 20000 });
  assert.equal(await page.locator('.banner-error').count(), 0, 'reporting tab showed an error banner');

  // Either a plot, or the single-bucket fallback — never a blank panel.
  const hasPlot = await page.locator('.chart-frame svg').count();
  const hasFallback = await page.locator('.single-bucket').count();
  const hasEmpty = await page.locator('.chart .empty, .empty').count();
  assert.ok(hasPlot || hasFallback || hasEmpty, 'the trend panel rendered nothing at all');

  // The response figure must never be presented as a rate.
  const body = await page.textContent('body');
  if (/Observed responses/i.test(body ?? '')) {
    assert.match(body ?? '', /floor, not a rate|not a response rate/i, 'response figure lacks its floor caveat');
  }
});

check('the exception queue renders without error', async () => {
  await page.click('.nav-link:has-text("Exceptions")');
  await page.waitForURL(/\/exceptions$/);
  await page.waitForSelector('table tbody tr, .empty, .otp-card');
  assert.equal(await page.locator('.banner-error').count(), 0, 'exceptions showed an error banner');

  const body = await page.textContent('body');
  assert.match(
    body ?? '',
    /reading them back|Queue is clear|Nothing else in the queue/,
    'exception queue rendered neither the OTP guidance nor an empty state',
  );
});

check('signing out clears the session and blocks the console', async () => {
  await page.click('.sidebar-foot button');
  await page.waitForURL(/\/login$/, { timeout: 10000 });

  await page.goto(`${BASE}/overview`, { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/login$/, 'a signed-out visitor reached the console');
});

async function main() {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();

  const failures = [];
  page.on('pageerror', (err) => failures.push(`uncaught page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') failures.push(`console error: ${msg.text()}`);
  });

  let passed = 0;
  let failed = false;

  for (const c of checks) {
    try {
      await c.run();
      passed += 1;
      console.log(`  ok    ${c.name}`);
    } catch (err) {
      failed = true;
      console.error(`  FAIL  ${c.name}`);
      console.error(`        ${err.message}`);
      await page.screenshot({ path: `smoke-failure-${Date.now()}.png` }).catch(() => {});
      break;
    }
  }

  await browser.close();

  // Console errors are reported but do not fail the run on their own — Next's dev overlay
  // and font preloads are noisy. A real crash shows up as a failed check above.
  if (failures.length) {
    console.log(`\nBrowser noise (${failures.length}):`);
    for (const f of failures.slice(0, 5)) console.log(`  - ${f}`);
  }

  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

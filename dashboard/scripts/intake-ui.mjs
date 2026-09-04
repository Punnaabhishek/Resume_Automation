/**
 * Onboards a job seeker entirely through the browser, then checks the automation can
 * actually run for them.
 *
 * This is the claim the intake wizard makes — that an operator never needs a terminal — so
 * it is tested by driving the real forms rather than the API underneath them. It finishes by
 * asserting eligibility, because a wizard that saves everything and still leaves the person
 * un-runnable has not onboarded anyone.
 *
 *   node scripts/intake-ui.mjs
 *
 * Needs: MySQL up, API running and seeded, and this app running on :3000.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromWorker = createRequire(path.join(here, '..', '..', 'worker', 'package.json'));
const { chromium } = requireFromWorker('playwright');

const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
const API = (process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
const OPS_EMAIL = process.env.E2E_OPS_EMAIL ?? 'ops@example.com';
const OPS_PASSWORD = process.env.E2E_OPS_PASSWORD ?? 'ChangeMe123!';

const stamp = Date.now();
const firstName = 'Casey';
const middleName = 'Alex';
const lastName = `Intake${stamp}`;
const seekerName = `${firstName} ${middleName} ${lastName}`;
const seekerEmail = `ui-intake-${stamp}@example.com`;
const PORTAL_PASSWORD = 'ui-intake-p@ss-9931';

let browser;
let page;
/**
 * One operator token for the whole run.
 *
 * /auth/login is rate-limited on a 15-minute window, so a script that signs in per assertion
 * locks itself out on the second or third run — which surfaces as an unrelated-looking
 * assertion failure further down. Sign in once, reuse it.
 */
let opsToken = '';

async function opsFetch(route, init = {}) {
  if (!opsToken) {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPS_EMAIL, password: OPS_PASSWORD }),
    });
    const body = await res.json();
    if (!res.ok || !body.token) {
      throw new Error(`operator sign-in failed (${res.status}): ${JSON.stringify(body)}`);
    }
    opsToken = body.token;
  }
  return fetch(`${API}${route}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${opsToken}` },
  });
}
let resumePath;
let userId = '';

const checks = [];
const check = (name, run) => checks.push({ name, run });

/**
 * Fill a set of controlled inputs and wait until React has actually taken the values.
 *
 * `page.fill` writes the DOM value and dispatches an input event, but on a cold Next dev
 * server "networkidle" can resolve before hydration finishes — the handlers are not attached
 * yet, component state stays empty, and a button gated on that state never enables. Retrying
 * the fill until the gate opens is the honest fix; waiting a fixed delay only hides it.
 */
async function fillHydrated(entries, readySelector) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    for (const [selector, value] of entries) await page.fill(selector, value);
    try {
      await page.waitForSelector(readySelector, { state: 'attached', timeout: 1000 });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`inputs never reached React state (waiting for ${readySelector})`);
      }
    }
  }
}

check('sign in and open the intake wizard', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await fillHydrated(
    [
      ['input[type="email"]', OPS_EMAIL],
      ['input[type="password"]', OPS_PASSWORD],
    ],
    'button[type="submit"]:not([disabled])',
  );
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/overview$/, { timeout: 20000 });

  await page.click('.nav-link:has-text("Job seekers")');
  await page.waitForURL(/\/users$/);
  await page.click('a:has-text("Onboard a job seeker")');
  await page.waitForURL(/\/users\/new$/);
  await page.waitForSelector('h1:has-text("Onboard a job seeker")');
});

check('stage 1 saves the profile', async () => {
  await fillHydrated(
    [
      ['.field:has-text("First name") input', firstName],
      ['.field:has-text("Middle name") input', middleName],
      ['.field:has-text("Last name") input', lastName],
      ['.field:has-text("Email") input', seekerEmail],
      ['.field:has-text("Phone") input', '+1 512 555 0142'],
      ['.field:has-text("City") input', 'Austin, TX'],
    ],
    'button:has-text("Save and continue"):not([disabled])',
  );

  // Roles, skills and excluded companies are combo-boxes now: type a value, commit it, and it
  // becomes a chip. Enter commits, which is the path an operator actually uses.
  const addTags = async (label, values) => {
    const field = page.locator('.tagselect', { hasText: label }).first();
    for (const value of values) {
      await field.locator('input[type="text"]').fill(value);
      await field.locator('input[type="text"]').press('Enter');
    }
    const chips = await field.locator('.chip-removable').allTextContents();
    for (const value of values) {
      assert.ok(
        chips.some((c) => c.replace('×', '').trim() === value),
        `"${value}" did not become a chip under ${label}: ${chips.join(' | ')}`,
      );
    }
  };

  await addTags('Target roles', ['Senior Backend Engineer', 'Backend Engineer']);
  await addTags('Key skills', ['Node.js', 'TypeScript', 'MySQL']);
  await addTags('Companies never to apply to', ['Blocked Industries Inc']);

  // The name is captured in parts now, not as one string. Confirm the old single field is
  // genuinely gone rather than merely relabelled.
  assert.equal(
    await page.locator('.field:has-text("Full name") input').count(),
    0,
    'the single full-name field should have been replaced by first/middle/last',
  );

  // State is a dropdown now that the platform is US-only, so it is selected, not typed.
  await page.selectOption('.field:has-text("State") select', 'Texas');

  // Country and timezone are fixed by policy — assert they are shown as settled facts
  // rather than as inputs an operator could put a non-US value into.
  const fixed = await page.locator('.fixed-value').allTextContents();
  assert.ok(
    fixed.some((t) => /United States/.test(t)),
    `country is not pinned to the US: ${fixed.join(' | ')}`,
  );
  assert.ok(
    fixed.some((t) => /UTC/.test(t)),
    `timezone is not pinned to UTC: ${fixed.join(' | ')}`,
  );
  assert.equal(
    await page.locator('.field:has-text("Country") input').count(),
    0,
    'country is still an editable input',
  );

  await page.click('button:has-text("Save and continue")');

  await page.waitForSelector('.banner-ok', { timeout: 20000 });
  const saved = await page.textContent('.banner-ok');
  assert.match(saved ?? '', /Profile created/, `stage 1 did not confirm: ${saved}`);
  await page.waitForSelector('h2:has-text("2 · What they authorized")');
});

check('stage 2 records all three consents', async () => {
  await page.fill('.field:has-text("How it was captured") input', 'signed intake form (UI test)');
  await page.fill('.field:has-text("Evidence reference") input', `test://intake/${stamp}.pdf`);
  await page.click('button:has-text("Record all three and continue")');

  await page.waitForSelector('h2:has-text("3 · Their resume")', { timeout: 20000 });
  const saved = await page.textContent('.banner-ok');
  assert.match(saved ?? '', /consents recorded/, `stage 2 did not confirm: ${saved}`);
});

check('stage 3 uploads and parses the resume', async () => {
  await page.setInputFiles('input[type="file"]', resumePath);
  await page.click('button:has-text("Upload and continue")');

  await page.waitForSelector('h2:has-text("4 · Portal logins")', { timeout: 30000 });
  const body = await page.textContent('body');
  assert.match(body ?? '', /Resume uploaded/, 'stage 3 did not confirm the upload');
  // The parser should have found the years-of-experience line in the fixture.
  assert.match(body ?? '', /Parsed/, 'resume was stored but not parsed');
});

check('stage 4 encrypts a portal password without ever echoing it', async () => {
  await page.selectOption('.field:has-text("Portal") select', 'dice');
  await page.fill('.field:has-text("Their username on that portal") input', seekerEmail);
  await page.fill('.field:has-text("Their password") input', PORTAL_PASSWORD);
  await page.click('button:has-text("Save dice")');

  await page.waitForSelector('.pill:has-text("dice saved")', { timeout: 20000 });

  // The field must be cleared, and the password must appear nowhere in the rendered page.
  const fieldValue = await page.inputValue('.field:has-text("Their password") input');
  assert.equal(fieldValue, '', 'the password field was not cleared after saving');

  const body = await page.textContent('body');
  assert.ok(!body?.includes(PORTAL_PASSWORD), 'the portal password was rendered back onto the page');

  await page.click('button:has-text("Continue")');
  await page.waitForSelector('h2:has-text("5 · What to apply to")');
});

check('stage 5 creates a filter and activates them', async () => {
  await page.fill('.field:has-text("Keywords") input', 'node.js, backend');
  await page.fill('.field:has-text("Locations") input', 'Remote, Austin, TX');
  await page.selectOption('.field:has-text("Seniority") select', 'senior');

  // dice was pre-ticked from the saved credential; confirm rather than assume.
  const checked = await page.isChecked('input[type="checkbox"]');
  assert.ok(checked, 'the saved portal was not pre-selected for the filter');

  await page.click('button:has-text("Save filter and activate")');
  await page.waitForSelector('h2:has-text("Ready to automate")', { timeout: 25000 });

  const body = await page.textContent('body');
  assert.match(body ?? '', /Activated/, 'stage 5 did not report activation');
});

check('their page shows them ready, with no missing prerequisites', async () => {
  await page.click('button:has-text("Go to their page")');
  await page.waitForURL(/\/users\/[0-9a-f-]{36}$/, { timeout: 20000 });
  userId = page.url().split('/').pop();

  await page.waitForSelector('.tile-value');
  const tiles = await page.locator('.tile').allTextContents();
  const joined = tiles.join(' | ');

  assert.match(joined, /Active/, `status tile is not Active: ${joined}`);
  assert.match(joined, /On file/, `resume tile does not say On file: ${joined}`);
  // No readiness tile should be in its warning state.
  assert.equal(await page.locator('.tile.is-warn').count(), 0, `a prerequisite is still missing: ${joined}`);
});

check('the setup tab shows consent on file and the credential as stored', async () => {
  await page.click('button:has-text("Setup")');
  await page.waitForSelector('h2:has-text("Consent on file")');

  const body = await page.textContent('body');
  assert.ok(!body?.includes(PORTAL_PASSWORD), 'the portal password leaked onto the setup tab');

  // All three consents must read On file, not Missing.
  const consentPanel = page.locator('.panel', { hasText: 'Consent on file' });
  assert.equal(
    await consentPanel.locator('.pill-crit').count(),
    0,
    'a consent is showing as Missing after intake',
  );
  assert.equal(await consentPanel.locator('.pill-ok').count(), 3, 'expected three consents on file');
});

check('the reporting tab renders without error', async () => {
  await page.click('button:has-text("Reporting")');
  await page.waitForSelector('h2:has-text("Applications over time")');
  assert.equal(await page.locator('.banner-error').count(), 0, 'reporting tab showed an error');

  // No applications yet, so the chart states that rather than drawing an empty plot.
  const body = await page.textContent('body');
  assert.match(body ?? '', /No applications in this range|Applications sent/, 'chart rendered nothing at all');
});

check('the automation is genuinely runnable for them', async () => {
  // The real proof: the API agrees they are eligible, which is what the worker checks.
  const res = await opsFetch(`/runs/eligibility?userId=${userId}&portal=dice`).then((r) => r.json());

  assert.equal(res.eligible, true, `not eligible after a full UI intake: ${JSON.stringify(res.reasons)}`);
  assert.ok(res.remainingToday > 0, 'no application budget remaining');
});

check('clean up the fixture', async () => {
  const res = await opsFetch(`/users/${userId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'offboarded' }),
  });
  assert.equal(res.status, 200, 'could not offboard the test record');
});

async function main() {
  resumePath = path.join(os.tmpdir(), `ui-intake-${stamp}.txt`);
  fs.writeFileSync(
    resumePath,
    [
      seekerName,
      `${seekerEmail} | +91 98400 12345`,
      '',
      'Summary',
      'Senior Backend Engineer with 7 years of experience.',
      '',
      'Skills',
      'Node.js, TypeScript, MySQL, Docker',
    ].join('\n'),
  );

  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();

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
      await page.screenshot({ path: `intake-ui-failure-${Date.now()}.png` }).catch(() => {});
      break;
    }
  }

  await browser.close();
  fs.rmSync(resumePath, { force: true });

  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  if (browser) await browser.close().catch(() => {});
  if (resumePath) fs.rmSync(resumePath, { force: true });
  process.exit(1);
});

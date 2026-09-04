/**
 * Indeed, via "Apply now" (Indeed-hosted applications) only.
 *
 * Same caveat as the LinkedIn adapter: selectors are written to Indeed's published DOM
 * conventions and have not been run against a live logged-in session. Expect to fix them.
 *
 * Indeed is the most aggressive of the three portals about challenging datacentre traffic —
 * a Cloudflare interstitial before the login form is common. That is detected and raised as
 * a `captcha` exception rather than worked around; nothing here attempts to defeat a bot
 * check. Running these accounts through a residential proxy in the user's own region is what
 * makes this path viable at all, and even then it will not always be.
 */
import type { Page } from 'playwright';
import type { JobFilter } from '../api.js';
import type { JobCandidate } from '../matching.js';
import { primaryLocation, searchTerms } from '../matching.js';
import { think } from '../pacing.js';
import type { ApplyOutcome, LoginOutcome, PortalAdapter } from './types.js';

const BASE = 'https://www.indeed.com';
const PAGE_SIZE = 10;

async function isChallenged(page: Page): Promise<boolean> {
  if (/challenge|blocked|captcha/i.test(page.url())) return true;
  return (
    (await page.locator('iframe[src*="challenges.cloudflare.com"], #challenge-running, .g-recaptcha').count()) > 0
  );
}

export const indeedAdapter: PortalAdapter = {
  portal: 'indeed',

  async isLoggedIn(page: Page): Promise<boolean> {
    await page.goto(`${BASE}/myjobs`, { waitUntil: 'domcontentloaded' });
    return !/\/(account\/login|auth)/.test(page.url()) && !(await isChallenged(page));
  },

  async login(page: Page, identifier: string, secret: string): Promise<LoginOutcome> {
    await page.goto(`${BASE}/account/login`, { waitUntil: 'domcontentloaded' });
    await think(1000, 2200);

    if (await isChallenged(page)) {
      return { ok: false, kind: 'captcha', detail: 'Bot challenge before the login form' };
    }

    await page.fill('#ifl-InputFormField-3, input[type="email"]', identifier);
    await think(400, 1100);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await think(1200, 2400);

    // Indeed increasingly prefers emailed sign-in codes over passwords. When it offers no
    // password field at all, the code path is the only way in — same OTP flow.
    const passwordField = page.locator('#ifl-InputFormField-password, input[type="password"]').first();
    if (await passwordField.count()) {
      await passwordField.fill(secret);
      await think(400, 1100);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('domcontentloaded');
      await think(1500, 3000);
    } else {
      return { ok: false, kind: 'otp_required', detail: 'Indeed asked for an emailed sign-in code' };
    }

    if (await isChallenged(page)) return { ok: false, kind: 'captcha', detail: 'Bot challenge after password' };
    if (await page.locator('input[name="verificationCode"], [data-testid="otp-input"]').count()) {
      return { ok: false, kind: 'otp_required', detail: 'Indeed device verification' };
    }
    if (await page.locator('[role="alert"], .css-1s3vk9j').count()) {
      return { ok: false, kind: 'login_failed', detail: 'Credentials rejected' };
    }
    if (/\/account\/login/.test(page.url())) {
      return { ok: false, kind: 'login_failed', detail: 'Still on the login page after submitting' };
    }
    return { ok: true };
  },

  async submitOtp(page: Page, code: string): Promise<LoginOutcome> {
    const field = page.locator('input[name="verificationCode"], [data-testid="otp-input"]').first();
    if (!(await field.count())) {
      return { ok: false, kind: 'unknown', detail: 'Verification field was gone by the time the code arrived' };
    }
    await field.fill(code);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await think(1500, 3000);

    if (await page.locator('input[name="verificationCode"]').count()) {
      return { ok: false, kind: 'login_failed', detail: 'Verification code was not accepted' };
    }
    return { ok: true };
  },

  async search(page: Page, filter: JobFilter, pageIndex: number): Promise<JobCandidate[]> {
    const url = new URL(`${BASE}/jobs`);
    url.searchParams.set('q', searchTerms(filter));
    const location = primaryLocation(filter);
    if (location) url.searchParams.set('l', location);
    if (filter.remote_only === 1) url.searchParams.set('sc', '0kf:attr(DSQF7);');
    if (filter.posted_within_days) url.searchParams.set('fromage', String(filter.posted_within_days));
    url.searchParams.set('start', String(pageIndex * PAGE_SIZE));

    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await think(1400, 2800);

    if (await isChallenged(page)) return [];

    return page.$$eval('div.job_seen_beacon, [data-testid="slider_item"]', (nodes) =>
      nodes
        .map((node) => {
          const link = node.querySelector('a[data-jk], h2.jobTitle a') as HTMLAnchorElement | null;
          const id = link?.getAttribute('data-jk') ?? node.querySelector('[data-jk]')?.getAttribute('data-jk') ?? '';
          return {
            portalJobId: id,
            jobTitle: (node.querySelector('h2.jobTitle') as HTMLElement | null)?.innerText?.trim() ?? '',
            company:
              (node.querySelector('[data-testid="company-name"], .companyName') as HTMLElement | null)?.innerText?.trim() ??
              '',
            location:
              (node.querySelector('[data-testid="text-location"], .companyLocation') as HTMLElement | null)?.innerText?.trim() ??
              '',
            snippet: (node.querySelector('.job-snippet') as HTMLElement | null)?.innerText?.trim() ?? '',
            jobUrl: id ? `https://www.indeed.com/viewjob?jk=${id}` : undefined,
          };
        })
        .filter((j) => j.portalJobId && j.jobTitle && j.company),
    );
  },

  async fetchDescription(page: Page, job: JobCandidate): Promise<string> {
    await page.goto(`${BASE}/viewjob?jk=${job.portalJobId}`, { waitUntil: 'domcontentloaded' });
    await think(1200, 2600);

    if (await isChallenged(page)) return '';

    const body = page.locator('#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]').first();
    if (!(await body.count().catch(() => 0))) return '';
    return (await body.innerText().catch(() => '')) ?? '';
  },

  async apply(page: Page, job: JobCandidate, resumePath: string | null): Promise<ApplyOutcome> {
    await page.goto(`${BASE}/viewjob?jk=${job.portalJobId}`, { waitUntil: 'domcontentloaded' });
    await think(1500, 3200);

    if (await isChallenged(page)) return { ok: false, kind: 'failed', detail: 'Bot challenge on the listing page' };

    const applyButton = page.locator('#indeedApplyButton, [data-testid="indeed-apply-button"]').first();
    if (!(await applyButton.count())) {
      // An "Apply on company site" listing leaves our own domain entirely; out of scope.
      return { ok: false, kind: 'not_applyable', detail: 'Not an Indeed-hosted application' };
    }

    await applyButton.click();
    await think(2000, 3500);

    // The apply flow runs inside an iframe on its own origin.
    const frame =
      page.frames().find((f) => f.url().includes('smartapply') || f.url().includes('apply.indeed')) ?? null;
    if (!frame) return { ok: false, kind: 'failed', detail: 'Apply frame never loaded' };

    for (let step = 0; step < 8; step += 1) {
      if (resumePath) {
        const upload = frame.locator('input[type="file"]').first();
        if (await upload.count().catch(() => 0)) await upload.setInputFiles(resumePath).catch(() => {});
      }

      const unanswered = await frame
        .locator('input[required]:not([type="hidden"]), select[required], textarea[required]')
        .evaluateAll((els) => els.filter((el) => !(el as HTMLInputElement).value).length)
        .catch(() => 0);
      if (unanswered > 0) {
        return { ok: false, kind: 'needs_human', detail: `${unanswered} screening question(s) the profile does not answer` };
      }

      const submit = frame.locator('button:has-text("Submit your application"), [data-testid="submit-application"]').first();
      if (await submit.count().catch(() => 0)) {
        await submit.click();
        await think(2000, 4000);
        const confirmed = await page.locator('text=/application (has been )?submitted|Your application was sent/i').count();
        return confirmed
          ? { ok: true }
          : { ok: false, kind: 'failed', detail: 'Submit clicked but no confirmation appeared' };
      }

      const next = frame.locator('button:has-text("Continue"), [data-testid="continue-button"]').first();
      if (!(await next.count().catch(() => 0))) break;
      await next.click();
      await think(1000, 2200);
    }

    return { ok: false, kind: 'needs_human', detail: 'Apply flow did not reach a submit step' };
  },

  async syncStatuses(page: Page) {
    await page.goto(`${BASE}/myjobs?tab=applied`, { waitUntil: 'domcontentloaded' });
    await think(1200, 2400);

    return page.$$eval('[data-testid="myjobs-item"], .css-jobcard', (nodes) =>
      nodes
        .map((node) => {
          const link = node.querySelector('a[href*="jk="]') as HTMLAnchorElement | null;
          const id = link?.href.match(/jk=([\w]+)/)?.[1] ?? '';
          const text = (node as HTMLElement).innerText.toLowerCase();
          const status = text.includes('viewed by employer')
            ? 'viewed'
            : text.includes('not selected') || text.includes('no longer')
              ? 'rejected'
              : 'applied';
          return { portalJobId: id, status };
        })
        .filter((u) => u.portalJobId),
    );
  },
};

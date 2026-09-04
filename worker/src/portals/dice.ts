/**
 * Dice, via Easy Apply.
 *
 * Same caveat as the other two: selectors follow Dice's published DOM conventions and have
 * not been run against a live logged-in session.
 *
 * Dice is the friendliest of the three for this pattern — a conventional email/password
 * login, a straightforward Easy Apply modal, and much less aggressive device challenging.
 * It is the sensible portal to pilot with before pointing this at LinkedIn.
 */
import type { Page } from 'playwright';
import type { JobFilter } from '../api.js';
import type { JobCandidate } from '../matching.js';
import { primaryLocation, searchTerms } from '../matching.js';
import { think } from '../pacing.js';
import type { ApplyOutcome, LoginOutcome, PortalAdapter } from './types.js';

const BASE = 'https://www.dice.com';
const PAGE_SIZE = 20;

export const diceAdapter: PortalAdapter = {
  portal: 'dice',

  async isLoggedIn(page: Page): Promise<boolean> {
    await page.goto(`${BASE}/dashboard/jobs`, { waitUntil: 'domcontentloaded' });
    return !/\/(dashboard\/login|login)/.test(page.url());
  },

  async login(page: Page, identifier: string, secret: string): Promise<LoginOutcome> {
    await page.goto(`${BASE}/dashboard/login`, { waitUntil: 'domcontentloaded' });
    await think(900, 2000);

    await page.fill('input[name="email"], #email', identifier);
    await think(400, 1100);

    // Dice splits email and password across two steps in some variants and one in others.
    const continueButton = page.locator('button:has-text("Continue")').first();
    if (await continueButton.count()) {
      await continueButton.click();
      await page.waitForLoadState('domcontentloaded');
      await think(900, 1800);
    }

    await page.fill('input[name="password"], #password', secret);
    await think(400, 1100);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await think(1500, 3000);

    if (await page.locator('input[name="otp"], [data-testid="mfa-code"]').count()) {
      return { ok: false, kind: 'otp_required', detail: 'Dice multi-factor prompt' };
    }
    if (await page.locator('[role="alert"], .error-message').count()) {
      return { ok: false, kind: 'login_failed', detail: 'Credentials rejected' };
    }
    if (/locked|suspended/i.test(await page.content())) {
      return { ok: false, kind: 'locked_account', detail: 'Account appears locked' };
    }
    if (/\/login/.test(page.url())) {
      return { ok: false, kind: 'login_failed', detail: 'Still on the login page after submitting' };
    }
    return { ok: true };
  },

  async submitOtp(page: Page, code: string): Promise<LoginOutcome> {
    const field = page.locator('input[name="otp"], [data-testid="mfa-code"]').first();
    if (!(await field.count())) {
      return { ok: false, kind: 'unknown', detail: 'Verification field was gone by the time the code arrived' };
    }
    await field.fill(code);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await think(1500, 3000);

    if (await page.locator('input[name="otp"]').count()) {
      return { ok: false, kind: 'login_failed', detail: 'Verification code was not accepted' };
    }
    return { ok: true };
  },

  async search(page: Page, filter: JobFilter, pageIndex: number): Promise<JobCandidate[]> {
    const url = new URL(`${BASE}/jobs`);
    url.searchParams.set('q', searchTerms(filter));
    const location = primaryLocation(filter);
    if (location) url.searchParams.set('location', location);
    if (filter.remote_only === 1) url.searchParams.set('filters.isRemote', 'true');
    if (filter.posted_within_days) url.searchParams.set('filters.postedDate', `${filter.posted_within_days}DAYS`);
    url.searchParams.set('filters.easyApply', 'true');
    url.searchParams.set('page', String(pageIndex + 1));
    url.searchParams.set('pageSize', String(PAGE_SIZE));

    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await think(1300, 2600);

    return page.$$eval('[data-testid="job-search-serp-card"], .search-card', (nodes) =>
      nodes
        .map((node) => {
          const link = node.querySelector('a[data-testid="job-search-job-detail-link"], a.card-title-link') as HTMLAnchorElement | null;
          const id =
            link?.href.match(/job-detail\/([\w-]+)/)?.[1] ?? node.getAttribute('data-id') ?? node.id ?? '';
          return {
            portalJobId: id,
            jobTitle: link?.innerText?.trim() ?? '',
            company:
              (node.querySelector('[data-testid="company-name"], .card-company') as HTMLElement | null)?.innerText?.trim() ??
              '',
            location:
              (node.querySelector('[data-testid="job-search-job-location"], .search-result-location') as HTMLElement | null)
                ?.innerText?.trim() ?? '',
            snippet: (node.querySelector('.card-description') as HTMLElement | null)?.innerText?.trim() ?? '',
            jobUrl: id ? `https://www.dice.com/job-detail/${id}` : undefined,
          };
        })
        .filter((j) => j.portalJobId && j.jobTitle && j.company),
    );
  },

  async fetchDescription(page: Page, job: JobCandidate): Promise<string> {
    await page.goto(`${BASE}/job-detail/${job.portalJobId}`, { waitUntil: 'domcontentloaded' });
    await think(1200, 2600);

    const more = page.locator('button:has-text("Show more"), [data-testid="show-more-button"]').first();
    if (await more.count().catch(() => 0)) {
      await more.click().catch(() => {});
      await think(400, 900);
    }

    const body = page.locator('[data-testid="jobDescriptionHtml"], #jobdescSec, .job-description').first();
    if (!(await body.count().catch(() => 0))) return '';
    return (await body.innerText().catch(() => '')) ?? '';
  },

  async apply(page: Page, job: JobCandidate, resumePath: string | null): Promise<ApplyOutcome> {
    await page.goto(`${BASE}/job-detail/${job.portalJobId}`, { waitUntil: 'domcontentloaded' });
    await think(1400, 3000);

    const applyButton = page.locator('[data-testid="easy-apply-button"], button:has-text("Easy apply")').first();
    if (!(await applyButton.count())) {
      return { ok: false, kind: 'not_applyable', detail: 'No Easy Apply on this listing' };
    }
    if (/applied/i.test((await applyButton.innerText().catch(() => '')) ?? '')) {
      return { ok: false, kind: 'not_applyable', detail: 'Already applied' };
    }

    await applyButton.click();
    await think(1500, 3000);

    for (let step = 0; step < 5; step += 1) {
      const modal = page.locator('[role="dialog"], .apply-modal').first();
      if (!(await modal.count())) break;

      if (resumePath) {
        const upload = modal.locator('input[type="file"]').first();
        if (await upload.count()) await upload.setInputFiles(resumePath).catch(() => {});
      }

      const unanswered = await modal
        .locator('input[required]:not([type="hidden"]), select[required], textarea[required]')
        .evaluateAll((els) => els.filter((el) => !(el as HTMLInputElement).value).length)
        .catch(() => 0);
      if (unanswered > 0) {
        await page.keyboard.press('Escape').catch(() => {});
        return { ok: false, kind: 'needs_human', detail: `${unanswered} screening question(s) the profile does not answer` };
      }

      const submit = modal.locator('button:has-text("Submit"), [data-testid="apply-submit"]').first();
      if (await submit.count()) {
        await submit.click();
        await think(1500, 3000);
        const confirmed = await page.locator('text=/application (was )?submitted|successfully applied/i').count();
        return confirmed
          ? { ok: true }
          : { ok: false, kind: 'failed', detail: 'Submit clicked but no confirmation appeared' };
      }

      const next = modal.locator('button:has-text("Next"), button:has-text("Continue")').first();
      if (!(await next.count())) break;
      await next.click();
      await think(900, 1800);
    }

    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, kind: 'needs_human', detail: 'Easy Apply flow did not reach a submit step' };
  },
};

/**
 * Adapter for the local mock portal (src/mock/server.ts). Shaped exactly like the real
 * adapters so the e2e exercises the same code path run.ts takes in production — the only
 * difference is which selectors it hands to Playwright.
 */
import type { Page } from 'playwright';
import { config } from '../config.js';
import type { JobFilter } from '../api.js';
import type { JobCandidate } from '../matching.js';
import { searchTerms } from '../matching.js';
import type { ApplyOutcome, LoginOutcome, PortalAdapter } from './types.js';

const PAGE_SIZE = 5;

export const mockAdapter: PortalAdapter = {
  portal: 'mock',

  async isLoggedIn(page: Page): Promise<boolean> {
    await page.goto(`${config.mockBaseUrl}/jobs`, { waitUntil: 'domcontentloaded' });
    return !page.url().includes('/login');
  },

  async login(page: Page, identifier: string, secret: string): Promise<LoginOutcome> {
    await page.goto(`${config.mockBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('#username', identifier);
    await page.fill('#password', secret);
    await page.click('#signin');
    await page.waitForLoadState('domcontentloaded');

    if (page.url().includes('/checkpoint')) {
      return { ok: false, kind: 'otp_required', detail: 'Mock portal asked for a device code' };
    }
    if (await page.locator('.error').count()) {
      return { ok: false, kind: 'login_failed', detail: 'Mock portal rejected the password' };
    }
    return { ok: true };
  },

  async submitOtp(page: Page, code: string): Promise<LoginOutcome> {
    await page.fill('#verification-code', code);
    await page.click('#verify');
    await page.waitForLoadState('domcontentloaded');

    if (await page.locator('.error').count()) {
      return { ok: false, kind: 'login_failed', detail: 'Mock portal rejected the code' };
    }
    return { ok: true };
  },

  async search(page: Page, filter: JobFilter, pageIndex: number): Promise<JobCandidate[]> {
    const url = new URL(`${config.mockBaseUrl}/jobs`);
    url.searchParams.set('q', searchTerms(filter));
    url.searchParams.set('start', String(pageIndex * PAGE_SIZE));
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

    return page.$$eval('.job-card', (cards) =>
      cards.map((card) => ({
        portalJobId: card.getAttribute('data-job-id') ?? '',
        jobTitle: card.querySelector('.job-title')?.textContent?.trim() ?? '',
        company: card.querySelector('.job-company')?.textContent?.trim() ?? '',
        location: card.querySelector('.job-location')?.textContent?.trim() ?? '',
        snippet: card.querySelector('.job-snippet')?.textContent?.trim() ?? '',
        jobUrl: (card.querySelector('.job-title') as HTMLAnchorElement | null)?.href,
      })),
    );
  },

  async fetchDescription(page: Page, job: JobCandidate): Promise<string> {
    await page.goto(`${config.mockBaseUrl}/job/${job.portalJobId}`, { waitUntil: 'domcontentloaded' });
    const body = page.locator('.job-description').first();
    if (!(await body.count().catch(() => 0))) return '';
    return (await body.innerText().catch(() => '')) ?? '';
  },

  async apply(page: Page, job: JobCandidate): Promise<ApplyOutcome> {
    await page.goto(`${config.mockBaseUrl}/job/${job.portalJobId}`, { waitUntil: 'domcontentloaded' });

    if (await page.locator('.applied-state').count()) {
      return { ok: false, kind: 'not_applyable', detail: 'Already applied on the portal' };
    }
    const button = page.locator('#easy-apply');
    if (!(await button.count())) {
      return { ok: false, kind: 'not_applyable', detail: 'No one-click apply on this listing' };
    }

    await button.click();
    await page.waitForLoadState('domcontentloaded');

    // Only a visible confirmation counts as a submission.
    const confirmed = await page.locator('.application-submitted').count();
    if (!confirmed) return { ok: false, kind: 'failed', detail: 'No confirmation after submitting' };
    return { ok: true };
  },

  async syncStatuses(page: Page) {
    await page.goto(`${config.mockBaseUrl}/my/applied`, { waitUntil: 'domcontentloaded' });
    return page.$$eval('.applied-row', (rows) =>
      rows.map((row) => ({
        portalJobId: row.getAttribute('data-job-id') ?? '',
        status: row.getAttribute('data-status') ?? 'applied',
      })),
    );
  },
};

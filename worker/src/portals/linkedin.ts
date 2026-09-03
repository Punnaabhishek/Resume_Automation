/**
 * LinkedIn, via Easy Apply only.
 *
 * IMPORTANT — read before trusting this file. Every selector below was written against
 * LinkedIn's published DOM conventions, not verified against a live logged-in session,
 * because doing that requires a real account and would send real applications to real
 * employers. Expect to fix selectors on first contact. The structure is the durable part;
 * the strings are not.
 *
 * Scope is deliberately narrow: only Easy Apply listings, and only single-step ones where
 * every required field is already answered by the profile. A multi-step flow with unanswered
 * screening questions is abandoned rather than guessed at — inventing an answer to "how many
 * years of Kubernetes do you have" on someone's behalf is a misrepresentation to an employer
 * under that person's name.
 */
import type { Page } from 'playwright';
import type { JobFilter } from '../api.js';
import type { JobCandidate } from '../matching.js';
import { primaryLocation, searchTerms } from '../matching.js';
import { think } from '../pacing.js';
import type { ApplyOutcome, LoginOutcome, PortalAdapter } from './types.js';

const BASE = 'https://www.linkedin.com';
const PAGE_SIZE = 25;

export const linkedinAdapter: PortalAdapter = {
  portal: 'linkedin',

  async isLoggedIn(page: Page): Promise<boolean> {
    await page.goto(`${BASE}/feed/`, { waitUntil: 'domcontentloaded' });
    return !/\/(login|uas\/login|checkpoint)/.test(page.url());
  },

  async login(page: Page, identifier: string, secret: string): Promise<LoginOutcome> {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('#username', identifier);
    await think(400, 1200);
    await page.fill('#password', secret);
    await think(400, 1200);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await think(1500, 3000);

    const url = page.url();

    // A server-side login routinely lands here: LinkedIn treats the datacentre IP as a new
    // device. This is the expected path, not an error.
    if (url.includes('/checkpoint/challenge') || (await page.locator('input[name="pin"]').count())) {
      return { ok: false, kind: 'otp_required', detail: 'LinkedIn device verification challenge' };
    }
    if (url.includes('/checkpoint/lg/login-submit') || (await page.locator('.form__label--error').count())) {
      return { ok: false, kind: 'login_failed', detail: 'Credentials rejected' };
    }
    if (await page.locator('iframe[title*="captcha" i], #captcha-internal').count()) {
      return { ok: false, kind: 'captcha', detail: 'CAPTCHA presented at login' };
    }
    if (/account.*(restricted|suspended)/i.test(await page.content())) {
      return { ok: false, kind: 'locked_account', detail: 'Account appears restricted' };
    }
    if (url.includes('/feed') || url.includes('/jobs')) return { ok: true };

    return { ok: false, kind: 'unknown', detail: `Unexpected page after login: ${new URL(url).pathname}` };
  },

  async submitOtp(page: Page, code: string): Promise<LoginOutcome> {
    const field = page.locator('input[name="pin"], #input__phone_verification_pin').first();
    if (!(await field.count())) {
      return { ok: false, kind: 'unknown', detail: 'Verification field was gone by the time the code arrived' };
    }
    await field.fill(code);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await think(1500, 3000);

    if (page.url().includes('/checkpoint')) {
      return { ok: false, kind: 'login_failed', detail: 'Verification code was not accepted' };
    }
    return { ok: true };
  },

  async search(page: Page, filter: JobFilter, pageIndex: number): Promise<JobCandidate[]> {
    const url = new URL(`${BASE}/jobs/search/`);
    url.searchParams.set('keywords', searchTerms(filter));
    const location = primaryLocation(filter);
    if (location) url.searchParams.set('location', location);
    if (filter.remote_only === 1) url.searchParams.set('f_WT', '2');
    // f_AL restricts to Easy Apply; without it most results are off-site and unusable here.
    url.searchParams.set('f_AL', 'true');
    if (filter.posted_within_days) {
      url.searchParams.set('f_TPR', `r${filter.posted_within_days * 86400}`);
    }
    url.searchParams.set('start', String(pageIndex * PAGE_SIZE));

    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await think(1200, 2600);

    // The results column is virtualised; scrolling it is what materialises the later cards.
    await page.mouse.wheel(0, 2000).catch(() => {});
    await think(600, 1400);

    const cards = page.locator('div.job-card-container, li.jobs-search-results__list-item');
    if (!(await cards.count())) return [];

    return page.$$eval('div.job-card-container, li.jobs-search-results__list-item', (nodes) =>
      nodes
        .map((node) => {
          const link = node.querySelector('a.job-card-container__link, a.job-card-list__title') as HTMLAnchorElement | null;
          const id =
            node.getAttribute('data-job-id') ??
            node.querySelector('[data-job-id]')?.getAttribute('data-job-id') ??
            link?.href.match(/\/jobs\/view\/(\d+)/)?.[1] ??
            '';
          return {
            portalJobId: id,
            jobTitle: link?.innerText?.trim() ?? '',
            company:
              (node.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle') as HTMLElement | null)
                ?.innerText?.trim() ?? '',
            location:
              (node.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption') as HTMLElement | null)
                ?.innerText?.trim() ?? '',
            jobUrl: link ? `https://www.linkedin.com/jobs/view/${id}` : undefined,
            snippet: '',
          };
        })
        .filter((j) => j.portalJobId && j.jobTitle && j.company),
    );
  },

  async apply(page: Page, job: JobCandidate, resumePath: string | null): Promise<ApplyOutcome> {
    await page.goto(`${BASE}/jobs/view/${job.portalJobId}`, { waitUntil: 'domcontentloaded' });
    await think(1500, 3500);

    const easyApply = page.locator('button.jobs-apply-button').first();
    if (!(await easyApply.count())) {
      return { ok: false, kind: 'not_applyable', detail: 'No Easy Apply button on this listing' };
    }
    if (/applied/i.test((await easyApply.innerText().catch(() => '')) ?? '')) {
      return { ok: false, kind: 'not_applyable', detail: 'Already applied' };
    }

    await easyApply.click();
    await think(1200, 2400);

    // Walk the modal. Bounded: a flow this long is a questionnaire, not an application.
    for (let step = 0; step < 6; step += 1) {
      const modal = page.locator('div.jobs-easy-apply-modal, [role="dialog"]').first();
      if (!(await modal.count())) break;

      if (resumePath) {
        const upload = modal.locator('input[type="file"]').first();
        if (await upload.count()) await upload.setInputFiles(resumePath).catch(() => {});
      }

      // Any unanswered required input is a question the profile did not cover. Stop.
      const unanswered = await modal
        .locator('input[required]:not([type="hidden"]), select[required], textarea[required]')
        .evaluateAll((els) => els.filter((el) => !(el as HTMLInputElement).value).length)
        .catch(() => 0);
      if (unanswered > 0) {
        await page.keyboard.press('Escape').catch(() => {});
        return { ok: false, kind: 'needs_human', detail: `${unanswered} screening question(s) the profile does not answer` };
      }

      const submit = modal.locator('button[aria-label*="Submit application" i]').first();
      if (await submit.count()) {
        await submit.click();
        await think(1500, 3000);

        // Only the post-submit confirmation counts. Anything less and we report nothing.
        const confirmed = await page
          .locator('text=/application (was )?sent|Your application was sent/i')
          .count()
          .catch(() => 0);
        return confirmed
          ? { ok: true }
          : { ok: false, kind: 'failed', detail: 'Submit clicked but no confirmation appeared' };
      }

      const next = modal.locator('button[aria-label*="Continue" i], button[aria-label*="Next" i]').first();
      if (!(await next.count())) break;
      await next.click();
      await think(900, 1800);
    }

    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, kind: 'needs_human', detail: 'Easy Apply flow did not reach a submit step' };
  },

  async syncStatuses(page: Page) {
    await page.goto(`${BASE}/my-items/saved-jobs/?cardType=APPLIED`, { waitUntil: 'domcontentloaded' });
    await think(1200, 2400);

    return page.$$eval('li.reusable-search__result-container, div.entity-result', (nodes) =>
      nodes
        .map((node) => {
          const link = node.querySelector('a[href*="/jobs/view/"]') as HTMLAnchorElement | null;
          const id = link?.href.match(/\/jobs\/view\/(\d+)/)?.[1] ?? '';
          const text = (node as HTMLElement).innerText.toLowerCase();
          // LinkedIn only exposes coarse signals here; anything richer would be a guess.
          const status = text.includes('viewed')
            ? 'viewed'
            : text.includes('no longer')
              ? 'rejected'
              : 'applied';
          return { portalJobId: id, status };
        })
        .filter((u) => u.portalJobId),
    );
  },
};

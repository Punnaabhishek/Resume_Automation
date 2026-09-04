/**
 * What a portal adapter must provide. Everything portal-specific lives behind this
 * interface: the run loop in run.ts never touches a selector, so adding a portal is a new
 * file here rather than a change to the orchestration.
 */
import type { Page } from 'playwright';
import type { JobFilter, Portal } from '../api.js';
import type { JobCandidate } from '../matching.js';

/**
 * Why a login attempt stopped. `otp_required`, `captcha` and `locked_account` map straight
 * onto exception_queue types — the adapter classifies, run.ts decides what to do about it.
 */
export type LoginOutcome =
  | { ok: true }
  | { ok: false; kind: 'otp_required'; detail?: string }
  | { ok: false; kind: 'captcha'; detail?: string }
  | { ok: false; kind: 'locked_account'; detail?: string }
  | { ok: false; kind: 'login_failed'; detail?: string }
  | { ok: false; kind: 'unknown'; detail?: string };

export type ApplyOutcome =
  | { ok: true }
  /** The listing turned out not to be one-click applicable; not an error, just skip it. */
  | { ok: false; kind: 'not_applyable'; detail?: string }
  /** A question we are not willing to guess an answer to. Skipped, never invented. */
  | { ok: false; kind: 'needs_human'; detail?: string }
  | { ok: false; kind: 'failed'; detail?: string };

export interface PortalAdapter {
  readonly portal: Portal;

  /** True when the persisted storageState is still a live session. */
  isLoggedIn(page: Page): Promise<boolean>;

  login(page: Page, identifier: string, secret: string): Promise<LoginOutcome>;

  /** Called only after login reported otp_required, with the code ops supplied. */
  submitOtp(page: Page, code: string): Promise<LoginOutcome>;

  /** One page of results for a filter. Empty array means no more pages. */
  search(page: Page, filter: JobFilter, pageIndex: number): Promise<JobCandidate[]>;

  /**
   * The job's full description, from its own page — not the search-result snippet.
   *
   * This is what the match score is computed against, so returning an empty string is a
   * meaningful answer: it scores zero and the job is skipped. That is the correct failure
   * direction. An adapter that returned placeholder text on a selector miss would silently
   * turn "we could not read it" into "it looked fine", which is the exact failure the
   * scoring exists to prevent.
   */
  fetchDescription(page: Page, job: JobCandidate): Promise<string>;

  /**
   * Submit one application. Must only resolve `{ ok: true }` when a submission actually
   * went through — the API records that as bot_confirmed and the dashboard reports it as
   * fact, so a hopeful guess here becomes a lie to the end user.
   */
  apply(page: Page, job: JobCandidate, resumePath: string | null): Promise<ApplyOutcome>;

  /** Re-read the portal's own applied-jobs view. Optional; drives status-sync. */
  syncStatuses?(page: Page): Promise<{ portalJobId: string; status: string; statusDetail?: string }[]>;
}

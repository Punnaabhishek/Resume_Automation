import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be a number`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * The worker holds no database credentials and no master key by design: everything it is
 * allowed to know arrives over the API, scoped to a run it currently owns.
 */
export const config = {
  apiBaseUrl: (process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, ''),
  workerToken: required('WORKER_API_TOKEN'),
  /** Identifies this process in credential_access_log and automation_runs.worker_id. */
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,

  /** Portals this process is willing to claim. Empty means any. */
  portals: (process.env.WORKER_PORTALS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ('linkedin' | 'indeed' | 'dice')[],

  /**
   * Overrides the adapter chosen from the run's portal. Only used by the offline e2e, which
   * needs a run the database will accept (the portal column is an enum of the three real
   * portals) while driving the local mock instead of a live site. Never set in production.
   */
  forceAdapter: (process.env.WORKER_FORCE_ADAPTER || undefined) as 'linkedin' | 'indeed' | 'dice' | 'mock' | undefined,

  headless: bool('WORKER_HEADLESS', true),
  /** Seconds to wait before asking for another run when the queue came back empty. */
  idlePollSeconds: num('WORKER_IDLE_POLL_SECONDS', 20),
  navigationTimeoutMs: num('WORKER_NAVIGATION_TIMEOUT_MS', 45_000),
  actionTimeoutMs: num('WORKER_ACTION_TIMEOUT_MS', 15_000),

  /** How long to wait for ops to supply an OTP before giving up on the run. */
  otpWaitSeconds: num('WORKER_OTP_WAIT_SECONDS', 300),
  otpPollSeconds: num('WORKER_OTP_POLL_SECONDS', 5),

  /** Hard ceiling on one run regardless of remaining budget, so a run cannot wedge a slot. */
  maxRunMinutes: num('WORKER_MAX_RUN_MINUTES', 90),
  /** Search result pages to walk per filter before moving on. */
  maxPagesPerFilter: num('WORKER_MAX_PAGES_PER_FILTER', 3),

  screenshotDir: process.env.WORKER_SCREENSHOT_DIR ?? './screenshots',

  /** Base URL for the mock portal used by the offline e2e. */
  mockBaseUrl: process.env.WORKER_MOCK_BASE_URL ?? 'http://127.0.0.1:4310',
} as const;

export type Config = typeof config;

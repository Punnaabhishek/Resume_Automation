/**
 * Typed client for the /worker/* surface. Mirrors src/modules/worker/worker.routes.ts in
 * the API repo; if a shape here drifts from that file, that file is the authority.
 */
import { config } from './config.js';
import { log } from './log.js';

export type Portal = 'linkedin' | 'indeed' | 'dice' | 'mock';

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

function apiError(status: number, body: unknown, path: string): ApiError {
  const detail =
    body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : '';
  const err = new Error(`${path} -> ${status}${detail ? `: ${detail}` : ''}`) as ApiError;
  err.status = status;
  err.body = body;
  return err;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.workerToken}`,
    'x-worker-id': config.workerId,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) throw apiError(res.status, parsed, `${method} ${path}`);
  return { status: res.status, body: parsed as T };
}

export interface RunContext {
  runId: string;
  portal: Portal;
  user: {
    id: string;
    full_name: string;
    email: string;
    phone: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    target_designations: unknown;
    key_skills: unknown;
    daily_application_cap: number;
    min_minutes_between_applications: number;
  };
  connection: {
    id: string;
    status: string;
    sessionStatePath: string | null;
    proxy: { host: string; port: number; username: string | null; credentialId: string | null; country: string | null } | null;
  };
  resume: { id: string; fileName: string; mimeType: string; absolutePath: string; parsed: unknown } | null;
  filters: JobFilter[];
  excludedCompanies: string[];
  alreadyAppliedJobIds: string[];
  budget: { remainingToday: number; minMinutesBetweenApplications: number };
}

export interface JobFilter {
  id: string;
  name: string;
  designation: string;
  keywords: string[];
  excluded_keywords: string[] | null;
  locations: string[] | null;
  remote_only: 0 | 1;
  seniority: string;
  employment_types: string[] | null;
  min_salary: number | null;
  portals: string[];
  posted_within_days: number | null;
  priority: number;
}

export interface ApplicationInput {
  portalJobId: string;
  jobTitle: string;
  company: string;
  location?: string;
  jobUrl?: string;
  filterId?: string;
  resumeId?: string;
  appliedAt?: string;
}

export type ExceptionType =
  | 'otp_required'
  | 'captcha'
  | 'locked_account'
  | 'login_failed'
  | 'session_expired'
  | 'unknown';

export interface FinishInput {
  status: 'succeeded' | 'partial' | 'failed' | 'blocked';
  jobsSeen?: number;
  jobsMatched?: number;
  jobsSkippedExcluded?: number;
  jobsSkippedDuplicate?: number;
  errorMessage?: string;
}

export const api = {
  /** 204 from the API means the queue is empty; surfaced here as null. */
  async claimRun(portals: Portal[]): Promise<string | null> {
    const res = await call<{ runId: string }>('POST', '/worker/runs/claim', portals.length ? { portals } : {});
    if (res.status === 204 || !res.body) return null;
    return res.body.runId;
  },

  async context(runId: string): Promise<RunContext> {
    const res = await call<RunContext>('GET', `/worker/runs/${runId}/context`);
    return res.body;
  },

  /**
   * The only call that returns a plaintext secret. Every invocation writes a
   * credential_access_log row server-side, so call it once per run and hold the value in
   * memory only as long as the login needs it.
   */
  async credential(runId: string, kind: 'portal' | 'proxy' = 'portal'): Promise<{ identifier: string; secret: string }> {
    const res = await call<{ identifier: string; secret: string }>(
      'GET',
      `/worker/runs/${runId}/credential?kind=${kind}`,
    );
    return res.body;
  },

  async saveSession(runId: string, storageState: unknown): Promise<void> {
    await call('POST', `/worker/runs/${runId}/session`, { storageState });
  },

  /** Returns null when the API reports the job as an already-recorded duplicate. */
  async recordApplication(runId: string, input: ApplicationInput): Promise<{ id: string } | null> {
    const res = await call<{ id?: string; duplicate?: boolean }>(
      'POST',
      `/worker/runs/${runId}/applications`,
      input,
    );
    if (res.body?.duplicate) return null;
    return { id: res.body.id! };
  },

  async statusSync(
    runId: string,
    updates: { portalJobId: string; status: string; statusDetail?: string; observedAt?: string }[],
  ): Promise<{ received: number; changed: number }> {
    const res = await call<{ received: number; changed: number }>(
      'POST',
      `/worker/runs/${runId}/status-sync`,
      { updates },
    );
    return res.body;
  },

  async raiseException(
    runId: string,
    input: { type: ExceptionType; detail?: string; severity?: 'low' | 'normal' | 'high'; screenshotPath?: string },
  ): Promise<string> {
    const res = await call<{ exceptionId: string }>('POST', `/worker/runs/${runId}/exceptions`, input);
    return res.body.exceptionId;
  },

  async pollException(
    exceptionId: string,
  ): Promise<{ id: string; type: string; status: string; resolution: string | null; responseValue: string | null }> {
    const res = await call<{
      id: string;
      type: string;
      status: string;
      resolution: string | null;
      responseValue: string | null;
    }>('GET', `/worker/exceptions/${exceptionId}`);
    return res.body;
  },

  async finish(runId: string, input: FinishInput): Promise<void> {
    await call('POST', `/worker/runs/${runId}/finish`, input);
  },
};

/** True when the API refused because a server-side guard fired, not because we misbehaved. */
export function isConflict(err: unknown): err is ApiError {
  return typeof err === 'object' && err !== null && (err as ApiError).status === 409;
}

export async function pingApi(): Promise<boolean> {
  try {
    const base = config.apiBaseUrl.replace(/\/api\/v1$/, '');
    const res = await fetch(`${base}/health/ready`);
    return res.ok;
  } catch (err) {
    log.warn('API health check failed', { error: (err as Error).message });
    return false;
  }
}

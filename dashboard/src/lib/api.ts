/**
 * Browser-side API client.
 *
 * The dashboard talks to the API directly from the client rather than proxying through
 * Next's server: there is no server-side secret to protect here — the JWT is the member's
 * own — and proxying would only add a hop that hides the real status code.
 *
 * The API must list this origin in CORS_ORIGINS.
 */
import type {
  Application,
  Connection,
  ConsentType,
  DailyAudit,
  CreateUserInput,
  Eligibility,
  JobFilterInput,
  LoginResponse,
  Member,
  OpsException,
  Overview,
  Portal,
  Resolution,
  Resume,
  Run,
  Trend,
  User,
  UserDetail,
  UserStats,
} from './types';

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

const TOKEN_KEY = 'jobapply.ops.token';
const MEMBER_KEY = 'jobapply.ops.member';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

export const session = {
  token(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  member(): Member | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(MEMBER_KEY);
      return raw ? (JSON.parse(raw) as Member) : null;
    } catch {
      return null;
    }
  },
  save(token: string, member: Member): void {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
      window.localStorage.setItem(MEMBER_KEY, JSON.stringify(member));
    } catch {
      // Private-mode browsers throw on write. The session still works for this tab.
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(MEMBER_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = session.token();
  if (token) headers.authorization = `Bearer ${token}`;
  // FormData sets its own multipart content-type with a boundary; overriding it breaks the
  // upload in a way that surfaces as a confusing 400.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    // A network-level failure here is almost always the API being down or CORS refusing
    // the origin, and those look identical from the browser. Say both.
    throw new ApiError(0, `Could not reach the API at ${API_BASE}. Is it running, and is this origin in its CORS_ORIGINS?`);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const envelope = parsed as { error?: { message?: string; details?: string[] } } | null;
    const message = envelope?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message, envelope?.error?.details);
  }

  return parsed as T;
}

function list<T>(body: { data?: T[] } | T[] | null): T[] {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.data ?? [];
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

export const api = {
  async login(email: string, password: string): Promise<LoginResponse> {
    return request<LoginResponse>('POST', '/auth/login', { email, password });
  },

  async me(): Promise<Member> {
    return request<Member>('GET', '/auth/me');
  },

  async overview(): Promise<Overview> {
    return request<Overview>('GET', '/stats/overview');
  },

  async users(params: { status?: string; search?: string } = {}): Promise<User[]> {
    return list(await request('GET', `/users${qs(params)}`));
  },

  /** Returns the profile plus consents, filters, connections and exclusions in one call. */
  async user(id: string): Promise<UserDetail> {
    return request<UserDetail>('GET', `/users/${id}`);
  },

  async createUser(input: CreateUserInput): Promise<User> {
    return request<User>('POST', '/users', input);
  },

  async updateUser(id: string, patch: Record<string, unknown>): Promise<User> {
    return request<User>('PATCH', `/users/${id}`, patch);
  },

  async connections(userId: string): Promise<Connection[]> {
    return list(await request('GET', `/users/${userId}/connections`));
  },

  // --- intake ---------------------------------------------------------------

  async addConsent(
    userId: string,
    input: { consentType: ConsentType; version: string; capturedVia?: string; evidenceRef?: string },
  ): Promise<void> {
    await request('POST', `/users/${userId}/consents`, input);
  },

  async revokeConsent(userId: string, consentId: string): Promise<void> {
    await request('POST', `/users/${userId}/consents/${consentId}/revoke`);
  },

  async resumes(userId: string): Promise<Resume[]> {
    return list(await request('GET', `/users/${userId}/resumes`));
  },

  async uploadResume(userId: string, file: File, isPrimary = true): Promise<Resume> {
    const form = new FormData();
    form.append('resume', file, file.name);
    form.append('isPrimary', String(isPrimary));
    return request<Resume>('POST', `/users/${userId}/resumes`, form);
  },

  /**
   * Stores a portal password. Write-only by design: no route in the API returns a stored
   * password, so nothing that follows this call can read back what was sent.
   */
  async addConnection(
    userId: string,
    input: { portal: Portal; username: string; password: string; proxyId?: string },
  ): Promise<Connection> {
    return request<Connection>('POST', `/users/${userId}/connections`, input);
  },

  async createFilter(userId: string, input: JobFilterInput): Promise<{ id: string }> {
    return request<{ id: string }>('POST', `/users/${userId}/filters`, input);
  },

  async updateFilter(filterId: string, patch: Record<string, unknown>): Promise<void> {
    await request('PATCH', `/filters/${filterId}`, patch);
  },

  async deleteFilter(filterId: string): Promise<void> {
    await request('DELETE', `/filters/${filterId}`);
  },

  async addExcludedCompany(userId: string, companyName: string, reason: string): Promise<void> {
    await request('POST', `/users/${userId}/excluded-companies`, { companyName, reason });
  },

  async removeExcludedCompany(userId: string, excludeId: string): Promise<void> {
    await request('DELETE', `/users/${userId}/excluded-companies/${excludeId}`);
  },

  // --- reporting ------------------------------------------------------------

  async userStats(userId: string): Promise<UserStats> {
    return request<UserStats>('GET', `/stats/users/${userId}`);
  },

  async dailyAudit(userId: string): Promise<DailyAudit> {
    return request<DailyAudit>('GET', `/stats/users/${userId}/daily`);
  },

  async trend(params: { userId?: string; interval?: 'day' | 'week' } = {}): Promise<Trend> {
    return request<Trend>('GET', `/stats/trend${qs(params)}`);
  },

  async runs(params: { userId?: string; status?: string; portal?: string } = {}): Promise<Run[]> {
    return list(await request('GET', `/runs${qs(params)}`));
  },

  async eligibility(userId: string, portal: string): Promise<Eligibility> {
    return request<Eligibility>('GET', `/runs/eligibility${qs({ userId, portal })}`);
  },

  async enqueueRun(userId: string, portal: string): Promise<{ runId: string }> {
    return request<{ runId: string }>('POST', '/runs', { userId, portal });
  },

  async cancelRun(id: string): Promise<void> {
    await request('POST', `/runs/${id}/cancel`);
  },

  async applications(params: { userId?: string; status?: string; portal?: string } = {}): Promise<Application[]> {
    return list(await request('GET', `/applications${qs(params)}`));
  },

  async exceptions(params: { status?: string; type?: string } = {}): Promise<OpsException[]> {
    return list(await request('GET', `/exceptions${qs(params)}`));
  },

  async claimException(id: string): Promise<OpsException> {
    return request<OpsException>('POST', `/exceptions/${id}/claim`);
  },

  /** Supplies the code the user read back. Held ~5 minutes, single-use. */
  async respondToException(id: string, code: string): Promise<{ ok: boolean; expiresInSeconds: number }> {
    return request('POST', `/exceptions/${id}/respond`, { code });
  },

  async resolveException(
    id: string,
    resolution: Resolution,
    note?: string,
    restoreConnection?: boolean,
  ): Promise<void> {
    await request('POST', `/exceptions/${id}/resolve`, { resolution, note, restoreConnection });
  },
};

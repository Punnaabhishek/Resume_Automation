/**
 * Response shapes as the API actually returns them. Every field here was read off the
 * `present()` functions in the API's route modules rather than guessed — if a shape looks
 * wrong, that module is the authority, not this file.
 *
 * List endpoints all wrap in `{ data: [...] }`.
 */

export type Portal = 'linkedin' | 'indeed' | 'dice';
export type MemberRole = 'owner' | 'admin' | 'ops' | 'analyst';

export interface Member {
  id: string;
  email: string;
  fullName: string;
  role: MemberRole;
  orgId: string;
}

export interface LoginResponse {
  token: string;
  member: Member;
}

/** Matches users.status in db/migrations/001_init.sql. */
export type UserStatus = 'intake' | 'active' | 'paused' | 'suspended' | 'offboarded';

export interface User {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  location: { country: string | null; state: string | null; city: string | null; timezone: string | null };
  targetDesignations: string[] | null;
  keySkills: string[] | null;
  status: UserStatus;
  servicePlan: string | null;
  intake: { channel: string | null; completedAt: string | null };
  pacing: { dailyApplicationCap: number; minMinutesBetweenApplications: number };
  /** The resume-to-description bar this person's applications must clear. */
  minMatchScore?: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface Run {
  id: string;
  user: { id: string; fullName: string };
  portal: Portal;
  triggerSource: string;
  status: RunStatus;
  workerId: string | null;
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  counters: {
    jobsSeen: number;
    jobsMatched: number;
    jobsSkippedExcluded: number;
    jobsSkippedDuplicate: number;
    jobsScored: number;
    jobsBelowThreshold: number;
    bestScoreMissed: number | null;
    applicationsSubmitted: number;
  };
  errorMessage: string | null;
}

export type ApplicationStatus =
  | 'applied'
  | 'viewed'
  | 'in_consideration'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'no_response'
  | 'unknown';

/** Where a status came from. 'bot_confirmed' is watched fact; 'portal_scrape' is inference. */
export type StatusSource = 'bot_confirmed' | 'portal_scrape' | 'manual';

export interface Application {
  id: string;
  user: { id: string; fullName: string };
  portal: Portal;
  jobTitle: string;
  company: string;
  location: string | null;
  jobUrl: string | null;
  appliedAt: string;
  status: ApplicationStatus;
  statusSource: StatusSource;
  statusDetail: string | null;
  lastCheckedAt: string | null;
  runId: string | null;
  /** Resume-to-description score, 0-100, that let this application through. */
  matchScore: number | null;
  matchBreakdown: {
    threshold: number;
    components: { key: string; label: string; score: number; weight: number; detail: string }[];
    matchedSkills: string[];
    missingSkills: string[];
  } | null;
}

export type ExceptionType =
  | 'otp_required'
  | 'captcha'
  | 'locked_account'
  | 'login_failed'
  | 'session_expired'
  | 'unknown';

export type ExceptionStatus = 'open' | 'in_progress' | 'resolved' | 'abandoned';

export type Resolution =
  | 'code_supplied'
  | 'cleared_manually'
  | 'account_recovered'
  | 'user_contacted'
  | 'abandoned';

export interface OpsException {
  id: string;
  user: { id: string; fullName: string };
  portal: Portal;
  type: ExceptionType;
  severity: 'low' | 'normal' | 'high';
  status: ExceptionStatus;
  detail: string | null;
  raisedAt: string;
  assignedTo: { id: string; fullName: string } | null;
  resolvedAt: string | null;
  resolution: Resolution | null;
  resolutionNote: string | null;
  runId: string | null;
}

export interface Connection {
  id: string;
  userId: string;
  portal: Portal;
  hasCredential: boolean;
  proxyId: string | null;
  hasPersistedSession: boolean;
  sessionUpdatedAt: string | null;
  /** Matches portal_connections.connection_status. */
  status: 'pending' | 'connected' | 'needs_attention' | 'locked' | 'disconnected';
  statusReason: string | null;
  consecutiveFailures: number;
  lastLoginAt: string | null;
  lastSyncedAt: string | null;
}

export interface Overview {
  range: { from: string; to: string };
  applications: {
    total: number;
    activeUsers: number;
    distinctCompanies: number;
    byPortal: Record<string, number>;
    byStatus: { status: string; source: string; count: number }[];
  };
  users: Record<string, number>;
  openExceptions: Record<string, number>;
  runs: Record<string, number>;
  confidence: unknown;
}

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
  remainingToday: number;
}

export type ConsentType = 'automated_apply' | 'credential_storage' | 'data_processing';

export interface Consent {
  consent_type: ConsentType;
  version: string;
  granted_at: string;
  revoked_at: string | null;
}

export interface ExcludedCompany {
  id: string;
  companyName: string;
  reason: string;
}

export interface FilterSummary {
  id: string;
  name: string;
  designation: string;
  is_active: 0 | 1;
}

export interface Resume {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  isPrimary: boolean;
  parseStatus: 'pending' | 'parsed' | 'failed';
  parseError: string | null;
  parsed: { yearsExperience?: number; skills?: string[] } | null;
  createdAt: string;
}

/** GET /users/:id returns the profile plus these, so one call covers the detail page. */
export interface UserDetail extends User {
  excludedCompanies: ExcludedCompany[];
  filters: FilterSummary[];
  connections: {
    id: string;
    portal: Portal;
    connection_status: string;
    status_reason: string | null;
    last_login_at: string | null;
    last_synced_at: string | null;
    consecutive_failures: number;
  }[];
  consents: Consent[];
}

export interface JobFilterInput {
  name: string;
  designation: string;
  keywords: string[];
  excludedKeywords?: string[];
  locations?: string[];
  remoteOnly?: boolean;
  seniority?: string;
  employmentTypes?: string[];
  minSalary?: number;
  salaryCurrency?: string;
  portals: Portal[];
  postedWithinDays?: number;
  priority?: number;
}

export interface CreateUserInput {
  fullName: string;
  email: string;
  phone?: string;
  country: string;
  state?: string;
  city?: string;
  timezone?: string;
  targetDesignations: string[];
  keySkills?: string[];
  servicePlan?: string;
  intakeChannel?: 'form' | 'whatsapp' | 'phone' | 'email' | 'other';
  dailyApplicationCap?: number;
  minMinutesBetweenApplications?: number;
  excludedCompanies?: { companyName: string; reason: string }[];
  notes?: string;
}

export interface UserStats {
  user: { id: string; fullName: string; targetDesignations: unknown };
  range: { from: string; to: string };
  applicationsSent: number;
  firstApplied: string | null;
  lastApplied: string | null;
  byPortal: Record<string, number>;
  byStatus: { status: string; source: string; count: number }[];
  byDesignation: { designation: string; count: number }[];
  topCompanies: { company: string; count: number }[];
  observedResponses: number;
  /**
   * A floor, not a response rate — responses the portal never displays are invisible to us.
   * Label it accordingly wherever it is shown.
   */
  observedResponseFloor: number | null;
}

export interface Trend {
  range: { from: string; to: string };
  interval: 'day' | 'week';
  series: { bucket: string; portal: string; count: number }[];
}

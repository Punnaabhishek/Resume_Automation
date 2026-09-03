-- Migration 001: core schema for the managed job-application automation platform.
-- Architecture per docs/spec.md: server-side Playwright automation, no end-user login.

CREATE TABLE organizations (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  slug          VARCHAR(100) NOT NULL,
  status        ENUM('active','suspended') NOT NULL DEFAULT 'active',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_organizations_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Operator team members. These are the only accounts that can log in.
CREATE TABLE org_members (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  org_id        CHAR(36)     NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(200) NOT NULL,
  role          ENUM('owner','admin','ops','analyst') NOT NULL DEFAULT 'ops',
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  last_login_at DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_org_members_email (email),
  KEY ix_org_members_org (org_id, status),
  CONSTRAINT fk_org_members_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Job seekers. Managed/hands-off: no password, no login. Contact fields exist so ops can
-- reach them for OTP forwarding and to send the periodic summary report.
CREATE TABLE users (
  id                    CHAR(36)     NOT NULL PRIMARY KEY,
  org_id                CHAR(36)     NOT NULL,
  full_name             VARCHAR(200) NOT NULL,
  email                 VARCHAR(255) NOT NULL,
  phone                 VARCHAR(40)  NULL,
  country               VARCHAR(2)   NOT NULL,
  state                 VARCHAR(100) NULL,
  city                  VARCHAR(100) NULL,
  timezone              VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  target_designations   JSON         NOT NULL,
  key_skills            JSON         NOT NULL,
  status                ENUM('intake','active','paused','suspended','offboarded') NOT NULL DEFAULT 'intake',
  service_plan          VARCHAR(60)  NULL,
  intake_channel        ENUM('form','whatsapp','phone','email','other') NULL,
  intake_completed_at   DATETIME(3)  NULL,
  daily_application_cap INT UNSIGNED NOT NULL DEFAULT 25,
  min_minutes_between_applications INT UNSIGNED NOT NULL DEFAULT 4,
  notes                 TEXT         NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_org_email (org_id, email),
  KEY ix_users_org_status (org_id, status),
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Exclude list, captured at intake. The cheapest real safeguard in a no-review model,
-- so it gets its own table with a normalized column for reliable matching.
CREATE TABLE excluded_companies (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  user_id         CHAR(36)     NOT NULL,
  company_name    VARCHAR(200) NOT NULL,
  normalized_name VARCHAR(200) NOT NULL,
  reason          ENUM('current_employer','past_employer','competitor','personal','other') NOT NULL DEFAULT 'other',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_excluded_user_company (user_id, normalized_name),
  CONSTRAINT fk_excluded_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Signed authorization to act on the user's accounts. Required before any run is allowed.
CREATE TABLE consents (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  user_id       CHAR(36)     NOT NULL,
  consent_type  ENUM('automated_apply','credential_storage','data_processing') NOT NULL,
  version       VARCHAR(20)  NOT NULL,
  granted_at    DATETIME(3)  NOT NULL,
  revoked_at    DATETIME(3)  NULL,
  captured_by   CHAR(36)     NULL,
  captured_via  VARCHAR(60)  NULL,
  evidence_ref  VARCHAR(500) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_consents_user_type (user_id, consent_type, revoked_at),
  CONSTRAINT fk_consents_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE resumes (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  user_id         CHAR(36)     NOT NULL,
  file_name       VARCHAR(255) NOT NULL,
  mime_type       VARCHAR(120) NOT NULL,
  size_bytes      INT UNSIGNED NOT NULL,
  storage_path    VARCHAR(500) NOT NULL,
  checksum_sha256 CHAR(64)     NULL,
  is_primary      TINYINT(1)   NOT NULL DEFAULT 0,
  parse_status    ENUM('pending','parsed','failed') NOT NULL DEFAULT 'pending',
  parse_error     TEXT         NULL,
  parsed          JSON         NULL,
  parsed_at       DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_resumes_user (user_id, is_primary),
  CONSTRAINT fk_resumes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbound proxy pool. Connections are assigned a proxy matched to the user's region so
-- traffic egresses from the country the account normally operates from.
CREATE TABLE proxies (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  org_id          CHAR(36)     NOT NULL,
  label           VARCHAR(120) NOT NULL,
  provider        VARCHAR(80)  NULL,
  kind            ENUM('residential','datacenter','mobile') NOT NULL DEFAULT 'residential',
  country         VARCHAR(2)   NOT NULL,
  region          VARCHAR(100) NULL,
  host            VARCHAR(255) NOT NULL,
  port            SMALLINT UNSIGNED NOT NULL,
  username        VARCHAR(255) NULL,
  credential_id   CHAR(36)     NULL,
  status          ENUM('available','in_use','degraded','retired') NOT NULL DEFAULT 'available',
  max_assignments INT UNSIGNED NOT NULL DEFAULT 1,
  last_checked_at DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_proxies_org_region (org_id, country, region, status),
  CONSTRAINT fk_proxies_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Envelope-encrypted secrets. Ciphertext only: no column here ever holds plaintext, and
-- the API exposes no route that returns one. Only the worker decrypts, at point of use.
CREATE TABLE credentials (
  id          CHAR(36)        NOT NULL PRIMARY KEY,
  org_id      CHAR(36)        NOT NULL,
  scope       ENUM('portal','proxy') NOT NULL,
  identifier  VARCHAR(255)    NOT NULL,
  wrapped_dek VARBINARY(255)  NOT NULL,
  dek_iv      VARBINARY(16)   NOT NULL,
  dek_tag     VARBINARY(16)   NOT NULL,
  ciphertext  VARBINARY(2048) NOT NULL,
  iv          VARBINARY(16)   NOT NULL,
  auth_tag    VARBINARY(16)   NOT NULL,
  key_version INT UNSIGNED    NOT NULL DEFAULT 1,
  rotated_at  DATETIME(3)     NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_credentials_org (org_id, scope),
  CONSTRAINT fk_credentials_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every decrypt is recorded. Append-only; nothing in the app updates or deletes rows here.
CREATE TABLE credential_access_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  credential_id CHAR(36)     NOT NULL,
  actor_type    ENUM('worker','org_member','system') NOT NULL,
  actor_id      VARCHAR(80)  NULL,
  action        ENUM('decrypt','create','rotate','delete') NOT NULL,
  run_id        CHAR(36)     NULL,
  reason        VARCHAR(200) NULL,
  ip            VARCHAR(64)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_cred_access_cred (credential_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE portal_connections (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  user_id              CHAR(36)     NOT NULL,
  portal               ENUM('linkedin','indeed','dice') NOT NULL,
  credential_id        CHAR(36)     NULL,
  proxy_id             CHAR(36)     NULL,
  session_state_path   VARCHAR(500) NULL,
  session_updated_at   DATETIME(3)  NULL,
  connection_status    ENUM('pending','connected','needs_attention','locked','disconnected') NOT NULL DEFAULT 'pending',
  status_reason        VARCHAR(255) NULL,
  consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
  last_login_at        DATETIME(3)  NULL,
  last_synced_at       DATETIME(3)  NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_connection_user_portal (user_id, portal),
  KEY ix_connections_status (connection_status),
  CONSTRAINT fk_connections_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_connections_credential FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL,
  CONSTRAINT fk_connections_proxy FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE job_filters (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  user_id            CHAR(36)     NOT NULL,
  name               VARCHAR(120) NOT NULL,
  designation        VARCHAR(200) NOT NULL,
  keywords           JSON         NOT NULL,
  excluded_keywords  JSON         NULL,
  locations          JSON         NULL,
  remote_only        TINYINT(1)   NOT NULL DEFAULT 0,
  seniority          ENUM('intern','entry','associate','mid','senior','lead','principal','director','any') NOT NULL DEFAULT 'any',
  employment_types   JSON         NULL,
  min_salary         INT UNSIGNED NULL,
  salary_currency    VARCHAR(3)   NULL,
  portals            JSON         NOT NULL,
  posted_within_days INT UNSIGNED NULL,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  priority           INT          NOT NULL DEFAULT 0,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_filters_user_active (user_id, is_active, priority),
  CONSTRAINT fk_filters_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One automation pass for one user on one portal. The unit of work the queue hands out.
CREATE TABLE automation_runs (
  id                     CHAR(36)     NOT NULL PRIMARY KEY,
  user_id                CHAR(36)     NOT NULL,
  connection_id          CHAR(36)     NOT NULL,
  portal                 ENUM('linkedin','indeed','dice') NOT NULL,
  trigger_source         ENUM('schedule','manual','retry') NOT NULL DEFAULT 'schedule',
  status                 ENUM('queued','claimed','running','succeeded','partial','failed','blocked','cancelled') NOT NULL DEFAULT 'queued',
  worker_id              VARCHAR(80)  NULL,
  scheduled_for          DATETIME(3)  NULL,
  claimed_at             DATETIME(3)  NULL,
  started_at             DATETIME(3)  NULL,
  finished_at            DATETIME(3)  NULL,
  jobs_seen              INT UNSIGNED NOT NULL DEFAULT 0,
  jobs_matched           INT UNSIGNED NOT NULL DEFAULT 0,
  jobs_skipped_excluded  INT UNSIGNED NOT NULL DEFAULT 0,
  jobs_skipped_duplicate INT UNSIGNED NOT NULL DEFAULT 0,
  applications_submitted INT UNSIGNED NOT NULL DEFAULT 0,
  error_message          TEXT         NULL,
  created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_runs_queue (status, scheduled_for),
  KEY ix_runs_user (user_id, created_at),
  CONSTRAINT fk_runs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_runs_connection FOREIGN KEY (connection_id) REFERENCES portal_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 'applied' is bot-confirmed and trustworthy. Everything past it comes from scraping the
-- portal's own applied-jobs view and is best-effort; status_source records which.
CREATE TABLE applications (
  id                 CHAR(36)      NOT NULL PRIMARY KEY,
  user_id            CHAR(36)      NOT NULL,
  run_id             CHAR(36)      NULL,
  filter_id          CHAR(36)      NULL,
  resume_id          CHAR(36)      NULL,
  portal             ENUM('linkedin','indeed','dice') NOT NULL,
  portal_job_id      VARCHAR(190)  NOT NULL,
  job_title          VARCHAR(300)  NOT NULL,
  company            VARCHAR(200)  NOT NULL,
  company_normalized VARCHAR(200)  NOT NULL,
  location           VARCHAR(200)  NULL,
  job_url            VARCHAR(1000) NULL,
  applied_at         DATETIME(3)   NOT NULL,
  status             ENUM('applied','viewed','in_consideration','interview','offer','rejected','no_response','unknown') NOT NULL DEFAULT 'applied',
  status_source      ENUM('bot_confirmed','portal_scrape','manual') NOT NULL DEFAULT 'bot_confirmed',
  status_detail      VARCHAR(255)  NULL,
  last_checked_at    DATETIME(3)   NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_application_user_portal_job (user_id, portal, portal_job_id),
  KEY ix_applications_user_applied (user_id, applied_at),
  KEY ix_applications_status (user_id, status),
  KEY ix_applications_run (run_id),
  CONSTRAINT fk_applications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_applications_run FOREIGN KEY (run_id) REFERENCES automation_runs(id) ON DELETE SET NULL,
  CONSTRAINT fk_applications_filter FOREIGN KEY (filter_id) REFERENCES job_filters(id) ON DELETE SET NULL,
  CONSTRAINT fk_applications_resume FOREIGN KEY (resume_id) REFERENCES resumes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE application_status_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  application_id CHAR(36)    NOT NULL,
  from_status    VARCHAR(30) NULL,
  to_status      VARCHAR(30) NOT NULL,
  source         ENUM('bot_confirmed','portal_scrape','manual') NOT NULL,
  observed_at    DATETIME(3) NOT NULL,
  raw            JSON        NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_status_events_app (application_id, observed_at),
  CONSTRAINT fk_status_events_app FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lights up only when automation hits a wall. Not per-application review.
-- For otp_required: response_value holds the code the USER forwards to ops, briefly, and
-- is cleared on use. The platform never reads a user's mailbox or SMS to obtain it.
CREATE TABLE exception_queue (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  org_id              CHAR(36)     NOT NULL,
  user_id             CHAR(36)     NOT NULL,
  connection_id       CHAR(36)     NULL,
  run_id              CHAR(36)     NULL,
  portal              ENUM('linkedin','indeed','dice') NOT NULL,
  type                ENUM('otp_required','captcha','locked_account','login_failed','session_expired','unknown') NOT NULL,
  severity            ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
  status              ENUM('open','in_progress','resolved','abandoned') NOT NULL DEFAULT 'open',
  detail              TEXT         NULL,
  screenshot_path     VARCHAR(500) NULL,
  raised_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  assigned_to         CHAR(36)     NULL,
  claimed_at          DATETIME(3)  NULL,
  resolved_at         DATETIME(3)  NULL,
  resolved_by         CHAR(36)     NULL,
  resolution          ENUM('code_supplied','cleared_manually','account_recovered','user_contacted','abandoned') NULL,
  resolution_note     TEXT         NULL,
  response_value      VARCHAR(60)  NULL,
  response_expires_at DATETIME(3)  NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_exceptions_open (org_id, status, severity, raised_at),
  KEY ix_exceptions_user (user_id, status),
  CONSTRAINT fk_exceptions_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_exceptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_exceptions_connection FOREIGN KEY (connection_id) REFERENCES portal_connections(id) ON DELETE SET NULL,
  CONSTRAINT fk_exceptions_run FOREIGN KEY (run_id) REFERENCES automation_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Periodic summary sent to the user, who has no dashboard to log into.
CREATE TABLE user_reports (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  user_id      CHAR(36)     NOT NULL,
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  format       ENUM('email','pdf','link') NOT NULL DEFAULT 'email',
  payload      JSON         NOT NULL,
  storage_path VARCHAR(500) NULL,
  generated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at      DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_report_user_period (user_id, period_start, period_end),
  CONSTRAINT fk_reports_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id      CHAR(36)     NULL,
  user_id     CHAR(36)     NULL,
  actor_type  ENUM('org_member','worker','system') NOT NULL,
  actor_id    VARCHAR(80)  NULL,
  action      VARCHAR(80)  NOT NULL,
  entity_type VARCHAR(60)  NULL,
  entity_id   VARCHAR(80)  NULL,
  metadata    JSON         NULL,
  ip          VARCHAR(64)  NULL,
  user_agent  VARCHAR(400) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_org_created (org_id, created_at),
  KEY ix_audit_user_created (user_id, created_at),
  KEY ix_audit_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

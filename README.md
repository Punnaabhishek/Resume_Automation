# Job Application Automation Platform

The managed job-application service described in [docs/spec.md](docs/spec.md).
Phase 1 portals: LinkedIn, Indeed, Dice.

All three of the spec's services live here:

| | Where | State |
| --- | --- | --- |
| API + data layer | [`src/`](src/) | Built. 13 smoke + 24-step e2e against real MySQL, plus 9 matcher calibration checks. |
| Automation worker (Playwright) | [`worker/`](worker/) | Built. 16-step e2e against a local mock portal. Portal selectors unverified against live sites — see [worker/README.md](worker/README.md). |
| Ops dashboard (Next.js) | [`dashboard/`](dashboard/) | Built, including intake and a per-user daily audit. 12-check smoke + 11-check intake test. See [dashboard/README.md](dashboard/README.md). |

Each is a separate npm package on purpose, and the split is a security boundary rather than
a packaging preference:

- The **API** is the only thing holding database credentials and the master key.
- The **worker** holds neither. Everything it may know arrives over `/worker/*`, scoped to a
  run it currently owns, and its one credential is a shared token.
- The **dashboard** holds neither, and no screen in it can display or accept a portal
  password. It is a pure API client.

A fourth suite spans all three: `worker/npm run e2e:dashboard` blocks a real run on a
verification prompt, clears it by typing a code into the dashboard UI with a real browser,
and asserts the worker picks it up and applies. That is the one path no single-service test
can cover, and it is the reason the dashboard exists.

## Region and time

**The platform is US-only and runs on UTC.** Both are policy rather than per-person settings,
and both are load-bearing:

- The daily application cap resets on `UTC_DATE()` in the API. Every timestamp the ops
  console shows is therefore rendered in UTC and labelled as such — a local-time clock would
  make "how many are left today" disagree with what the server actually enforces.
- Proxy auto-assignment matches on the job seeker's country. A record created with any other
  country is provisioned with no proxy and egresses from the worker host directly, which is
  the fastest way to get an account flagged.

Country and timezone are fixed in the intake form rather than typed, and the intake script
overrides whatever an intake file says. The worker is the one place that does *not* use UTC:
its browser reports a real US zone derived from the job seeker's state, because a browser
claiming UTC from a residential US IP is exactly the mismatch portal anti-abuse looks for.

## Match scoring

**An application is not sent because a filter matched.** The worker opens each job's own page,
reads the full description, scores it against the résumé, and only applies if it clears a
per-user threshold — 95 by default, floored at 90 whatever a user's threshold is set to.

Two rules that pull against each other, and how they resolve:

> **The threshold is a floor. The daily cap is a ceiling.**
> A day where only 6 postings clear the bar applies to 6, never 35. Filling the cap by
> lowering the standard would defeat the point of having one.

Because of that, `automation_runs` records `jobs_scored`, `jobs_below_threshold` and
`best_score_missed`. Without them a day that scored 200 postings at 94 is indistinguishable
from one that found nothing, and there is no way to tell *the bar is too high* from *the
search is wrong*.

Three things worth knowing before changing any of it:

- **The score is computed twice on purpose.** The worker scores to decide whether to open an
  application at all; the API recomputes at the write, beside the daily-cap and exclude-list
  checks. A worker that scored generously — a bug, a stale build, a selector returning an
  empty page — cannot get a weak match into the record. The worker's copy of the matcher is
  verbatim ([`worker/src/matching-engine.ts`](worker/src/matching-engine.ts)) and
  `npm run smoke` fails if the two drift.
- **An unreadable description scores zero**, not "assume it is fine". The cost is a missed
  application, not a wrong one. Otherwise a broken selector degrades silently into applying to
  everything, which is the exact failure the scoring exists to prevent.
- **A score is a number from a text-matching function, not a verdict.** It is deterministic
  and explainable rather than accurate in any deeper sense, so the component breakdown is
  stored with every application — "why did we apply to this?" stays answerable after the
  posting is gone. The dashboard shows it on hover.

Calibrate with `npx tsx scripts/match-check.ts`, which asserts relationships rather than exact
numbers: a strong fit clears 95, a wrong-role posting cannot reach the floor however much
vocabulary it shares, and an internship cannot pass for a senior role.

## What this is built around

The spec's revised architecture is fully managed: job seekers never log in, don't approve
individual applications, and hand over their portal credentials once at intake. That shapes
almost every decision here.

- **Only operator staff can authenticate.** `org_members` is the only table with a password.
  Job seekers are records, not accounts.
- **Credentials are envelope-encrypted and write-only from the dashboard.** No HTTP route
  returns a portal password to a human. The single decrypt path is the worker's
  `GET /worker/runs/:id/credential`, and it writes a `credential_access_log` row in the same
  transaction as the read, so an unlogged decrypt is not something a caller can produce.
- **Consent gates the queue.** A user with no unrevoked `automated_apply` consent gets no
  runs, and `force` cannot override that specific check. Revoking consent pauses the user
  and cancels their queued runs in the same request.
- **Pacing and caps live in the API, not the worker.** A worker that ignored them would
  still be handed nothing to do, and the application-write endpoint re-checks the daily cap
  under a row lock before inserting.
- **"Applied" and everything after it are different kinds of fact**, and the schema keeps
  them apart via `status_source`. See [Reporting honesty](#reporting-honesty).

### On OTP handling

The exception queue supports this flow: automation hits a verification prompt → it raises an
`otp_required` exception and stops → ops contacts the user → **the user reads back the code
they received** → ops enters it → the worker polls once and consumes it.

The platform has no access to any user's mailbox or phone and nothing here attempts to
obtain one. `exception_queue.response_value` holds a supplied code for five minutes, is
cleared the moment a worker reads it, and is never written to the audit log.

CAPTCHAs and locked accounts follow the same path — raised to a human, never solved
programmatically.

## Stack

Node.js 20+ / TypeScript · Express · MySQL 8 (`mysql2`, raw SQL) · Zod · JWT · bcrypt.

MySQL 8 is a hard requirement, not a preference: the queue uses
`SELECT … FOR UPDATE SKIP LOCKED` so multiple workers can poll without collisions, and
filter matching uses `JSON_CONTAINS`.

## Getting started

```bash
npm install
cp .env.example .env

npm run keygen          # prints a master key -> CREDENTIAL_MASTER_KEY in .env
# also set JWT_SECRET and WORKER_API_TOKEN

docker compose up -d    # MySQL 8.4 on host port 3307 (set DB_PORT=3307)
npm run migrate         # apply db/migrations
npm run seed            # demo org, owner login, one consented job seeker (dev only)
npm run dev             # http://localhost:4000
```

Seeded login: `ops@example.com` / `ChangeMe123!`. No portal credentials are seeded.

Point `DB_*` at your own MySQL 8 instead if you have one; the compose file exists so the
migration and tests have something real to run against.

Two settings people get wrong on first run: `DB_PORT` must be `3307` to match the port the
compose file publishes, and `CREDENTIAL_MASTER_KEY` must actually be filled in — the
`.env.example` placeholder is empty, and an empty master key fails at the first credential
write rather than at boot.

### The worker

```bash
cd worker
npm install
npx playwright install chromium     # ~430 MB, once
cp .env.example .env                # set WORKER_API_TOKEN to match the API's

npm start                           # claim runs until stopped
npm run once                        # claim exactly one run, then exit
```

Scale by running more processes with distinct `WORKER_ID`s, not by making one process drive
several browsers — the queue hands out claims with `SELECT … FOR UPDATE SKIP LOCKED`, so
they will not collide. Shard by portal with `WORKER_PORTALS=linkedin`.

The worker needs read access to the API's `STORAGE_ROOT` for persisted browser sessions and
resume files. Same host by default; a shared volume if you split them.

### The dashboard

```bash
cd dashboard
npm install
cp .env.example .env.local     # NEXT_PUBLIC_API_BASE_URL

npm run dev                    # http://localhost:3000
```

Pinned to port 3000 because that is what the API's default `CORS_ORIGINS` allows. Sign in
with the seeded `ops@example.com` / `ChangeMe123!`.

Onboarding happens at `/users/new` — profile, consents, resume, portal credentials, first
filter, activate. An operator needs no terminal for any of it. `npm run intake` (below) is
the scripted equivalent, for batches.

One trap while developing: **do not run `npm run build` in `dashboard/` while its dev server
is running.** The build overwrites `.next/`, the dev server then 404s every chunk, and pages
load but never hydrate — forms render stuck in their disabled state. It looks like a code
bug and is not one.

### Onboarding from the command line

For batches, or when you would rather not type a password into a browser:

```bash
cp intake/example.json intake/someone.json   # fill it in
INTAKE_OPS_EMAIL=ops@example.com INTAKE_OPS_PASSWORD=... npm run intake intake/someone.json
```

Leave `password` out of each portal entry and the script prompts for it on stdin, so a real
password need never be written to disk. `--dry-run` validates the file without sending
anything. `intake/` is gitignored apart from the example.

### All three at once

Three terminals, in this order — the worker refuses to start if the API is not ready, and
the dashboard shows a connection error rather than a blank page:

```bash
npm run dev                    # 1. API        :4000
cd dashboard && npm run dev    # 2. dashboard  :3000
cd worker && npm start         # 3. worker     (no port; polls the API)
```

## Tests

```bash
npm test          # smoke + e2e
npm run smoke     # no database needed
npm run e2e       # needs MySQL up and migrated
```

**`scripts/smoke.ts`** — 13 checks, no database. Vault round-trip and tamper detection,
company normalization, resume parsing, migration parsing, route mounting and auth
rejection, a static assertion that no dashboard route calls `credentials.reveal`, and a
guard that the worker's copy of the matcher has not drifted from the API's.

Three of those cover years-of-experience parsing specifically, because it feeds the match
score and both directions of error cost something: understating drops a strong candidate
below the bar for jobs they are qualified for, overstating pushes them past "5+ years
required" bars they do not meet.

**`scripts/match-check.ts`** — 9 calibration checks, no database, run with
`npx tsx scripts/match-check.ts`. Asserts *relationships*, not exact numbers: a strong fit
clears 95, a wrong-role posting cannot reach the floor of 90 however much vocabulary it
shares, an internship cannot pass for a senior role, and an unreadable description scores
zero rather than sailing through. Exact scores may move as weights are tuned; those
relationships may not.

**`scripts/e2e.ts`** — 24 steps against real MySQL. Drives intake → consent → provision →
queue → worker → exception → report over HTTP, asserting the guarantees this README claims:
provisioning is refused without consent; the password is ciphertext at rest and absent from
every dashboard response; a decrypt writes an access-log row naming the worker and run; the
exclude list and daily cap are enforced at the write; an OTP is single-use and never reaches
the audit log; scraped status does not overwrite the applied fact; and revoking consent
pauses the user and cancels queued runs even against `force`. It creates its own org and
cleans up after itself.

**`worker/src/mock/e2e.ts`** — 16 steps, run with `cd worker && npm run e2e`. Needs MySQL,
the API running, and `npm run seed` for the ops login. Drives the real `executeRun()` — the
same function production uses — against a local mock portal that demands device
verification at login, then asserts on **both sides of the ledger**: what the portal
actually received, and what the API recorded.

That both-sides check is the point. A worker that reports applications it did not send is
the worst failure this system can have, because the number reaches a job seeker as fact.
The run it exercises: OTP raised and answered by ops, session persisted, exclude list
respected, daily cap enforced, scraped status recorded as `portal_scrape` while the applied
fact stays `bot_confirmed`, and a second run reusing the stored session instead of
triggering a second device check.

It also pins the threshold contract. The sample set is arranged so the run stops at 2 because
only 2 postings clear the bar — *not* because the cap of 3 was reached — and a second run with
a raised cap is asserted to apply to **nothing**, since everything left is below the bar.
Raising the cap must never lower the standard.

**`dashboard/scripts/smoke.mjs`** — 12 checks in a real browser, run with
`cd dashboard && npm run smoke`. Needs the API and the dashboard both running. Every check
reads a value that could only have come from the API, because a dashboard that renders its
own empty state on a failed fetch looks fine in a screenshot and is broken in practice.

**`dashboard/scripts/intake-ui.mjs`** — 11 checks, run with `cd dashboard && npm run
smoke:intake`. Onboards a job seeker entirely through the browser forms, then asserts the API
agrees they are eligible — because a wizard that saves everything and still leaves the person
un-runnable has not onboarded anyone. It also asserts the portal password never appears
anywhere in the rendered page. Offboards its own fixture at the end.

**`worker/src/mock/dashboard-e2e.ts`** — 9 steps across all three services, run with
`cd worker && npm run e2e:dashboard`. Needs all three running. A run blocks on a verification
prompt; a real browser signs in to the dashboard, claims the exception, types the code, and
submits; the worker consumes it and applies. Asserts the API and the mock portal agree on how
many applications were sent.

Both browser suites clean up the fixtures they create. Without that, every run leaves an
in-progress OTP exception behind and the real queue fills with test rows indistinguishable
from work waiting on a human.

One gotcha when running suites back to back: `/auth/login` is rate-limited to a 15-minute
window, and each suite signs in. Hitting the limit reports `rate_limited`, not a bug.

## Configuration

| Variable | Notes |
| --- | --- |
| `CREDENTIAL_MASTER_KEY` | 32 bytes, base64. **Losing or changing it makes every stored credential undecryptable.** In production load it from Azure Key Vault at boot, not from `.env` — swap `loadMasterKey` in `src/services/vault.ts` and nothing else changes. |
| `WORKER_API_TOKEN` | Shared secret for `/worker/*`. Compared in constant time. |
| `JWT_SECRET` | Signs ops dashboard sessions. |
| `DEFAULT_DAILY_APPLICATION_CAP` | Per user per day. Overridable per user. |
| `DEFAULT_MIN_MINUTES_BETWEEN_APPLICATIONS` | Minimum spacing between applications. |

## Data model

Two migrations. `001_init.sql` is the schema; `002_matching_and_identity.sql` adds match
scoring (`applications.match_score` and `match_breakdown`, `users.min_match_score`,
`resumes.raw_text`, and the three new run counters) and structured names
(`users.first_name/middle_name/last_name`, backfilled from `full_name`).

`resumes.raw_text` holds the whole document while `resumes.parsed` keeps only an excerpt:
the matcher scores prose — titles, seniority wording and domain vocabulary all live in the
body — but a multi-page résumé does not belong in a JSON column every dashboard read pulls
back.

17 tables, in `db/migrations/001_init.sql`.

| Group | Tables |
| --- | --- |
| Tenancy | `organizations`, `org_members` |
| Job seekers | `users`, `excluded_companies`, `consents`, `resumes` |
| Provisioning | `credentials`, `credential_access_log`, `proxies`, `portal_connections` |
| Targeting | `job_filters` |
| Execution | `automation_runs`, `applications`, `application_status_events` |
| Ops & reporting | `exception_queue`, `user_reports`, `audit_log` |

Notes on the less obvious ones:

- **`credentials`** stores ciphertext only. Each secret gets its own data key (DEK), sealed
  with AES-256-GCM and itself wrapped under the master key. One leaked DEK exposes one
  credential, and master-key rotation only re-wraps DEKs rather than re-encrypting secrets.
- **`excluded_companies.normalized_name`** is the matched column. `normalizeCompany` folds
  case, punctuation and legal suffixes, so "Acme Technologies Pvt. Ltd." typed at intake
  still blocks a posting listed as "ACME TECHNOLOGIES PRIVATE LIMITED".
- **`portal_connections.session_state_path`** points at a persisted Playwright
  `storageState`, so an account keeps one browser profile across runs instead of starting
  cold each time.
- **`credential_access_log`** and **`audit_log`** are append-only by convention — nothing in
  the app updates or deletes rows in either.

## API

Base path `/api/v1`. Ops routes take a member JWT; `/worker/*` takes the worker token plus
an `X-Worker-Id` header.

Roles: `owner` > `admin` > `ops` > `analyst`. `analyst` is read-only. Deleting connections
and resumes, and managing proxies, require `admin` or `owner`.

### Ops dashboard

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login` | Member login (rate-limited, 10 per 15 min) |
| `GET` | `/auth/me` | Current member |
| `GET POST` | `/users` | List / create job seekers (create accepts the exclude list inline) |
| `GET PATCH` | `/users/:id` | Detail (with filters, connections, consents) / update |
| `POST DELETE` | `/users/:id/excluded-companies[/:excludeId]` | Maintain the exclude list |
| `POST` | `/users/:id/consents` | Record signed authorization |
| `POST` | `/users/:id/consents/:consentId/revoke` | Revoke, pause the user, cancel queued runs |
| `GET POST` | `/users/:userId/resumes` | List / upload (parses inline) |
| `POST` | `/resumes/:id/primary`, `/resumes/:id/reparse` | Manage resumes |
| `GET DELETE` | `/resumes/:id/download`, `/resumes/:id` | Fetch / remove |
| `GET POST` | `/users/:userId/connections` | List / provision a portal connection |
| `PATCH DELETE` | `/connections/:id` | Update status or proxy / remove |
| `GET` | `/connections/:id/credential-access` | Who decrypted this password, and when |
| `GET POST` | `/users/:userId/filters` | List / create filters |
| `PATCH DELETE` | `/filters/:id` | Update / remove |
| `GET` | `/runs`, `/runs/eligibility` | Run history; why an account is or isn't eligible |
| `POST` | `/runs`, `/runs/:id/cancel` | Queue manually / cancel |
| `POST` | `/runs/scheduler/enqueue-due`, `/runs/scheduler/reap-stale` | Scheduler hooks |
| `GET` | `/exceptions`, `/exceptions/:id` | The ops queue |
| `POST` | `/exceptions/:id/claim`, `/respond`, `/resolve` | Work an exception |
| `GET PATCH` | `/applications`, `/applications/:id`, `/applications/:id/status` | Application log |
| `GET POST` | `/proxies`, `/proxies/:id` | Proxy pool |
| `GET` | `/stats/overview`, `/stats/users/:userId`, `/stats/trend` | Dashboard numbers |
| `GET POST` | `/users/:userId/reports[/preview]`, `/reports/:id/sent` | Per-user summaries |

Provisioning a connection (`POST /users/:userId/connections`) takes `{ portal, username,
password, proxyId? }`. It refuses unless the user has active `credential_storage` consent,
puts the password straight into the vault, and auto-assigns a proxy in the user's own
country if none is given. The password is never returned by any subsequent read.

### Worker

A worker's loop:

```
POST /worker/runs/claim              -> { runId } or 204
GET  /worker/runs/:id/context        -> profile, resume path, filters, exclude list, budget
GET  /worker/runs/:id/credential     -> { identifier, secret }   (logged; ?kind=proxy too)
POST /worker/runs/:id/session        -> persist storageState after login
POST /worker/runs/:id/applications   -> record each submitted application
POST /worker/runs/:id/status-sync    -> batch status updates from the applied-jobs page
POST /worker/runs/:id/exceptions     -> OTP / CAPTCHA / lockout, then stop
GET  /worker/exceptions/:id          -> poll for the code ops entered (single-use)
POST /worker/runs/:id/finish         -> counters and final status
```

Server-side guarantees the worker can rely on, and cannot bypass:

- `/context` re-checks eligibility at hand-off and blocks the run if consent was revoked or
  the cap was reached between enqueue and claim.
- `/applications` rejects a company on the exclude list (409) and rejects a write past the
  daily cap (409), checked under `SELECT … FOR UPDATE`.
- Duplicate applications are idempotent: a repeat `portalJobId` returns `200 {duplicate:true}`,
  not an error, so a retrying worker is safe.
- Every run is owned by the worker that claimed it; another worker's calls get a 409.

Only call `POST /applications` after a submission has actually gone through. That endpoint
is the sole source of the `bot_confirmed` count the whole dashboard treats as solid.

## Reporting honesty

`applications.status_source` distinguishes:

- `bot_confirmed` — the automation observed the submission succeed. Trustworthy.
- `portal_scrape` — read off the portal's own applied-jobs page. Incomplete by nature.
- `manual` — an ops override.

Scraped status never overwrites the fact that an application was sent; it only moves a
record forward from `applied`.

Every `/stats` response carries a `confidence` block stating this, and the per-user report
payload embeds `caveats` that say it in plain language. The user-facing rate is deliberately
named `observedResponseFloor`, not "response rate" — outcomes the portal never displays are
invisible, and no status change does not mean no decision.

## Operational notes

- **Scheduling.** `enqueueDueRuns()` and `reapStaleRuns()` in
  `src/modules/runs/runs.service.ts` are the two jobs to drive on a timer; both are also
  exposed as owner/admin HTTP routes so an Azure timer can call them without DB access.
  Stale runs (no progress in 45 minutes) are failed and freed.
- **Concurrency.** One in-flight run per user+portal is enforced at enqueue. Multiple
  workers are safe.
- **Proxies.** `max_assignments` caps how many accounts share one address. Retiring a proxy
  unassigns its connections and flags them `needs_attention` rather than silently egressing
  from the wrong country.
- **Hosting.** Per the spec, GoDaddy shared/cPanel won't run this. It needs a persistent
  Node process, MySQL 8, and — for the separate worker — enough memory for headless
  browsers. Azure App Service or a VPS with root access.

## Not built here

Deliberately out of scope, listed so nothing looks accidentally missing:

- **Proxy and report screens.** The API has routes for both; the console does not surface
  them. Everything else an operator needs — intake, credentials, filters, exclude lists,
  resumes — is in the dashboard, so onboarding no longer requires a terminal.
- **Editing a profile after intake.** Status and pacing are adjustable from the console, but
  name, email and location are read-only once created; use the API.
- **Role-gated dashboard UI.** The API enforces roles, so an analyst gets a 403 and sees the
  error, but the console still renders buttons they cannot use.
- **Screening-question answering and per-question profiles.** See below — an unanswered
  required field abandons the application rather than being guessed at.
- **Verified portal selectors.** The LinkedIn, Indeed and Dice adapters are written to each
  site's published DOM conventions but have never been run against a live logged-in session,
  because doing that needs real accounts and sends real applications to real employers.
  Expect to fix selectors on first contact. The mock-portal e2e proves the orchestration,
  not the selectors.
- Screening-question answering. An Easy Apply flow with an unanswered required field is
  abandoned, never guessed at — inventing an answer to "how many years of Kubernetes do you
  have" under someone else's name is a misrepresentation to an employer.
- Report delivery. Reports generate and store; `POST /reports/:id/sent` marks delivery once
  your email/PDF channel has actually sent one.
- Master-key rotation as a runnable script. `rewrap()` in `src/services/vault.ts` is the
  primitive; the batch job over `credentials` is not written.
- A unit-test framework. `scripts/smoke.ts` and `scripts/e2e.ts` cover the behaviour that
  matters, but they are scripts, not a suite with per-module coverage.

## Standing risks

From the spec, unchanged by anything in this implementation:

- All three portals prohibit automated applications. The architecture affects detection
  rate, not the underlying ToS conflict.
- Accounts will be restricted. The spec calls this a normal operating cost — worth being
  explicit with users at intake that it is their account at risk, since they are not the
  ones running the automation.
- Holding real credentials for people's personal accounts across multiple jurisdictions,
  and acting on those accounts without per-action confirmation, is the part most worth a
  lawyer's time. India's DPDP Act at minimum; GDPR/CCPA depending on where users are.

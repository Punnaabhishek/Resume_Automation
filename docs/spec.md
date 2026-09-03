# Job Application Automation Platform — Build Spec

Use this as a build prompt for a dev team or an AI coding assistant. It covers architecture,
data model, workflows, and the constraints that shape all of it.

## What this is

A multi-tenant SaaS platform, run **fully managed / hands-off for the end user**. Users
(job seekers, across different states and countries) do not sign up themselves, do not log
into any dashboard, and do not see or approve individual applications. They provide the
operator (you) with a resume, target designation, key skills, portal login details, and a
list of companies to exclude — once, at intake — pay for the service, and the platform
handles everything end-to-end on their behalf. Reporting goes back to them as a summary,
not as something they log into.

Phase 1 portals: **LinkedIn, Indeed, Dice**.

## Architecture: server-side automation using stored credentials

Because the end user isn't an active participant (no extension install, no login from
their own device), this has to run as backend automation holding each user's real
credentials — logging into their account and submitting applications without a per-action
review step. This is the higher-risk pattern between the two options: it's the exact thing
platform anti-abuse systems are built to catch, and having many accounts behind one
operator's infrastructure (shared IPs/proxies, similar behavior patterns, similar timing)
tends to get flagged faster than any one person's own activity would. That's a real
trade-off of the hands-off model, not a hypothetical one — plan for accounts getting
restricted as a normal operating cost, not an edge case.

A few things become load-bearing given that:

1. **Credential vault, not Excel/Notepad.** Real people's LinkedIn/Indeed/Dice passwords
   are now the backbone of the system. Use proper encrypted secrets storage (Azure Key
   Vault, or app-level envelope encryption) with tightly scoped access — the automation
   service should be the only thing that ever decrypts a password, at the moment of use,
   with that access logged.

2. **Per-user session persistence.** A login from your server (different device/location
   than the user normally uses) will routinely trigger a "new device" OTP or verification
   email/SMS. Two things reduce (not eliminate) this:
   - A **persistent browser profile per user** (cookies, local storage kept between runs)
     so it looks like the same device logging in each time, not a fresh session every run.
   - A **residential proxy matched to the user's own country/region**, so the login
     doesn't look like it's coming from a data center.
   You still need a process for handling the OTP when it does happen (see Ops, below).

3. **Ops exception queue.** Something needs to catch: OTP/verification codes, CAPTCHA
   challenges, and accounts that get locked or restricted. This isn't per-application
   review — it's a queue that lights up only when automation hits a wall, for a person on
   your team to clear.

4. **Exclude list, captured at intake.** With no per-application review, this is the
   cheapest real safeguard: ask every user upfront for companies to never apply to
   (current employer, past employer, named competitors). Bake it into onboarding, not an
   afterthought.

## Roles & multi-tenancy

- **Organization** (you, the operator)
- **Users** (job seekers) — hands-off: provide resume, target designation + key skills,
  portal credentials, and an exclude list once at intake (whatever channel you use — form,
  WhatsApp, phone call). They receive results as a periodic summary, not a login.
- **Ops** (your team) — clears the exception queue (OTP, CAPTCHA, locked/restricted
  accounts), monitors volume and quality per account.

## Core data model

- `Organization`
- `User` (name, location, target designation(s), key skills, exclude list, account status)
- `Resume` (file + parsed structured data: skills, titles, experience)
- `PortalConnection` (user_id, portal, encrypted credentials, persistent session/cookie
  data, assigned proxy/region, connection_status, last_synced_at)
- `JobFilter` (designation, keywords, location, seniority — per user)
- `Application` (user_id, portal, job_title, company, applied_at, status
  [applied / viewed / interview / rejected / no_response / unknown], status_source
  [bot-confirmed / portal-scrape], last_checked_at)
- `ExceptionQueueItem` (user_id, portal, type [otp / captcha / locked_account],
  raised_at, resolved_at, resolved_by)

## Core workflows

1. **Intake** — collect resume, target designation + key skills, portal logins, and
   exclude list per user, via whatever channel you use.
2. **Provisioning** — create a `PortalConnection` per user per portal: store credentials
   in the vault, assign a region-matched proxy, initialize a persistent browser profile.
3. **Job discovery & filtering** — automated search per portal using designation +
   keywords, filtered against the exclude list.
4. **Apply** — automated fill + submit, fully unattended, paced to a human-like daily cap
   per account (don't fire applications back-to-back).
5. **Exception handling** — ops clears items needing OTP entry, CAPTCHA solve, or account
   recovery.
6. **Status sync** — periodic scrape of each portal's own "applied jobs" view. Same
   caveat as before: **"Applied" is bot-confirmed and reliable; everything past that
   (viewed/interview/rejected) is only as good as what the portal itself shows, and many
   rejections never surface as a status change at all.**
7. **Reporting** — since users don't log in, produce a periodic summary per user (email,
   PDF, or shared link) rather than a self-serve dashboard, at least for v1.

## Dashboard requirements

Primarily an **internal ops dashboard** for your team:

- Per user, per portal, per designation: applications sent, status breakdown, trend over
  time.
- Exception queue: what's stuck and needs a human (OTP/CAPTCHA/locked account).
- Org-level rollup across all users.
- Same labeling discipline as the workflow: "Applied" solid, downstream status best-effort.

Optionally, a lightweight read-only summary you generate and send to each user (not a
system they log into).

## Suggested tech stack

Matches what you already run:

- Backend API: Node.js / TypeScript, with a job queue (per-user, per-portal automation
  runs)
- Ops dashboard: React / Next.js
- Database: MySQL
- Automation: Playwright (persistent browser profile + proxy per user)
- Resume parsing: PDF/DOCX parser + skills/title extraction for autofill and matching

## Hosting

- **Prototype**: Azure or local — fine as-is.
- **Production**: GoDaddy's shared/cPanel hosting is built for PHP-style sites, not a
  persistent Node backend running background jobs and headless-browser automation
  (memory/CPU-heavy, needs to stay running) — it'll likely hit resource or process limits.
  GoDaddy VPS or dedicated plans (root/SSH access) can run this the same way Azure would.
  Simplest option: keep GoDaddy for the domain/DNS only, and host the backend on Azure —
  common setup, avoids the resource ceiling entirely.

## Security & compliance

- No plaintext credentials at rest, anywhere — envelope-encrypted in a vault, decrypted
  only at point of use, with access logged.
- Full audit log of every apply event (what was applied to, when, which automation run).
- Rate-limit/pace actions per account to look human.
- Legal review is worth prioritizing here, more than in a self-serve model: you're now the
  party holding real login credentials and taking automated actions on people's personal
  accounts across multiple states and countries, without a per-action confirmation step.

## Phase 1 scope

- Portals: LinkedIn, Indeed, Dice
- Fully managed apply flow, ops exception handling for OTP/CAPTCHA/locked accounts
- Intake capture: resume, designation/keywords, credentials, exclude list
- Application log + internal ops dashboard
- Simple per-user summary report (email/PDF/link)

## Phase 2+ (later)

- Additional portals
- Auto-tailored resume per application
- Self-serve client dashboard (if you later want users to log in and see status)
- Deeper analytics — response rate by designation, by portal, by region

## Open questions to settle before build starts

- Intake channel — form, WhatsApp, phone call, something else?
- Who handles OTP/verification codes when they land in the user's email/phone, and how is
  that access authorized and secured?
- What does the per-user report look like, and how often does it go out?
- Business model — per application, per user seat, subscription?
- GoDaddy plan — confirm VPS/dedicated (not shared/cPanel) if that's the eventual home
- Budget and timeline for Phase 1

# Automation worker

The Playwright service. Claims runs from the API, logs into a portal with the user's stored
credentials, applies to matching jobs, and reports what it did.

It holds no database credentials and no master key. Everything it is allowed to know arrives
over `/worker/*`, scoped to a run it currently owns.

## Run it

```bash
npm install
npx playwright install chromium     # ~430 MB, once
cp .env.example .env                # WORKER_API_TOKEN must match the API's

npm start        # claim runs until stopped
npm run once     # claim exactly one run, then exit — good for cron and for debugging
npm run e2e      # offline end-to-end against the local mock portal
```

`npm start` needs the API reachable and ready; it refuses to start otherwise rather than
spinning on a dead endpoint.

## Shape of a run

```
POST /worker/runs/claim            -> a run id, or 204 when the queue is empty
GET  /worker/runs/:id/context      -> profile, resume, filters, exclude list, budget
GET  /worker/runs/:id/credential   -> the password, decrypted and logged, once
POST /worker/runs/:id/session      -> persist storageState after login
POST /worker/runs/:id/applications -> record each submitted application (+ the description)
POST /worker/runs/:id/exceptions   -> OTP / CAPTCHA / lockout, then stop
GET  /worker/exceptions/:id        -> poll for the code ops entered
POST /worker/runs/:id/finish       -> counters and final status
```

[`src/run.ts`](src/run.ts) owns that sequence and every decision in it.
[`src/portals/`](src/portals/) owns the selectors. The run loop never touches a selector, so
adding a portal is a new file in `portals/` and a line in its `index.ts`.

## Match scoring

Before the apply flow is touched at all, the adapter opens the job's **own page** and returns
its full description — not the search-result snippet. That description is scored against the
résumé and the job is skipped unless it clears the run's threshold, which arrives in the run
context as `matching.threshold`.

Three things about this that are easy to undo by accident:

- **`fetchDescription` returning an empty string is a meaningful answer.** It scores zero and
  the job is skipped. An adapter that returned placeholder text on a selector miss would turn
  "we could not read it" into "it looked fine" — silently applying to everything, which is the
  exact failure the scoring exists to prevent.
- **[`src/matching-engine.ts`](src/matching-engine.ts) is a verbatim copy of
  `src/services/matching.ts` in the API.** The worker scores to decide whether to bother; the
  API rescores at the write and is the authority. If the two drift, the worker starts opening
  applications the API then rejects — visible only as unexplained 409s in a run log. The API's
  `npm run smoke` fails if they diverge, so change both together or neither.
- **The cap is a ceiling, not a target.** A run that scores 200 postings and clears none
  applies to nothing. `jobs_scored`, `jobs_below_threshold` and `best_score_missed` are
  reported at finish so a quiet day can be told apart from a broken one.

## The rules this code is built around

**An application is recorded only after a submission is confirmed.** `PortalAdapter.apply()`
may only return `{ ok: true }` when a post-submit confirmation was actually observed on the
page. The API records that as `bot_confirmed` and the dashboard reports it to a job seeker as
fact. A hopeful guess here becomes a lie to a person about their own job search.

**A run always reaches `/finish`.** Including when it throws — see the `finally` in
`executeRun`. A run left in `running` holds a queue slot forever and shows on the dashboard
as work in progress that will never complete.

**Nothing solves a challenge programmatically.** OTP, CAPTCHA and lockouts are raised to a
human and the run stops. For OTP the code comes from the user reading it back to ops; the
platform has no access to anyone's mailbox or phone and nothing here tries to get one.

**Unanswered screening questions abandon the application.** Never guessed at.

**A job below the match threshold is never opened.** The score gates the apply flow, not just
the record — so a weak match costs one page view, not an application in someone's name.

**The caps are the server's, not ours.** The daily cap and exclude list are re-checked by the
API under a row lock at the write. The client-side copies in [`src/matching.ts`](src/matching.ts)
exist only to avoid opening pages we already know we would not submit. `normalizeCompany`
there is a deliberate port of the API's — if that changes, change this with it.

## Pacing

Every wait is jittered. A worker applying exactly every 240s is a clearer signal than one
applying at all. `minMinutesBetweenApplications` comes from the user's record; `RunClock`
puts a ceiling on a single run so one wedged portal cannot hold a slot.

Concurrency is one run per process, deliberately: each run drives a real browser for a real
person's account, and the bottleneck is wall-clock politeness, not CPU. Scale with more
processes on distinct `WORKER_ID`s.

## Testing

`npm run e2e` starts a mock portal on `127.0.0.1:4310` and drives the real `executeRun()`
against it. Needs MySQL up, the API running, and `npm run seed` in the API for the ops login.

The mock's job descriptions are deliberately long. The matcher refuses to score anything under
200 characters, so a keyword stub would score every posting zero and leave the suite asserting
nothing — a trap this suite has already fallen into once. The same goes for its résumé
fixture, which is asserted to be over 400 characters for that reason.

It asserts both sides of the ledger — what the mock portal received, and what the API
recorded — and covers the OTP round trip, session reuse on a second run, exclude-list and
daily-cap enforcement, and the `bot_confirmed` vs `portal_scrape` distinction.

It also pins the threshold contract: the sample set is arranged so a run stops at 2 because
only 2 postings clear the bar, *not* because the cap of 3 was reached — and a second run with
a raised cap must apply to **nothing**, since everything left is below the bar.

The mock is reached through `WORKER_FORCE_ADAPTER=mock`, which overrides the adapter chosen
from the run's portal. That exists because `automation_runs.portal` is an enum of the three
real portals, so a test run has to claim to be one of them. Never set it in production.

## What is not verified

**The LinkedIn, Indeed and Dice selectors have never been run against a live logged-in
session.** They follow each site's published DOM conventions, but verifying them requires
real accounts and sends real applications to real employers. Expect to fix them on first
contact — the structure is the durable part, the selector strings are not.

Suggested order when you do: Dice first (conventional login, straightforward Easy Apply,
least aggressive device challenging), then LinkedIn, then Indeed — Indeed challenges
datacentre traffic hardest, and a residential proxy in the user's own region is close to a
precondition there.

Run against a portal account you own, with `WORKER_HEADLESS=false` so you can watch it, and
`npm run once` so it stops after a single run.

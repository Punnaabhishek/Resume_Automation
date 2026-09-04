# Ops console

The internal dashboard. Where a human does the parts the automation deliberately refuses to
do — most importantly, clearing verification prompts.

Next.js 15 (App Router), React 19, no CSS framework. It is a pure API client: no database
access, no server-side secrets, no business rules of its own.

## Run it

```bash
npm install
cp .env.example .env.local     # NEXT_PUBLIC_API_BASE_URL

npm run dev                    # http://localhost:3000
npm run build && npm start     # production
npm run smoke                  # browser smoke test, needs the API and this app running
```

The API must list this origin in its `CORS_ORIGINS`. `http://localhost:3000` is already
there by default, which is why this app is pinned to port 3000.

Sign in with an `org_members` account — `ops@example.com` / `ChangeMe123!` after
`npm run seed` in the API.

## Screens

| Route | What it is for |
| --- | --- |
| `/overview` | Volume, applications-over-time, portal split, anything waiting on a human |
| `/exceptions` | **The queue.** OTP, CAPTCHA, lockouts |
| `/runs` | Every automation pass, its counters, and cancel |
| `/applications` | The record, with confirmed vs scraped kept apart |
| `/users` | Job seeker records |
| `/users/new` | **Intake.** Onboard someone end to end without a terminal |
| `/users/[id]` | Activity · **Audit** · Setup · Reporting for one job seeker |

An operator never needs a terminal. `/users/new` walks the five stages in the order the API
enforces them, and `/users/[id]` → Setup covers everything afterwards: rotate a portal
password, add or pause a filter, edit the exclude list, replace the resume.

## The intake wizard

Deliberately sequential rather than tabbed, because the API enforces the same order — a
portal credential is refused until `credential_storage` consent is on file, and a run is
refused until there is a resume. Independent tabs would let an operator fill things in an
order that cannot succeed.

Each stage commits as it completes, so a failure at stage 4 keeps stages 1–3. The page says
where it stopped and the rest can be finished from the job seeker's Setup tab.

Passwords are **write-only** throughout: the field is cleared the moment it is saved, no
route returns a stored password, and `scripts/intake-ui.mjs` asserts the value never appears
anywhere in the rendered page.

## The per-user audit

The overview answers *how much are we doing*. The Audit tab answers the question an operator
actually gets asked by the person paying them: **what did you do for me, and when.**

Activity is grouped by UTC day — UTC because the daily cap resets on `UTC_DATE()`, so
grouping by anything else shows a day whose count disagrees with the cap that governed it.
Each day leads with the **roles searched and the companies applied to**, not a count: "3
applications" tells a job seeker nothing they care about.

A day with zero applications still gets a row, and says why. *"Scored 12 postings; none
cleared the match bar, closest was 91"* and *"no run happened"* are completely different
situations that a bare `0` renders identically — and the first is the automation working
correctly, not a fault.

The overview carries the other half: one row per active job seeker with today's count against
their own cap, the roles applied for, and the companies.

## Live refresh

The worker records an application the instant it submits one, so the data was always
immediate — the gap was only the UI. `useApi` takes a `pollMs` option; the job-seeker page
and the applications list refresh every five seconds and show a **Live** marker.

Polling rather than anything push-based, deliberately: it is a handful of reads on an internal
tool, it survives a dropped connection with no reconnect logic to get wrong, and it stops
entirely while the tab is hidden. Two details that matter in use — background ticks skip the
loading state, so a refreshing table never flickers into skeletons; and a *failed* poll keeps
the last good data on screen rather than replacing a working table with an error banner.

## The exception queue

This is the screen the platform is built around, so it gets the most care.

The flow it supports: automation hits a verification prompt and stops → the operator claims
the exception → they call the job seeker → **the job seeker reads the code back** → the
operator types it in → the worker polls once and consumes it.

The card spells that script out, because the failure mode is an operator improvising and
asking for something they should not. It also states plainly that no screen will show them
the portal password, so they never go looking for it.

Three things the UI enforces:

- **Claim before working.** Two operators must not work the same lockout at once.
- **A code is single-use and short-lived.** After sending, the card shows a live countdown
  from five minutes, and says outright that the code can only be used once. When it expires
  unused the card says so and tells the operator to ask for a fresh one, rather than leaving
  them wondering why nothing happened.
- **Resolving is a separate act from supplying a code.** The resolution dropdown records
  *what actually happened*, and a checkbox controls whether the account is fit to be
  automated again — defaulted to match the API's own behaviour rather than guessed.

## Confirmed vs scraped

The `SourcePill` component is the most load-bearing thing in `components/ui.tsx`.

**Confirmed** means the worker watched the submission succeed. **Scraped** means the status
was read off the portal's own page and is only as complete as that page is. The two are never
merged, and only the first is safe to report to a job seeker as fact. Every table that shows
an application status shows its source beside it.

## US-only, UTC-only

Country and timezone are constants in `lib/region.ts`, not fields. The intake form shows
them as settled facts rather than inputs, and state is a dropdown of US states.

Every timestamp is rendered in UTC and says `UTC`. That is not a formatting preference: the
daily application cap resets on `UTC_DATE()` server-side, so showing local time would make
the console disagree with what the API enforces about how many applications are left today.
`absoluteTime` and the chart's axis labels both pin the timezone explicitly.

## Conventions

**Roles, skills and excluded companies are combo-boxes, not dropdowns.** See
[`components/TagSelect.tsx`](src/components/TagSelect.tsx). None of the three is a closed
set: a job seeker's target role may not be in any list we ship, skills appear faster than a
taxonomy can be maintained, and the companies someone refuses to apply to are by definition
specific to them. A dropdown that cannot express the real answer produces a *wrong* record,
not a tidy one — so each offers suggestions and accepts free text. City works the same way,
backed by a datalist of the common metros.

**Names are captured in parts.** First / middle / last, because those are the fields portal
application forms ask for one by one. The API composes `fullName` from them, and recomposes
it when a part is later edited, so the display name cannot drift from the parts underneath it.

**Response shapes are not guessed.** `lib/types.ts` mirrors the `present()` functions in the
API's route modules. If a shape here disagrees with the API, the API is right — and two of
these types were wrong on the first pass precisely because they were guessed rather than
read, so check the enum in `db/migrations/001_init.sql` before adding one.

**One data hook.** `lib/useApi.ts` handles the case that actually matters operationally: an
expired token arrives as a 401 on whatever call happens next, and must send the operator to
the login screen rather than showing them an empty table that looks like real data.

**Only one thing polls.** The open-exception count in the sidebar, every 20 seconds, because
it is the only number that changes without the operator doing anything. Everything else
refreshes on navigation or on an explicit Refresh.

**Severity is not carried by color alone.** Rows get a left stripe as well as a pill, so a
dense table still reads at a glance.

## Charts

Series colour carries portal identity in a fixed order and is never cycled, so filtering a
portal out does not repaint the survivors. Both palettes were validated for lightness band,
chroma floor, colour-vision separation and contrast against their own surface — the dark
steps are chosen for the dark surface, not an inversion of the light ones. **Re-validate if
either set changes**; the amber and red in this app are reserved for status and are never
used as a series colour.

Identity is never colour alone: every series appears in the legend and is named in the
tooltip. A single time bucket renders the figures instead of a chart, because a line through
one point is empty space that says less than the numbers do.

`observedResponses` is labelled a **floor, never a response rate** — replies a portal never
displays are invisible to us, so the true figure can only be higher. The smoke test asserts
that caveat is on screen wherever the number is.

## Match scores on screen

Every table showing an application shows the score that let it through, and the hover text
names each component and its contribution. That is deliberate: a table of applications without
it says "we applied to 40 things" and hides the only question that matters, which is whether
they were the right forty.

The score is presented as a number from a text-matching function, never as a verdict — the
breakdown is there so an operator can see what drove it rather than trust it.

## Not built here

- **Proxies and reports.** The API has routes for both; this console does not surface them.
- **Editing a profile after intake.** Status changes and pacing are adjustable, but name,
  email and location are read-only once created — use the API.
- **Server-side session storage.** The JWT lives in `localStorage`, which is appropriate for
  an internal tool on a trusted network and is not appropriate if this is ever exposed
  publicly.
- **Role-gated UI.** The API enforces roles — an analyst gets a 403 on a write and the error
  surfaces — but the console still renders buttons an analyst cannot use.

## Working on this

**Never run `npm run build` while `npm run dev` is running.** The build overwrites `.next/`,
the running dev server then 404s every chunk, and the page loads but never hydrates — forms
render with their server-side `disabled` state and nothing responds. It looks like a code
bug and is not one. Stop dev, build, delete `.next`, start dev again.

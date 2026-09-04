'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { ConsentType, Portal } from '@/lib/types';
import { ErrorBanner, Panel, Pill } from '@/components/ui';
import { COMMON_LOCATIONS, COUNTRY, COUNTRY_LABEL, TIMEZONE, US_STATES } from '@/lib/region';

/**
 * Intake, in order, in one screen.
 *
 * Deliberately sequential rather than tabbed: the API enforces the same order — a portal
 * credential is refused until credential_storage consent is on file, and a run is refused
 * until there is a resume — so presenting these as independent tabs would let an operator
 * fill them in an order that cannot succeed.
 *
 * Each stage commits as it completes. If a later stage fails, the earlier work is already
 * saved and the page says exactly where it stopped, so intake is resumable from the job
 * seeker's page rather than having to start over.
 */

const CONSENTS: { type: ConsentType; label: string; why: string }[] = [
  {
    type: 'credential_storage',
    label: 'Store portal credentials',
    why: 'Required before a password can be saved. The API refuses the credential without it.',
  },
  {
    type: 'automated_apply',
    label: 'Apply on their behalf',
    why: 'Required before any run is queued. Revoking it later cancels queued work immediately.',
  },
  {
    type: 'data_processing',
    label: 'Process their personal data',
    why: 'Covers the resume, contact details and application history.',
  },
];

const PORTALS: Portal[] = ['linkedin', 'indeed', 'dice'];
const SENIORITIES = ['intern', 'entry', 'associate', 'mid', 'senior', 'lead', 'principal', 'director', 'any'];

type Stage = 'profile' | 'consent' | 'resume' | 'credentials' | 'filter' | 'done';

const STAGE_ORDER: Stage[] = ['profile', 'consent', 'resume', 'credentials', 'filter', 'done'];

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function NewUserPage() {
  const router = useRouter();

  const [stage, setStage] = useState<Stage>('profile');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);

  // Profile
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // Country and timezone are platform policy, not per-person settings — see lib/region.ts.
  const [stateRegion, setStateRegion] = useState('');
  const [city, setCity] = useState('');
  const [designations, setDesignations] = useState('');
  const [skills, setSkills] = useState('');
  const [dailyCap, setDailyCap] = useState('15');
  const [minGap, setMinGap] = useState('6');
  const [excluded, setExcluded] = useState('');
  const [notes, setNotes] = useState('');

  // Consent evidence
  const [consentVersion, setConsentVersion] = useState('v1');
  const [capturedVia, setCapturedVia] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');

  // Resume
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [parseNote, setParseNote] = useState<string | null>(null);

  // Credentials
  const [credPortal, setCredPortal] = useState<Portal>('dice');
  const [credUser, setCredUser] = useState('');
  const [credPass, setCredPass] = useState('');
  const [savedPortals, setSavedPortals] = useState<Portal[]>([]);

  // First filter
  const [filterName, setFilterName] = useState('');
  const [filterDesignation, setFilterDesignation] = useState('');
  const [filterKeywords, setFilterKeywords] = useState('');
  const [filterExcluded, setFilterExcluded] = useState('internship, unpaid');
  const [filterLocations, setFilterLocations] = useState('');
  const [filterSeniority, setFilterSeniority] = useState('any');
  const [filterPortals, setFilterPortals] = useState<Portal[]>([]);

  function markDone(label: string) {
    setDone((prev) => [...prev, label]);
  }

  function describe(err: unknown): string {
    if (err instanceof ApiError) {
      return err.details?.length ? `${err.message} — ${err.details.join('; ')}` : err.message;
    }
    return err instanceof Error ? err.message : 'That did not work.';
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  const submitProfile = () =>
    run(async () => {
      const user = await api.createUser({
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        country: COUNTRY,
        state: stateRegion || undefined,
        city: city.trim() || undefined,
        timezone: TIMEZONE,
        targetDesignations: splitList(designations),
        keySkills: splitList(skills),
        intakeChannel: 'form',
        dailyApplicationCap: Number(dailyCap) || undefined,
        minMinutesBetweenApplications: minGap === '' ? undefined : Number(minGap),
        excludedCompanies: splitList(excluded).map((companyName) => ({ companyName, reason: 'other' })),
        notes: notes.trim() || undefined,
      });
      setUserId(user.id);
      setCredUser(email.trim());
      setFilterDesignation(splitList(designations)[0] ?? '');
      markDone(`Profile created for ${user.fullName}`);
      setStage('consent');
    });

  const submitConsents = () =>
    run(async () => {
      for (const consent of CONSENTS) {
        await api.addConsent(userId, {
          consentType: consent.type,
          version: consentVersion.trim() || 'v1',
          capturedVia: capturedVia.trim() || undefined,
          evidenceRef: evidenceRef.trim() || undefined,
        });
      }
      markDone('All three consents recorded');
      setStage('resume');
    });

  const submitResume = () =>
    run(async () => {
      if (!resumeFile) throw new Error('Choose a resume file first.');
      const resume = await api.uploadResume(userId, resumeFile, true);
      setParseNote(
        resume.parseStatus === 'parsed'
          ? `Parsed${resume.parsed?.yearsExperience ? ` — ${resume.parsed.yearsExperience} years detected` : ''}`
          : `Stored, but parsing ${resume.parseStatus}${resume.parseError ? `: ${resume.parseError}` : ''}`,
      );
      markDone(`Resume uploaded (${resume.fileName})`);
      setStage('credentials');
    });

  const submitCredential = () =>
    run(async () => {
      const connection = await api.addConnection(userId, {
        portal: credPortal,
        username: credUser.trim(),
        password: credPass,
      });
      setSavedPortals((prev) => (prev.includes(credPortal) ? prev : [...prev, credPortal]));
      setFilterPortals((prev) => (prev.includes(credPortal) ? prev : [...prev, credPortal]));
      markDone(
        `${credPortal} credentials encrypted${connection.proxyId ? ' and proxy assigned' : ' (no proxy available)'}`,
      );
      // Cleared immediately — there is no reason for it to stay in memory or in the field.
      setCredPass('');
    });

  const submitFilter = () =>
    run(async () => {
      if (!filterPortals.length) throw new Error('Pick at least one portal for this filter.');
      await api.createFilter(userId, {
        name: filterName.trim() || 'Primary search',
        designation: filterDesignation.trim(),
        keywords: splitList(filterKeywords),
        excludedKeywords: splitList(filterExcluded),
        locations: splitList(filterLocations),
        seniority: filterSeniority,
        portals: filterPortals,
        priority: 10,
      });
      markDone(`Filter created for ${filterPortals.join(', ')}`);
      await api.updateUser(userId, { status: 'active' });
      markDone('Activated — automation can now be queued');
      setStage('done');
    });

  const stageIndex = STAGE_ORDER.indexOf(stage);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">
          <Link href="/users">Job seekers</Link> / new
        </div>
        <h1>Onboard a job seeker</h1>
        <p className="subtle">
          Five stages, in this order, because the API enforces the same order — a portal
          password is refused without consent on file, and a run is refused without a resume.
          Each stage saves as it completes.
        </p>
      </div>

      {done.length > 0 && (
        <div className="banner banner-ok">
          <strong>Saved so far</strong>
          <ul>
            {done.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <ErrorBanner error={error} />}

      {/* ---------- 1. profile ---------- */}
      {stage === 'profile' && (
        <Panel title="1 · Who they are">
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              submitProfile();
            }}
          >
            <div className="dl">
              <label className="field">
                Full name
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} required autoFocus />
              </label>
              <label className="field">
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label className="field">
                Phone
                <input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <label className="field">
                Country
                <span className="fixed-value">
                  {COUNTRY_LABEL}
                  <span className="fixed-note">US-only platform</span>
                </span>
              </label>
              <label className="field">
                State
                <select value={stateRegion} onChange={(e) => setStateRegion(e.target.value)}>
                  <option value="">Select a state…</option>
                  {US_STATES.map((s) => (
                    <option key={s.code} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                City
                <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Austin" />
              </label>
              <label className="field">
                Timezone
                <span className="fixed-value">
                  {TIMEZONE}
                  <span className="fixed-note">Caps reset on UTC midnight</span>
                </span>
              </label>
              <label className="field">
                Daily application cap
                <input type="number" min={1} max={200} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
              </label>
              <label className="field">
                Minutes between applications
                <input type="number" min={0} max={1440} value={minGap} onChange={(e) => setMinGap(e.target.value)} />
              </label>
            </div>

            <label className="field">
              Target roles <span style={{ fontWeight: 400, color: 'var(--muted)' }}>comma separated, at least one</span>
              <input
                value={designations}
                onChange={(e) => setDesignations(e.target.value)}
                placeholder="Senior Backend Engineer, Backend Engineer"
                required
              />
            </label>
            <label className="field">
              Key skills <span style={{ fontWeight: 400, color: 'var(--muted)' }}>comma separated</span>
              <input
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
                placeholder="Node.js, TypeScript, MySQL"
              />
            </label>
            <label className="field">
              Companies never to apply to{' '}
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                comma separated — current employer usually belongs here
              </span>
              <input
                value={excluded}
                onChange={(e) => setExcluded(e.target.value)}
                placeholder="Acme Corp, Globex Inc"
              />
            </label>
            <label className="field">
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>

            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save and continue'}
              </button>
              <Link href="/users" className="btn">
                Cancel
              </Link>
            </div>
          </form>
        </Panel>
      )}

      {/* ---------- 2. consent ---------- */}
      {stage === 'consent' && (
        <Panel title="2 · What they authorized">
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              submitConsents();
            }}
          >
            <p className="subtle">
              Record this from a signed form or a recorded conversation you already have. All
              three are captured together, against the same evidence.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {CONSENTS.map((consent) => (
                <div key={consent.type} className="otp-script">
                  <strong>{consent.label}</strong>
                  <div style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>{consent.why}</div>
                </div>
              ))}
            </div>

            <div className="dl">
              <label className="field">
                Consent version
                <input value={consentVersion} onChange={(e) => setConsentVersion(e.target.value)} required />
              </label>
              <label className="field">
                How it was captured
                <input
                  value={capturedVia}
                  onChange={(e) => setCapturedVia(e.target.value)}
                  placeholder="signed intake form over WhatsApp"
                />
              </label>
              <label className="field">
                Evidence reference
                <input
                  value={evidenceRef}
                  onChange={(e) => setEvidenceRef(e.target.value)}
                  placeholder="drive://intake/2026-09-03/consent.pdf"
                />
              </label>
            </div>

            <div className="banner banner-warn">
              This is the record you will rely on if anyone asks why you held this
              person&apos;s password. Point the evidence reference at something that actually
              exists.
            </div>

            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Recording…' : 'Record all three and continue'}
              </button>
            </div>
          </form>
        </Panel>
      )}

      {/* ---------- 3. resume ---------- */}
      {stage === 'resume' && (
        <Panel title="3 · Their resume">
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              submitResume();
            }}
          >
            <p className="subtle">
              PDF, DOCX or plain text. The worker hands this file to the portal&apos;s upload
              field, and the API parses it for autofill. A run will not be queued without one.
            </p>
            <label className="field">
              Resume file
              <input
                type="file"
                accept=".pdf,.docx,.txt,text/plain,application/pdf"
                onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
                required
              />
            </label>
            <div className="actions">
              <button type="submit" className="primary" disabled={busy || !resumeFile}>
                {busy ? 'Uploading…' : 'Upload and continue'}
              </button>
            </div>
          </form>
        </Panel>
      )}

      {/* ---------- 4. credentials ---------- */}
      {stage === 'credentials' && (
        <Panel title="4 · Portal logins">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {parseNote && <div className="banner banner-info">{parseNote}</div>}

            <p className="subtle">
              Enter one portal at a time. The password is encrypted the moment it arrives and
              is <strong>write-only</strong> — no screen in this console, and no route in the
              API, will ever show it back to you or to anyone else.
            </p>

            {savedPortals.length > 0 && (
              <div className="actions">
                {savedPortals.map((p) => (
                  <Pill key={p} tone="ok">
                    {p} saved
                  </Pill>
                ))}
              </div>
            )}

            <form
              className="dl"
              onSubmit={(e) => {
                e.preventDefault();
                submitCredential();
              }}
            >
              <label className="field">
                Portal
                <select value={credPortal} onChange={(e) => setCredPortal(e.target.value as Portal)}>
                  {PORTALS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Their username on that portal
                <input value={credUser} onChange={(e) => setCredUser(e.target.value)} required />
              </label>
              <label className="field">
                Their password
                <input
                  type="password"
                  value={credPass}
                  onChange={(e) => setCredPass(e.target.value)}
                  autoComplete="off"
                  required
                />
              </label>
              <div className="dl-item" style={{ justifyContent: 'flex-end' }}>
                <button type="submit" className="primary" disabled={busy || !credPass || !credUser}>
                  {busy ? 'Encrypting…' : `Save ${credPortal}`}
                </button>
              </div>
            </form>

            <div className="actions">
              <button
                className="primary"
                disabled={busy || savedPortals.length === 0}
                onClick={() => {
                  setError(null);
                  setStage('filter');
                }}
              >
                Continue
              </button>
              {savedPortals.length === 0 && (
                <span className="subtle">Save at least one portal to continue.</span>
              )}
            </div>
          </div>
        </Panel>
      )}

      {/* ---------- 5. filter ---------- */}
      {stage === 'filter' && (
        <Panel title="5 · What to apply to">
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              submitFilter();
            }}
          >
            <p className="subtle">
              This is the search the automation runs. You can add more filters later from their
              page; one is enough to start.
            </p>

            <div className="dl">
              <label className="field">
                Filter name
                <input
                  value={filterName}
                  onChange={(e) => setFilterName(e.target.value)}
                  placeholder="Primary search"
                />
              </label>
              <label className="field">
                Role title to search
                <input value={filterDesignation} onChange={(e) => setFilterDesignation(e.target.value)} required />
              </label>
              <label className="field">
                Seniority
                <select value={filterSeniority} onChange={(e) => setFilterSeniority(e.target.value)}>
                  {SENIORITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field">
              Keywords <span style={{ fontWeight: 400, color: 'var(--muted)' }}>comma separated, at least one</span>
              <input
                value={filterKeywords}
                onChange={(e) => setFilterKeywords(e.target.value)}
                placeholder="node.js, typescript, backend"
                required
              />
            </label>
            <label className="field">
              Skip listings mentioning{' '}
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}>comma separated</span>
              <input value={filterExcluded} onChange={(e) => setFilterExcluded(e.target.value)} />
            </label>
            <label className="field">
              Locations <span style={{ fontWeight: 400, color: 'var(--muted)' }}>comma separated</span>
              <input
                value={filterLocations}
                onChange={(e) => setFilterLocations(e.target.value)}
                placeholder="Remote, New York NY, Austin TX"
              />
            </label>
            <div className="chips">
              {COMMON_LOCATIONS.map((place) => {
                const already = splitList(filterLocations).includes(place);
                return (
                  <button
                    type="button"
                    key={place}
                    className="chip-btn"
                    aria-pressed={already}
                    onClick={() =>
                      setFilterLocations((prev) => {
                        const parts = splitList(prev);
                        const next = already ? parts.filter((p) => p !== place) : [...parts, place];
                        return next.join(', ');
                      })
                    }
                  >
                    {already ? '✓ ' : '+ '}
                    {place}
                  </button>
                );
              })}
            </div>

            <label className="field">
              Portals to search
              <div className="actions">
                {savedPortals.map((p) => (
                  <label
                    key={p}
                    style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', fontWeight: 400 }}
                  >
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={filterPortals.includes(p)}
                      onChange={(e) =>
                        setFilterPortals((prev) =>
                          e.target.checked ? [...prev, p] : prev.filter((x) => x !== p),
                        )
                      }
                    />
                    {p}
                  </label>
                ))}
              </div>
            </label>

            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save filter and activate'}
              </button>
            </div>
          </form>
        </Panel>
      )}

      {/* ---------- done ---------- */}
      {stage === 'done' && (
        <Panel title="Ready to automate">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p className="subtle">
              {fullName} is active. Queue a run from their page and the worker will pick it up
              within about twenty seconds. If the portal asks for a verification code, it will
              appear in the exception queue.
            </p>
            <div className="actions">
              <button className="primary" onClick={() => router.push(`/users/${userId}`)}>
                Go to their page
              </button>
              <Link href="/users/new" className="btn" onClick={() => window.location.reload()}>
                Onboard another
              </Link>
            </div>
          </div>
        </Panel>
      )}

      {stage !== 'done' && (
        <p className="subtle">
          Stage {stageIndex + 1} of 5. {userId ? 'Work so far is saved — you can leave and resume from their page.' : ''}
        </p>
      )}
    </>
  );
}

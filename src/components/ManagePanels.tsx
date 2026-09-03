'use client';

import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { absoluteTime, humanize, relativeTime } from '@/lib/format';
import type { Consent, ExcludedCompany, FilterSummary, Portal, Resume } from '@/lib/types';
import { Empty, Panel, Pill } from './ui';

/**
 * The write half of a job seeker's page: add a portal login, add or retire a filter, manage
 * the exclude list, replace the resume, revoke a consent.
 *
 * Everything here is a thin form over one API route, on purpose. The rules — consent gating,
 * cap enforcement, credential encryption — live server-side, so these forms only need to
 * collect input and report back what the API said.
 */

const PORTALS: Portal[] = ['linkedin', 'indeed', 'dice'];
const SENIORITIES = ['intern', 'entry', 'associate', 'mid', 'senior', 'lead', 'principal', 'director', 'any'];
const EXCLUDE_REASONS = ['current_employer', 'past_employer', 'competitor', 'personal', 'other'];

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    return err.details?.length ? `${err.message} — ${err.details.join('; ')}` : err.message;
  }
  return err instanceof Error ? err.message : 'That did not work.';
}

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const message = await action();
      if (typeof message === 'string') setNote(message);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, note, run };
}

function Feedback({ error, note }: { error: string | null; note: string | null }) {
  if (error) return <div className="banner banner-error">{error}</div>;
  if (note) return <div className="banner banner-ok">{note}</div>;
  return null;
}

/* ------------------------------------------------------------------ credentials */

export function CredentialPanel({ userId, onDone }: { userId: string; onDone: () => void }) {
  const { busy, error, note, run } = useAction(onDone);
  const [portal, setPortal] = useState<Portal>('dice');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <Panel
      title="Add or rotate a portal login"
      action={
        <button className="small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Add login'}
        </button>
      }
    >
      <p className="subtle">
        Submitting the same portal again rotates the stored password. It is encrypted on
        arrival and <strong>write-only</strong> — nothing in this console or the API will show
        it back to you afterwards.
      </p>

      <Feedback error={error} note={note} />

      {open && (
        <form
          className="dl"
          style={{ marginTop: '0.9rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const connection = await api.addConnection(userId, {
                portal,
                username: username.trim(),
                password,
              });
              // Cleared straight away; there is no reason to keep it in the field.
              setPassword('');
              setOpen(false);
              return `${portal} saved${connection.proxyId ? ' with a proxy assigned' : ' — no proxy was available'}`;
            });
          }}
        >
          <label className="field">
            Portal
            <select value={portal} onChange={(e) => setPortal(e.target.value as Portal)}>
              {PORTALS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Username on that portal
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
          <div className="dl-item" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="primary" disabled={busy || !password || !username}>
              {busy ? 'Encrypting…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------------- filters */

export function FiltersPanel({
  userId,
  filters,
  onDone,
}: {
  userId: string;
  filters: FilterSummary[];
  onDone: () => void;
}) {
  const { busy, error, note, run } = useAction(onDone);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [designation, setDesignation] = useState('');
  const [keywords, setKeywords] = useState('');
  const [excludedKeywords, setExcludedKeywords] = useState('');
  const [locations, setLocations] = useState('');
  const [seniority, setSeniority] = useState('any');
  const [portals, setPortals] = useState<Portal[]>([]);

  const split = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

  return (
    <Panel
      title="Search filters"
      action={
        <button className="small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Add filter'}
        </button>
      }
    >
      <Feedback error={error} note={note} />

      {filters.length === 0 ? (
        <Empty title="No filters" note="Automation has nothing to search for until one exists." />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role searched</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filters.map((filter) => (
                <tr key={filter.id}>
                  <td className="primary">{filter.name}</td>
                  <td>{filter.designation}</td>
                  <td className="tight">
                    {filter.is_active ? <Pill tone="ok">Active</Pill> : <Pill tone="neutral">Paused</Pill>}
                  </td>
                  <td className="tight">
                    <div className="actions">
                      <button
                        className="small"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api.updateFilter(filter.id, { isActive: !filter.is_active });
                            return filter.is_active ? 'Filter paused' : 'Filter resumed';
                          })
                        }
                      >
                        {filter.is_active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        className="small danger"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api.deleteFilter(filter.id);
                            return 'Filter deleted';
                          })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', marginTop: '1rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (!portals.length) throw new Error('Pick at least one portal.');
              await api.createFilter(userId, {
                name: name.trim() || 'Search',
                designation: designation.trim(),
                keywords: split(keywords),
                excludedKeywords: split(excludedKeywords),
                locations: split(locations),
                seniority,
                portals,
              });
              setOpen(false);
              setName('');
              setKeywords('');
              return 'Filter created';
            });
          }}
        >
          <div className="dl">
            <label className="field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Search" />
            </label>
            <label className="field">
              Role title to search
              <input value={designation} onChange={(e) => setDesignation(e.target.value)} required />
            </label>
            <label className="field">
              Seniority
              <select value={seniority} onChange={(e) => setSeniority(e.target.value)}>
                {SENIORITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            Keywords <span style={{ fontWeight: 400, color: 'var(--muted)' }}>comma separated</span>
            <input value={keywords} onChange={(e) => setKeywords(e.target.value)} required />
          </label>
          <label className="field">
            Skip listings mentioning
            <input value={excludedKeywords} onChange={(e) => setExcludedKeywords(e.target.value)} />
          </label>
          <label className="field">
            Locations
            <input value={locations} onChange={(e) => setLocations(e.target.value)} />
          </label>
          <label className="field">
            Portals
            <div className="actions">
              {PORTALS.map((p) => (
                <label key={p} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={portals.includes(p)}
                    onChange={(e) =>
                      setPortals((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))
                    }
                  />
                  {p}
                </label>
              ))}
            </div>
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Create filter'}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- exclude list */

export function ExcludePanel({
  userId,
  companies,
  onDone,
}: {
  userId: string;
  companies: ExcludedCompany[];
  onDone: () => void;
}) {
  const { busy, error, note, run } = useAction(onDone);
  const [company, setCompany] = useState('');
  const [reason, setReason] = useState('other');

  return (
    <Panel title="Never apply to">
      <p className="subtle">
        Matched on a normalized name, so &ldquo;Acme Technologies Pvt. Ltd.&rdquo; also blocks
        &ldquo;ACME TECHNOLOGIES PRIVATE LIMITED&rdquo;. Enforced again server-side at the moment
        an application is recorded.
      </p>

      <Feedback error={error} note={note} />

      <div className="chips" style={{ margin: '0.8rem 0' }}>
        {companies.length === 0 && <span className="subtle">Nothing excluded yet.</span>}
        {companies.map((c) => (
          <span className="chip" key={c.id}>
            {c.companyName}
            <span style={{ color: 'var(--faint)' }}> · {humanize(c.reason)}</span>
            <button
              className="ghost small"
              style={{ padding: '0 0.25rem', marginLeft: '0.25rem' }}
              disabled={busy}
              title={`Remove ${c.companyName}`}
              onClick={() =>
                run(async () => {
                  await api.removeExcludedCompany(userId, c.id);
                  return `${c.companyName} removed`;
                })
              }
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.addExcludedCompany(userId, company.trim(), reason);
            setCompany('');
            return 'Added to the exclude list';
          });
        }}
      >
        <label className="field">
          Company
          <input value={company} onChange={(e) => setCompany(e.target.value)} required />
        </label>
        <label className="field">
          Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {EXCLUDE_REASONS.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary small" disabled={busy || !company.trim()}>
          Add
        </button>
      </form>
    </Panel>
  );
}

/* --------------------------------------------------------------------- consents */

export function ConsentPanel({ consents }: { consents: Consent[] }) {
  const active = consents.filter((c) => !c.revoked_at);

  return (
    <Panel title="Consent on file">
      <p className="subtle">
        <code>credential_storage</code> gates saving a password and <code>automated_apply</code>{' '}
        gates the queue — both server-side. Revoking the latter pauses the person and cancels
        their queued runs in the same request.
      </p>
      <div className="dl" style={{ marginTop: '0.9rem' }}>
        {(['credential_storage', 'automated_apply', 'data_processing'] as const).map((type) => {
          const granted = active.find((c) => c.consent_type === type);
          return (
            <div className="dl-item" key={type}>
              <span className="dl-key">{humanize(type)}</span>
              <span className="dl-val">
                {granted ? (
                  <>
                    <Pill tone="ok">On file</Pill>{' '}
                    <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                      {granted.version} · {relativeTime(granted.granted_at)}
                    </span>
                  </>
                ) : (
                  <Pill tone="crit">Missing</Pill>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------- resumes */

export function ResumePanel({
  userId,
  resumes,
  onDone,
}: {
  userId: string;
  resumes: Resume[];
  onDone: () => void;
}) {
  const { busy, error, note, run } = useAction(onDone);
  const [file, setFile] = useState<File | null>(null);

  return (
    <Panel title="Resume">
      <p className="subtle">
        The newest primary resume is the file the worker hands to the portal&apos;s upload field.
      </p>

      <Feedback error={error} note={note} />

      {resumes.length === 0 ? (
        <Empty title="No resume on file" note="A run cannot be queued without one." />
      ) : (
        <div className="table-scroll" style={{ margin: '0.8rem 0' }}>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Primary</th>
                <th>Parsed</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {resumes.map((r) => (
                <tr key={r.id}>
                  <td className="primary">{r.fileName}</td>
                  <td className="tight">{r.isPrimary ? <Pill tone="ok">Primary</Pill> : '—'}</td>
                  <td className="tight">
                    {r.parseStatus === 'parsed' ? (
                      <Pill tone="ok" title={r.parsed?.yearsExperience ? `${r.parsed.yearsExperience} years` : undefined}>
                        Parsed
                      </Pill>
                    ) : (
                      <Pill tone="warn" title={r.parseError ?? undefined}>
                        {humanize(r.parseStatus)}
                      </Pill>
                    )}
                  </td>
                  <td className="tight" title={absoluteTime(r.createdAt)}>
                    {relativeTime(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            if (!file) throw new Error('Choose a file first.');
            const uploaded = await api.uploadResume(userId, file, true);
            setFile(null);
            return uploaded.parseStatus === 'parsed'
              ? `${uploaded.fileName} uploaded and parsed`
              : `${uploaded.fileName} uploaded, but parsing ${uploaded.parseStatus}`;
          });
        }}
      >
        <label className="field">
          Replace with
          <input
            type="file"
            accept=".pdf,.docx,.txt,text/plain,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button type="submit" className="primary small" disabled={busy || !file}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </form>
    </Panel>
  );
}

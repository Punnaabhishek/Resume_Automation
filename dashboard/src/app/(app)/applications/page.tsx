'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { absoluteTime, relativeTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import {
  ApplicationStatusPill,
  Empty,
  ErrorBanner,
  Loading,
  Panel,
  PortalPill,
  SourcePill,
  MatchScore,
} from '@/components/ui';

const STATUSES = [
  'applied',
  'viewed',
  'in_consideration',
  'interview',
  'offer',
  'rejected',
  'no_response',
  'unknown',
];
const PORTALS = ['linkedin', 'indeed', 'dice'];

export default function ApplicationsPage() {
  const [status, setStatus] = useState('');
  const [portal, setPortal] = useState('');

  // Live: the worker records an application the instant it submits one, so an operator
  // watching a run should see it land rather than have to guess and hit Refresh.
  const { data, error, loading, reload } = useApi(
    () => api.applications({ status: status || undefined, portal: portal || undefined }),
    [status, portal],
    { pollMs: 5_000 },
  );

  const rows = data ?? [];
  const confirmed = rows.filter((r) => r.statusSource === 'bot_confirmed').length;

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="eyebrow">Record</div>
            <h1>Applications</h1>
          </div>
          <div className="actions">
            <span className="live" title="This page re-checks the API every few seconds.">
              <span className="live-dot" />
              Live
            </span>
            <button className="small" onClick={reload}>
              Refresh
            </button>
          </div>
        </div>
        <p className="subtle">
          <strong>Confirmed</strong> means the worker watched the submission succeed.{' '}
          <strong>Scraped</strong> means the status was read off the portal&apos;s own page and is
          only as complete as that page is. The two are never merged, and only the first is safe to
          report to a job seeker as fact.
        </p>
      </div>

      <div className="filters">
        <label className="field">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Portal
          <select value={portal} onChange={(e) => setPortal(e.target.value)}>
            <option value="">Any</option>
            {PORTALS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        {!loading && rows.length > 0 && (
          <span className="subtle" style={{ paddingBottom: '0.5rem' }}>
            {rows.length} shown · {confirmed} confirmed
          </span>
        )}
      </div>

      {error && <ErrorBanner error={error} onRetry={reload} />}

      <Panel flush>
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            title="No applications match"
            note="Nothing has been submitted yet, or the filters above exclude everything."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Company</th>
                  <th>Job seeker</th>
                  <th>Portal</th>
                  <th>Match</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Applied</th>
                  <th>Last checked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="primary">
                      <div className="cell-stack">
                        {row.jobUrl ? (
                          <a href={row.jobUrl} target="_blank" rel="noreferrer noopener">
                            {row.jobTitle}
                          </a>
                        ) : (
                          row.jobTitle
                        )}
                        {row.location && <span className="cell-sub">{row.location}</span>}
                      </div>
                    </td>
                    <td>{row.company}</td>
                    <td>
                      <Link href={`/users/${row.user.id}`}>{row.user.fullName}</Link>
                    </td>
                    <td className="tight">
                      <PortalPill portal={row.portal} />
                    </td>
                    <td className="tight">
                      <MatchScore score={row.matchScore} breakdown={row.matchBreakdown} />
                    </td>
                    <td className="tight">
                      <div className="cell-stack">
                        <ApplicationStatusPill status={row.status} />
                        {row.statusDetail && <span className="cell-sub">{row.statusDetail}</span>}
                      </div>
                    </td>
                    <td className="tight">
                      <SourcePill source={row.statusSource} />
                    </td>
                    <td className="tight" title={absoluteTime(row.appliedAt)}>
                      {relativeTime(row.appliedAt)}
                    </td>
                    <td className="tight" title={absoluteTime(row.lastCheckedAt)}>
                      {relativeTime(row.lastCheckedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

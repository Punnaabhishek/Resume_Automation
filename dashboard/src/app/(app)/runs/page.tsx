'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { absoluteTime, duration, relativeTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { Empty, ErrorBanner, Loading, Panel, PortalPill, RunStatusPill } from '@/components/ui';

const STATUSES = ['queued', 'claimed', 'running', 'succeeded', 'partial', 'failed', 'blocked', 'cancelled'];
const PORTALS = ['linkedin', 'indeed', 'dice'];

export default function RunsPage() {
  const [status, setStatus] = useState('');
  const [portal, setPortal] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, loading, reload } = useApi(
    () => api.runs({ status: status || undefined, portal: portal || undefined }),
    [status, portal],
  );

  const runs = data ?? [];

  async function cancel(id: string) {
    setCancelling(id);
    setActionError(null);
    try {
      await api.cancelRun(id);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not cancel that run.');
    } finally {
      setCancelling(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="eyebrow">Automation</div>
            <h1>Runs</h1>
          </div>
          <button className="small" onClick={reload}>
            Refresh
          </button>
        </div>
        <p className="subtle">
          One run is one automation pass for one job seeker on one portal. Counters come from the
          worker at the end of the run.
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
      </div>

      {actionError && <ErrorBanner error={actionError} />}
      {error && <ErrorBanner error={error} onRetry={reload} />}

      <Panel flush>
        {loading ? (
          <Loading />
        ) : runs.length === 0 ? (
          <Empty
            title="No runs match"
            note="Queue one from a job seeker's page, or clear the filters above."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Job seeker</th>
                  <th>Portal</th>
                  <th>Status</th>
                  <th className="num">Applied</th>
                  <th className="num">Seen</th>
                  <th className="num">Matched</th>
                  <th className="num">Skipped</th>
                  <th>Worker</th>
                  <th>Took</th>
                  <th>Finished</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const live = run.status === 'queued' || run.status === 'claimed' || run.status === 'running';
                  const stripe =
                    run.status === 'failed' || run.status === 'blocked'
                      ? 'stripe stripe-crit'
                      : run.status === 'partial'
                        ? 'stripe stripe-warn'
                        : run.status === 'succeeded'
                          ? 'stripe stripe-ok'
                          : 'stripe';
                  return (
                    <tr key={run.id} className={stripe}>
                      <td className="primary">
                        <Link href={`/users/${run.user.id}`}>{run.user.fullName}</Link>
                      </td>
                      <td className="tight">
                        <PortalPill portal={run.portal} />
                      </td>
                      <td className="tight">
                        <div className="cell-stack">
                          <RunStatusPill status={run.status} />
                          {run.errorMessage && <span className="cell-sub">{run.errorMessage}</span>}
                        </div>
                      </td>
                      <td className="num">{run.counters.applicationsSubmitted}</td>
                      <td className="num">{run.counters.jobsSeen}</td>
                      <td className="num">{run.counters.jobsMatched}</td>
                      <td
                        className="num"
                        title={`${run.counters.jobsSkippedExcluded} excluded, ${run.counters.jobsSkippedDuplicate} duplicate`}
                      >
                        {run.counters.jobsSkippedExcluded + run.counters.jobsSkippedDuplicate}
                      </td>
                      <td className="tight">{run.workerId ?? '—'}</td>
                      <td className="tight num">{duration(run.startedAt, run.finishedAt)}</td>
                      <td className="tight" title={absoluteTime(run.finishedAt)}>
                        {relativeTime(run.finishedAt)}
                      </td>
                      <td className="tight">
                        {live && (
                          <button
                            className="small danger"
                            disabled={cancelling === run.id}
                            onClick={() => cancel(run.id)}
                          >
                            {cancelling === run.id ? 'Cancelling…' : 'Cancel'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

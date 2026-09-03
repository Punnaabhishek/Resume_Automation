'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { TrendChart } from '@/components/TrendChart';
import { humanize, relativeTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import {
  Empty,
  ErrorBanner,
  ExceptionTypePill,
  Loading,
  Panel,
  Pill,
  PortalPill,
  RunStatusPill,
  Tile,
} from '@/components/ui';

export default function OverviewPage() {
  const [interval, setInterval] = useState<'day' | 'week'>('day');
  const overview = useApi(() => api.overview(), []);
  const runs = useApi(() => api.runs(), []);
  const exceptions = useApi(() => api.exceptions({ status: 'active' }), []);
  const trend = useApi(() => api.trend({ interval }), [interval]);

  const stats = overview.data;
  const recentRuns = (runs.data ?? []).slice(0, 8);
  const openExceptions = exceptions.data ?? [];

  const confirmed =
    stats?.applications.byStatus
      .filter((row) => row.source === 'bot_confirmed')
      .reduce((sum, row) => sum + row.count, 0) ?? 0;

  const portalEntries = Object.entries(stats?.applications.byPortal ?? {});
  const portalMax = Math.max(1, ...portalEntries.map(([, n]) => n));

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Last 30 days</div>
        <h1>Overview</h1>
      </div>

      {overview.error && <ErrorBanner error={overview.error} onRetry={overview.reload} />}
      {overview.loading && <Panel flush><Loading rows={3} /></Panel>}

      {stats && (
        <>
          <div className="tiles">
            <Tile
              label="Applications"
              value={stats.applications.total}
              note={`${confirmed} bot-confirmed`}
            />
            <Tile label="Job seekers applied for" value={stats.applications.activeUsers} />
            <Tile label="Distinct companies" value={stats.applications.distinctCompanies} />
            <Tile
              label="Open exceptions"
              value={openExceptions.length}
              note={openExceptions.length ? 'Needs a human' : 'Queue is clear'}
              warn={openExceptions.length > 0}
            />
          </div>

          <Panel
            title="Applications over time"
            action={
              <div className="actions">
                <button
                  className={interval === 'day' ? 'small primary' : 'small'}
                  onClick={() => setInterval('day')}
                >
                  Daily
                </button>
                <button
                  className={interval === 'week' ? 'small primary' : 'small'}
                  onClick={() => setInterval('week')}
                >
                  Weekly
                </button>
              </div>
            }
          >
            {trend.loading ? (
              <Loading rows={3} />
            ) : trend.error ? (
              <ErrorBanner error={trend.error} onRetry={trend.reload} />
            ) : trend.data ? (
              <TrendChart trend={trend.data} />
            ) : null}
          </Panel>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(19rem, 1fr))', gap: '0.85rem' }}>
            <Panel title="By portal">
              {portalEntries.length === 0 ? (
                <Empty title="No applications in range" />
              ) : (
                <div className="bars">
                  {portalEntries.map(([portal, count]) => (
                    <div className="bar-row" key={portal}>
                      <span>{portal}</span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${(count / portalMax) * 100}%` }} />
                      </div>
                      <span className="bar-num">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Job seekers">
              <div className="dl">
                {Object.entries(stats.users).length === 0 ? (
                  <Empty title="No job seekers yet" />
                ) : (
                  Object.entries(stats.users).map(([status, count]) => (
                    <div className="dl-item" key={status}>
                      <span className="dl-key">{humanize(status)}</span>
                      <span className="tile-value" style={{ fontSize: '1.25rem' }}>
                        {count}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Panel>

            <Panel title="Runs in range">
              <div className="dl">
                {Object.entries(stats.runs).length === 0 ? (
                  <Empty title="No runs in range" />
                ) : (
                  Object.entries(stats.runs).map(([status, count]) => (
                    <div className="dl-item" key={status}>
                      <span className="dl-key">{humanize(status)}</span>
                      <span className="tile-value" style={{ fontSize: '1.25rem' }}>
                        {count}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Panel>
          </div>
        </>
      )}

      <section className="block">
        <div className="panel-head" style={{ border: 'none', padding: 0 }}>
          <h2>Needs attention</h2>
          <Link href="/exceptions" className="btn small">
            Open queue
          </Link>
        </div>
        <Panel flush>
          {exceptions.loading ? (
            <Loading rows={2} />
          ) : openExceptions.length === 0 ? (
            <Empty title="Nothing waiting on a human" note="Runs raise an exception here when they hit a verification prompt, a CAPTCHA, or a locked account." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Job seeker</th>
                    <th>Portal</th>
                    <th>Raised</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {openExceptions.slice(0, 6).map((item) => (
                    <tr
                      key={item.id}
                      className={
                        item.severity === 'high' || item.type === 'locked_account'
                          ? 'stripe stripe-crit'
                          : 'stripe stripe-warn'
                      }
                    >
                      <td className="tight">
                        <ExceptionTypePill type={item.type} />
                      </td>
                      <td className="primary">
                        <Link href={`/users/${item.user.id}`}>{item.user.fullName}</Link>
                      </td>
                      <td className="tight">
                        <PortalPill portal={item.portal} />
                      </td>
                      <td className="tight">{relativeTime(item.raisedAt)}</td>
                      <td className="tight">
                        <Pill tone={item.status === 'in_progress' ? 'info' : 'warn'}>
                          {humanize(item.status)}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <section className="block">
        <div className="panel-head" style={{ border: 'none', padding: 0 }}>
          <h2>Recent runs</h2>
          <Link href="/runs" className="btn small">
            All runs
          </Link>
        </div>
        <Panel flush>
          {runs.loading ? (
            <Loading rows={3} />
          ) : recentRuns.length === 0 ? (
            <Empty title="No runs yet" note="Queue one from a job seeker's page, or let the scheduler enqueue due work." />
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
                    <th>Worker</th>
                    <th>Finished</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.id}>
                      <td className="primary">
                        <Link href={`/users/${run.user.id}`}>{run.user.fullName}</Link>
                      </td>
                      <td className="tight">
                        <PortalPill portal={run.portal} />
                      </td>
                      <td className="tight">
                        <RunStatusPill status={run.status} />
                      </td>
                      <td className="num">{run.counters.applicationsSubmitted}</td>
                      <td className="num">{run.counters.jobsSeen}</td>
                      <td className="tight">{run.workerId ?? '—'}</td>
                      <td className="tight">{relativeTime(run.finishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>
    </>
  );
}

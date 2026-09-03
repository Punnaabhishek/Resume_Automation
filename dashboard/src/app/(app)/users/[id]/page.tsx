'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { absoluteTime, asArray, humanize, relativeTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { Portal, UserStatus } from '@/lib/types';
import {
  ApplicationStatusPill,
  Chips,
  ConnectionStatusPill,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  Panel,
  PortalPill,
  RunStatusPill,
  SourcePill,
  Tile,
  UserStatusPill,
} from '@/components/ui';
import { BreakdownBars, TrendChart } from '@/components/TrendChart';
import {
  ConsentPanel,
  CredentialPanel,
  ExcludePanel,
  FiltersPanel,
  ResumePanel,
} from '@/components/ManagePanels';

const PORTALS: Portal[] = ['linkedin', 'indeed', 'dice'];

/**
 * Transitions offered per current status. `destructive` only marks the ones that stop
 * automation for this person, so the button that ends a service reads differently from the
 * one that pauses it.
 */
const NEXT_STATUS: Record<UserStatus, { to: UserStatus; label: string; destructive?: boolean }[]> = {
  intake: [{ to: 'active', label: 'Activate' }],
  active: [
    { to: 'paused', label: 'Pause' },
    { to: 'suspended', label: 'Suspend', destructive: true },
  ],
  paused: [
    { to: 'active', label: 'Resume' },
    { to: 'offboarded', label: 'Offboard', destructive: true },
  ],
  suspended: [
    { to: 'active', label: 'Reinstate' },
    { to: 'offboarded', label: 'Offboard', destructive: true },
  ],
  offboarded: [],
};

type Tab = 'activity' | 'setup' | 'reporting';

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [tab, setTab] = useState<Tab>('activity');

  const user = useApi(() => api.user(id), [id]);
  const runs = useApi(() => api.runs({ userId: id }), [id]);
  const applications = useApi(() => api.applications({ userId: id }), [id]);
  const resumes = useApi(() => api.resumes(id), [id]);
  const stats = useApi(() => api.userStats(id), [id]);
  const trend = useApi(() => api.trend({ userId: id, interval: 'day' }), [id]);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  async function changeStatus(to: UserStatus) {
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    try {
      await api.updateUser(id, { status: to });
      setActionOk(`Status set to ${to}.`);
      user.reload();
      runs.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not change status.');
    } finally {
      setBusy(false);
    }
  }

  async function queueRun(portal: Portal) {
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    try {
      // Check eligibility first so the failure explains itself instead of surfacing a 409.
      const eligibility = await api.eligibility(id, portal);
      if (!eligibility.eligible) {
        setActionError(`Not eligible for ${portal}: ${eligibility.reasons.join('; ')}`);
        return;
      }
      await api.enqueueRun(id, portal);
      setActionOk(`Run queued for ${portal}. ${eligibility.remainingToday} applications left today.`);
      runs.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not queue a run.');
    } finally {
      setBusy(false);
    }
  }

  if (user.loading) return <Panel flush><Loading rows={5} /></Panel>;
  if (user.error) return <ErrorBanner error={user.error} onRetry={user.reload} />;
  if (!user.data) return null;

  const u = user.data;
  const confirmed = (applications.data ?? []).filter((a) => a.statusSource === 'bot_confirmed').length;

  const connectedPortals = u.connections.filter((c) => c.connection_status === 'connected').length;
  const hasResume = (resumes.data ?? []).length > 0;

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="eyebrow">
              <Link href="/users">Job seekers</Link> / {u.email}
            </div>
            <h1>{u.fullName}</h1>
          </div>
          <div className="actions">
            <UserStatusPill status={u.status} />
            {NEXT_STATUS[u.status]?.map((option) => (
              <button
                key={option.to}
                className={option.destructive ? 'small danger' : 'small'}
                disabled={busy}
                onClick={() => changeStatus(option.to)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {actionError && <ErrorBanner error={actionError} />}
      {actionOk && <div className="banner banner-ok">{actionOk}</div>}

      {/* Readiness, up front: these three are what decide whether a run can even start. */}
      <div className="tiles">
        <Tile label="Status" value={humanize(u.status)} note={u.status === 'active' ? 'Automation allowed' : 'Automation blocked'} warn={u.status !== 'active'} />
        <Tile label="Portals connected" value={connectedPortals} note={`${u.connections.length} configured`} warn={u.connections.length === 0} />
        <Tile label="Resume" value={hasResume ? 'On file' : 'Missing'} note={hasResume ? undefined : 'A run cannot be queued'} warn={!hasResume} />
        <Tile label="Applications" value={applications.data?.length ?? '—'} note={`${confirmed} confirmed`} />
      </div>

      <div className="actions">
        {(['activity', 'setup', 'reporting'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'primary small' : 'small'} onClick={() => setTab(t)}>
            {humanize(t)}
          </button>
        ))}
      </div>

      {/* ================= ACTIVITY ================= */}
      {tab === 'activity' && (
        <>
          <Panel
            title="Portal connections"
            action={
              <div className="actions">
                {PORTALS.map((portal) => (
                  <button key={portal} className="small" disabled={busy} onClick={() => queueRun(portal)}>
                    Queue {portal}
                  </button>
                ))}
              </div>
            }
            flush
          >
            {u.connections.length === 0 ? (
              <Empty
                title="No portal connections"
                note="Add one under Setup — the automation has nothing to log into until then."
              />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Portal</th>
                      <th>Status</th>
                      <th className="num">Failures</th>
                      <th>Last login</th>
                      <th>Last synced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.connections.map((c) => (
                      <tr
                        key={c.id}
                        className={
                          c.connection_status === 'locked'
                            ? 'stripe stripe-crit'
                            : c.connection_status === 'needs_attention'
                              ? 'stripe stripe-warn'
                              : c.connection_status === 'connected'
                                ? 'stripe stripe-ok'
                                : 'stripe'
                        }
                      >
                        <td className="tight">
                          <PortalPill portal={c.portal} />
                        </td>
                        <td className="tight">
                          <div className="cell-stack">
                            <ConnectionStatusPill status={c.connection_status} />
                            {c.status_reason && <span className="cell-sub">{humanize(c.status_reason)}</span>}
                          </div>
                        </td>
                        <td className="num">{c.consecutive_failures}</td>
                        <td className="tight">{relativeTime(c.last_login_at)}</td>
                        <td className="tight">{relativeTime(c.last_synced_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Runs" flush>
            {runs.loading ? (
              <Loading rows={2} />
            ) : (runs.data ?? []).length === 0 ? (
              <Empty title="No runs yet" note="Queue one with the buttons above." />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Portal</th>
                      <th>Status</th>
                      <th className="num">Applied</th>
                      <th className="num">Seen</th>
                      <th>Trigger</th>
                      <th>Worker</th>
                      <th>Finished</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(runs.data ?? []).slice(0, 12).map((run) => (
                      <tr key={run.id}>
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
                        <td className="tight">{humanize(run.triggerSource)}</td>
                        <td className="tight">{run.workerId ?? '—'}</td>
                        <td className="tight">{relativeTime(run.finishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Applications"
            action={
              applications.data ? (
                <span className="subtle">
                  {applications.data.length} total · {confirmed} confirmed
                </span>
              ) : null
            }
            flush
          >
            {applications.loading ? (
              <Loading rows={2} />
            ) : (applications.data ?? []).length === 0 ? (
              <Empty title="Nothing submitted yet" />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Company</th>
                      <th>Portal</th>
                      <th>Status</th>
                      <th>Source</th>
                      <th>Applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(applications.data ?? []).slice(0, 25).map((row) => (
                      <tr key={row.id}>
                        <td className="primary">
                          {row.jobUrl ? (
                            <a href={row.jobUrl} target="_blank" rel="noreferrer noopener">
                              {row.jobTitle}
                            </a>
                          ) : (
                            row.jobTitle
                          )}
                        </td>
                        <td>{row.company}</td>
                        <td className="tight">
                          <PortalPill portal={row.portal} />
                        </td>
                        <td className="tight">
                          <ApplicationStatusPill status={row.status} />
                        </td>
                        <td className="tight">
                          <SourcePill source={row.statusSource} />
                        </td>
                        <td className="tight" title={absoluteTime(row.appliedAt)}>
                          {relativeTime(row.appliedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {/* ================= SETUP ================= */}
      {tab === 'setup' && (
        <>
          <Panel title="Profile">
            <div className="dl">
              <Field label="Email" value={u.email} />
              <Field label="Phone" value={u.phone ?? '—'} />
              <Field
                label="Location"
                value={[u.location.city, u.location.state, u.location.country].filter(Boolean).join(', ') || '—'}
              />
              <Field label="Timezone" value={u.location.timezone ?? '—'} />
              <Field label="Daily cap" value={`${u.pacing.dailyApplicationCap} applications`} />
              <Field label="Minimum gap" value={`${u.pacing.minMinutesBetweenApplications} minutes`} />
              <Field label="Intake channel" value={humanize(u.intake.channel)} />
              <Field label="Target roles" value={<Chips items={asArray(u.targetDesignations)} />} />
              <Field label="Key skills" value={<Chips items={asArray(u.keySkills)} />} />
            </div>
            {u.notes && <p className="subtle" style={{ marginTop: '0.9rem' }}>{u.notes}</p>}
          </Panel>

          <ConsentPanel consents={u.consents} />

          <CredentialPanel userId={id} onDone={user.reload} />

          {resumes.loading ? (
            <Panel flush><Loading rows={2} /></Panel>
          ) : (
            <ResumePanel userId={id} resumes={resumes.data ?? []} onDone={resumes.reload} />
          )}

          <FiltersPanel userId={id} filters={u.filters} onDone={user.reload} />

          <ExcludePanel userId={id} companies={u.excludedCompanies} onDone={user.reload} />
        </>
      )}

      {/* ================= REPORTING ================= */}
      {tab === 'reporting' && (
        <>
          <Panel title="Applications over time">
            {trend.loading ? (
              <Loading rows={3} />
            ) : trend.error ? (
              <ErrorBanner error={trend.error} onRetry={trend.reload} />
            ) : trend.data ? (
              <TrendChart trend={trend.data} />
            ) : null}
          </Panel>

          {stats.loading ? (
            <Panel flush><Loading rows={3} /></Panel>
          ) : stats.error ? (
            <ErrorBanner error={stats.error} onRetry={stats.reload} />
          ) : stats.data ? (
            <>
              <div className="tiles">
                <Tile label="Applications sent" value={stats.data.applicationsSent} />
                <Tile
                  label="Observed responses"
                  value={stats.data.observedResponses}
                  note="A floor, not a rate"
                />
                <Tile label="First applied" value={relativeTime(stats.data.firstApplied)} />
                <Tile label="Last applied" value={relativeTime(stats.data.lastApplied)} />
              </div>

              <div className="banner banner-info">
                <strong>Why &ldquo;observed responses&rdquo; and not a response rate</strong>
                <span>
                  Responses a portal never displays are invisible to us, so this number is a
                  floor. It cannot be reported to a job seeker as the share of employers who
                  replied.
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(21rem, 1fr))', gap: '0.85rem' }}>
                <Panel title="By role searched">
                  <BreakdownBars
                    rows={stats.data.byDesignation.map((d) => ({ label: d.designation, count: d.count }))}
                    emptyTitle="No applications attributed to a filter yet"
                  />
                </Panel>

                <Panel title="By portal">
                  <BreakdownBars
                    rows={Object.entries(stats.data.byPortal).map(([portal, count]) => ({
                      label: portal,
                      count,
                    }))}
                    emptyTitle="No applications in range"
                  />
                </Panel>

                <Panel title="Most-applied companies">
                  <BreakdownBars
                    rows={stats.data.topCompanies.map((c) => ({ label: c.company, count: c.count }))}
                    emptyTitle="No applications in range"
                  />
                </Panel>
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

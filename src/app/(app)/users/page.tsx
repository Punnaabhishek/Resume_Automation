'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { asArray, relativeTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { Chips, Empty, ErrorBanner, Loading, Panel, UserStatusPill } from '@/components/ui';

const STATUSES = ['intake', 'active', 'paused', 'suspended', 'offboarded'];

export default function UsersPage() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  // Only the committed value hits the API, so typing does not fire a request per keystroke.
  const [query, setQuery] = useState('');

  const { data, error, loading, reload } = useApi(
    () => api.users({ status: status || undefined, search: query || undefined }),
    [status, query],
  );

  const users = data ?? [];

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="eyebrow">Records</div>
            <h1>Job seekers</h1>
          </div>
          <div className="actions">
            <button className="small" onClick={reload}>
              Refresh
            </button>
            <Link href="/users/new" className="btn btn-primary small">
              Onboard a job seeker
            </Link>
          </div>
        </div>
        <p className="subtle">
          Records, not accounts — nobody here can sign in. Automation only runs for someone whose
          status is active and whose consent is on file.
        </p>
      </div>

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
        }}
      >
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
          Name or email
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit" className="small">
          Search
        </button>
        {query && (
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              setSearch('');
              setQuery('');
            }}
          >
            Clear
          </button>
        )}
      </form>

      {error && <ErrorBanner error={error} onRetry={reload} />}

      <Panel flush>
        {loading ? (
          <Loading />
        ) : users.length === 0 ? (
          <Empty
            title="No job seekers match"
            note="Intake happens over the API — this console does not create records."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Location</th>
                  <th>Targets</th>
                  <th className="num">Daily cap</th>
                  <th className="num">Gap</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="primary">
                      <div className="cell-stack">
                        <Link href={`/users/${user.id}`}>{user.fullName}</Link>
                        <span className="cell-sub">{user.email}</span>
                      </div>
                    </td>
                    <td className="tight">
                      <UserStatusPill status={user.status} />
                    </td>
                    <td className="tight">
                      {[user.location.city, user.location.country].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td>
                      <Chips items={asArray(user.targetDesignations).slice(0, 3)} />
                    </td>
                    <td className="num">{user.pacing.dailyApplicationCap}</td>
                    <td className="num">{user.pacing.minMinutesBetweenApplications}m</td>
                    <td className="tight">{relativeTime(user.createdAt)}</td>
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

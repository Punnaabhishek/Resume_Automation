'use client';

import { useState } from 'react';
import { absoluteTime, utcDate } from '@/lib/format';
import type { DailyAudit as DailyAuditData } from '@/lib/types';
import { ApplicationStatusPill, Empty, MatchScore, PortalPill, SourcePill } from './ui';

/**
 * One job seeker's activity, day by day.
 *
 * The org-level dashboard answers "how much are we doing". This answers the question an
 * operator actually gets asked by the person paying them: *what did you do for me, and when*.
 * So the unit is a day, and each day leads with the roles and companies rather than a count —
 * "3 applications" tells a job seeker nothing they care about.
 *
 * A day with zero applications still gets a row when a run happened, and says why. "Nothing
 * cleared the bar, closest was 91" and "we never ran" are completely different situations
 * that a bare zero would render identically.
 */
export function DailyAuditView({ data }: { data: DailyAuditData }) {
  const [openDay, setOpenDay] = useState<string | null>(data.days[0]?.day ?? null);

  if (!data.days.length) {
    return (
      <Empty
        title="No activity in this range"
        note="Once a run applies to something, the day it happened appears here."
      />
    );
  }

  return (
    <div className="audit">
      {data.days.map((day) => {
        const open = openDay === day.day;
        const capped = day.applied >= data.user.dailyApplicationCap;

        return (
          <div className={open ? 'audit-day is-open' : 'audit-day'} key={day.day}>
            <button
              type="button"
              className="audit-head"
              aria-expanded={open}
              onClick={() => setOpenDay(open ? null : day.day)}
            >
              <span className="audit-date">
                {new Date(`${day.day}T00:00:00Z`).toLocaleDateString('en-US', {
                  timeZone: 'UTC',
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
                <span className="audit-utc">UTC</span>
              </span>

              <span className="audit-count">
                <strong>{day.applied}</strong>
                <span className="audit-of">
                  {capped ? 'cap reached' : `of ${data.user.dailyApplicationCap}`}
                </span>
              </span>

              <span className="audit-summary">
                {day.roles.length > 0 ? (
                  <span className="audit-roles">{day.roles.join(' · ')}</span>
                ) : (
                  <span className="audit-roles audit-muted">No role recorded</span>
                )}
                {day.companies.length > 0 && (
                  <span className="audit-companies">
                    {day.companies.slice(0, 4).join(', ')}
                    {day.companies.length > 4 && ` +${day.companies.length - 4} more`}
                  </span>
                )}
              </span>

              <span className="audit-chevron" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
            </button>

            {/*
              The line that stops a quiet day looking like a broken one. Without it, "0
              applications" reads as a failure even when the automation ran correctly and
              simply found nothing worth sending.
            */}
            {day.applied === 0 && (
              <div className="audit-why">
                {day.runs === 0
                  ? 'No run happened on this day.'
                  : day.jobsScored === 0
                    ? `${day.runs} run${day.runs === 1 ? '' : 's'} ran but read no job descriptions — worth checking the portal selectors.`
                    : `Scored ${day.jobsScored} posting${day.jobsScored === 1 ? '' : 's'}; none cleared the match bar${
                        day.bestScoreMissed ? `. Closest was ${day.bestScoreMissed}` : ''
                      }.`}
              </div>
            )}

            {open && day.applications.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Applied for</th>
                      <th>Job title</th>
                      <th>Company</th>
                      <th>Portal</th>
                      <th>Match</th>
                      <th>Status</th>
                      <th>Source</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.applications.map((a) => (
                      <tr key={a.id}>
                        <td className="primary">{a.designation ?? '—'}</td>
                        <td>
                          {a.jobUrl ? (
                            <a href={a.jobUrl} target="_blank" rel="noreferrer noopener">
                              {a.jobTitle}
                            </a>
                          ) : (
                            a.jobTitle
                          )}
                        </td>
                        <td>{a.company}</td>
                        <td className="tight">
                          <PortalPill portal={a.portal} />
                        </td>
                        <td className="tight">
                          <MatchScore score={a.matchScore} breakdown={null} />
                        </td>
                        <td className="tight">
                          <ApplicationStatusPill status={a.status} />
                        </td>
                        <td className="tight">
                          <SourcePill source={a.statusSource} />
                        </td>
                        <td className="tight num" title={absoluteTime(a.appliedAt)}>
                          {new Date(a.appliedAt).toLocaleTimeString('en-US', {
                            timeZone: 'UTC',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {open && (
              <div className="audit-foot">
                {day.runs} run{day.runs === 1 ? '' : 's'} · {day.jobsSeen} seen · {day.jobsScored} scored ·{' '}
                {day.jobsBelowThreshold} below the bar
                {day.bestScoreMissed ? ` (closest ${day.bestScoreMissed})` : ''}
                {' · '}
                {utcDate(`${day.day}T00:00:00Z`)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

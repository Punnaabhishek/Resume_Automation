'use client';

import type { ReactNode } from 'react';
import { humanize } from '@/lib/format';
import type {
  Application,
  ApplicationStatus,
  ExceptionType,
  RunStatus,
  StatusSource,
  UserStatus,
} from '@/lib/types';

type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'neutral';

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

const RUN_TONES: Record<RunStatus, Tone> = {
  queued: 'neutral',
  claimed: 'info',
  running: 'info',
  succeeded: 'ok',
  partial: 'warn',
  failed: 'crit',
  blocked: 'crit',
  cancelled: 'neutral',
};

export function RunStatusPill({ status }: { status: RunStatus }) {
  return <Pill tone={RUN_TONES[status] ?? 'neutral'}>{humanize(status)}</Pill>;
}

const USER_TONES: Record<UserStatus, Tone> = {
  intake: 'info',
  active: 'ok',
  paused: 'warn',
  suspended: 'crit',
  offboarded: 'neutral',
};

export function UserStatusPill({ status }: { status: UserStatus }) {
  return <Pill tone={USER_TONES[status] ?? 'neutral'}>{humanize(status)}</Pill>;
}

const APP_TONES: Record<ApplicationStatus, Tone> = {
  applied: 'info',
  viewed: 'info',
  in_consideration: 'ok',
  interview: 'ok',
  offer: 'ok',
  rejected: 'neutral',
  no_response: 'neutral',
  unknown: 'neutral',
};

export function ApplicationStatusPill({ status }: { status: ApplicationStatus }) {
  return <Pill tone={APP_TONES[status] ?? 'neutral'}>{humanize(status)}</Pill>;
}

/**
 * The single most important label in this dashboard. A 'bot_confirmed' status is a
 * submission we watched succeed; 'portal_scrape' is read off the portal's own page and is
 * only as complete as that page. Never render one as the other.
 */
export function SourcePill({ source }: { source: StatusSource }) {
  if (source === 'bot_confirmed') {
    return (
      <Pill tone="ok" title="We watched this submission succeed.">
        Confirmed
      </Pill>
    );
  }
  if (source === 'portal_scrape') {
    return (
      <Pill tone="neutral" title="Read off the portal's own page — only as complete as that page is.">
        Scraped
      </Pill>
    );
  }
  return (
    <Pill tone="info" title="Entered by an ops member.">
      Manual
    </Pill>
  );
}

const EXCEPTION_TONES: Record<ExceptionType, Tone> = {
  otp_required: 'warn',
  captcha: 'warn',
  locked_account: 'crit',
  login_failed: 'crit',
  session_expired: 'info',
  unknown: 'neutral',
};

export function ExceptionTypePill({ type }: { type: ExceptionType }) {
  return <Pill tone={EXCEPTION_TONES[type] ?? 'neutral'}>{humanize(type)}</Pill>;
}

/** Portals as they brand themselves, for use in running prose. */
const PORTAL_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  dice: 'Dice',
};

export function portalLabel(portal: string): string {
  return PORTAL_LABELS[portal] ?? portal;
}

export function PortalPill({ portal }: { portal: string }) {
  return <Pill tone="neutral">{portalLabel(portal)}</Pill>;
}

export function ConnectionStatusPill({ status }: { status: string }) {
  const tone: Tone =
    status === 'connected'
      ? 'ok'
      : status === 'locked'
        ? 'crit'
        : status === 'needs_attention'
          ? 'warn'
          : 'neutral';
  return <Pill tone={tone}>{humanize(status)}</Pill>;
}

export function Panel({
  title,
  action,
  children,
  flush,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <div className="panel">
      {(title || action) && (
        <div className="panel-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {action}
        </div>
      )}
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </div>
  );
}

export function Tile({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div className={warn ? 'tile is-warn' : 'tile'}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="tile-note">{note}</span>}
    </div>
  );
}

export function Empty({ title, note }: { title: string; note?: string }) {
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      {note && <span className="empty-note">{note}</span>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error">
      <span>{error}</span>
      {onRetry && (
        <div>
          <button className="small" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '1.1rem' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${100 - i * 9}%` }} />
      ))}
    </div>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="dl-item">
      <span className="dl-key">{label}</span>
      <span className="dl-val">{value ?? '—'}</span>
    </div>
  );
}

export function Chips({ items }: { items: string[] }) {
  if (!items.length) return <span className="dl-val">—</span>;
  return (
    <div className="chips">
      {items.map((item) => (
        <span className="chip" key={item}>
          {item}
        </span>
      ))}
    </div>
  );
}

/**
 * The match score that let an application through, with its reasoning on hover.
 *
 * Shown everywhere an application is, because the score is the whole basis on which the
 * application was sent — a table of applications without it says "we applied to 40 things"
 * and hides the only question that matters, which is whether they were the right forty.
 *
 * A score is deliberately not dressed up as a verdict: it is a number from a text-matching
 * function, and the tooltip names the components so an operator can see what drove it rather
 * than trusting it.
 */
export function MatchScore({
  score,
  breakdown,
}: {
  score: number | null;
  breakdown: Application['matchBreakdown'];
}) {
  if (score === null || score === undefined) {
    return (
      <Pill tone="neutral" title="Recorded before match scoring existed.">
        —
      </Pill>
    );
  }

  // Bands describe distance from the bar, not quality in the abstract.
  const tone: Tone = score >= 97 ? 'ok' : score >= 93 ? 'info' : 'warn';

  const title = breakdown
    ? [
        `Threshold ${breakdown.threshold}`,
        ...breakdown.components.map((c) => `${c.label}: ${Math.round(c.score * 100)}%  (${c.detail})`),
        breakdown.missingSkills.length
          ? `Not evidenced: ${breakdown.missingSkills.join(', ')}`
          : 'Every skill the posting named was evidenced',
      ].join('\n')
    : 'No breakdown stored';

  return (
    <span className={`pill pill-${tone}`} title={title} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {score}
    </span>
  );
}

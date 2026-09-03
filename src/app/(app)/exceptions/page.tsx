'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { absoluteTime, countdown, humanize, relativeTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { OpsException, Resolution } from '@/lib/types';
import {
  Empty,
  ErrorBanner,
  ExceptionTypePill,
  Loading,
  Panel,
  Pill,
  PortalPill,
  portalLabel,
} from '@/components/ui';

/** The API holds a supplied code for five minutes and the worker's read clears it. */
const OTP_TTL_SECONDS = 300;

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: 'code_supplied', label: 'Code supplied' },
  { value: 'cleared_manually', label: 'Cleared manually' },
  { value: 'account_recovered', label: 'Account recovered' },
  { value: 'user_contacted', label: 'User contacted' },
  { value: 'abandoned', label: 'Abandoned' },
];

export default function ExceptionsPage() {
  const [showResolved, setShowResolved] = useState(false);
  const { data, error, loading, reload } = useApi(
    () => api.exceptions({ status: showResolved ? undefined : 'active' }),
    [showResolved],
  );

  const items = data ?? [];
  const otp = items.filter((e) => e.type === 'otp_required' && e.status !== 'resolved' && e.status !== 'abandoned');
  const others = items.filter((e) => !otp.includes(e));

  return (
    <>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="eyebrow">Queue</div>
            <h1>Exceptions</h1>
          </div>
          <div className="actions">
            <button className="small" onClick={reload}>
              Refresh
            </button>
            <button className="small" onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? 'Active only' : 'Include resolved'}
            </button>
          </div>
        </div>
        <p className="subtle">
          Automation stops and asks here rather than guessing. Verification codes come from the
          user reading them back to you — this platform has no access to anyone&apos;s mailbox or
          phone, and nothing tries to get one.
        </p>
      </div>

      {error && <ErrorBanner error={error} onRetry={reload} />}
      {loading && <Panel flush><Loading /></Panel>}

      {!loading && !error && (
        <>
          {otp.length > 0 && (
            <section className="block">
              <h2>Waiting on a code</h2>
              {otp.map((item) => (
                <OtpCard key={item.id} item={item} onDone={reload} />
              ))}
            </section>
          )}

          <section className="block">
            <h2>{otp.length > 0 ? 'Everything else' : 'Queue'}</h2>
            <Panel flush>
              {others.length === 0 ? (
                <Empty
                  title={otp.length > 0 ? 'Nothing else in the queue' : 'Queue is clear'}
                  note="Runs raise an exception when they hit a verification prompt, a CAPTCHA, or a locked account."
                />
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
                        <th>Assigned</th>
                        <th>Detail</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {others.map((item) => (
                        <OtherRow key={item.id} item={item} onDone={reload} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </section>
        </>
      )}
    </>
  );
}

function OtpCard({ item, onDone }: { item: OpsException; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'claim' | 'respond' | 'resolve'>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  // Once a code is in, the operator needs to know how long the worker has to pick it up.
  useEffect(() => {
    if (sentAt === null) return;
    const tick = () => {
      const left = OTP_TTL_SECONDS - Math.floor((Date.now() - sentAt) / 1000);
      setRemaining(Math.max(0, left));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sentAt]);

  async function run(kind: 'claim' | 'respond' | 'resolve', action: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      if (err instanceof ApiError) setError(err.details?.length ? `${err.message}: ${err.details.join('; ')}` : err.message);
      else setError(err instanceof Error ? err.message : 'That did not work.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  const claimed = item.status === 'in_progress';

  return (
    <div className="otp-card">
      <div className="otp-head">
        <div className="otp-who">
          <span className="otp-name">
            <Link href={`/users/${item.user.id}`}>{item.user.fullName}</Link>
          </span>
          <span className="otp-meta">
            {portalLabel(item.portal)} · raised {relativeTime(item.raisedAt)} ·{' '}
            {absoluteTime(item.raisedAt)}
          </span>
        </div>
        <div className="actions">
          <ExceptionTypePill type={item.type} />
          {item.severity === 'high' && <Pill tone="crit">High</Pill>}
          {claimed && item.assignedTo && <Pill tone="info">{item.assignedTo.fullName}</Pill>}
        </div>
      </div>

      <div className="otp-script">
        Call {item.user.fullName} and ask them to read back the verification code{' '}
        {portalLabel(item.portal)} just sent them. Do not ask for their password — you already have
        it, and no screen here will show it to you.
      </div>

      {item.detail && <p className="subtle">{item.detail}</p>}

      {error && <div className="banner banner-error">{error}</div>}

      {sentAt !== null && remaining > 0 && (
        <div className="banner banner-ok">
          Code sent to the worker. <span className="ttl">{countdown(remaining)}</span> before it
          expires. It can only be used once.
        </div>
      )}
      {sentAt !== null && remaining === 0 && (
        <div className="banner banner-warn">
          That code has expired unused. Ask for a fresh one and send it again.
        </div>
      )}

      {!claimed ? (
        <div className="actions">
          <button
            className="primary"
            disabled={busy !== null}
            onClick={async () => {
              const ok = await run('claim', () => api.claimException(item.id));
              if (ok) onDone();
            }}
          >
            {busy === 'claim' ? 'Claiming…' : 'Claim this'}
          </button>
          <span className="subtle">Claim it first so two people do not work the same one.</span>
        </div>
      ) : (
        <>
          <form
            className="otp-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const ok = await run('respond', () => api.respondToException(item.id, code.trim()));
              if (ok) {
                setSentAt(Date.now());
                setCode('');
              }
            }}
          >
            <label className="field">
              Code from the user
              <input
                className="code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="······"
                required
              />
            </label>
            <button type="submit" className="primary" disabled={busy !== null || !code.trim()}>
              {busy === 'respond' ? 'Sending…' : 'Send to worker'}
            </button>
          </form>

          <ResolveForm
            item={item}
            busy={busy === 'resolve'}
            onResolve={async (resolution, note, restore) => {
              const ok = await run('resolve', () =>
                api.resolveException(item.id, resolution, note, restore),
              );
              if (ok) onDone();
            }}
          />
        </>
      )}
    </div>
  );
}

function OtherRow({ item, onDone }: { item: OpsException; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stripe =
    item.severity === 'high' || item.type === 'locked_account'
      ? 'stripe stripe-crit'
      : item.status === 'resolved'
        ? 'stripe stripe-ok'
        : 'stripe stripe-warn';

  const terminal = item.status === 'resolved' || item.status === 'abandoned';

  return (
    <>
      <tr className={stripe}>
        <td className="tight">
          <ExceptionTypePill type={item.type} />
        </td>
        <td className="primary">
          <Link href={`/users/${item.user.id}`}>{item.user.fullName}</Link>
        </td>
        <td className="tight">
          <PortalPill portal={item.portal} />
        </td>
        <td className="tight" title={absoluteTime(item.raisedAt)}>
          {relativeTime(item.raisedAt)}
        </td>
        <td className="tight">
          <Pill tone={terminal ? 'neutral' : item.status === 'in_progress' ? 'info' : 'warn'}>
            {humanize(item.status)}
          </Pill>
        </td>
        <td className="tight">{item.assignedTo?.fullName ?? '—'}</td>
        <td>{item.detail ?? item.resolutionNote ?? '—'}</td>
        <td className="tight">
          {!terminal && (
            <div className="actions">
              {item.status === 'open' && (
                <button
                  className="small"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api.claimException(item.id);
                      onDone();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Claim failed.');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Claim
                </button>
              )}
              <button className="small" onClick={() => setOpen((v) => !v)}>
                {open ? 'Cancel' : 'Resolve'}
              </button>
            </div>
          )}
        </td>
      </tr>
      {(open || error) && (
        <tr>
          <td colSpan={8} style={{ background: 'var(--sunken)' }}>
            {error && <div className="banner banner-error">{error}</div>}
            {open && (
              <ResolveForm
                item={item}
                busy={busy}
                onResolve={async (resolution, note, restore) => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api.resolveException(item.id, resolution, note, restore);
                    setOpen(false);
                    onDone();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Resolve failed.');
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ResolveForm({
  item,
  busy,
  onResolve,
}: {
  item: OpsException;
  busy: boolean;
  onResolve: (resolution: Resolution, note?: string, restore?: boolean) => void;
}) {
  const [resolution, setResolution] = useState<Resolution>(
    item.type === 'otp_required' ? 'code_supplied' : 'cleared_manually',
  );
  const [note, setNote] = useState('');
  // The API defaults this to true unless abandoned; mirror that so the checkbox is honest.
  const [restore, setRestore] = useState(true);

  useEffect(() => {
    setRestore(resolution !== 'abandoned');
  }, [resolution]);

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem', paddingTop: '0.3rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onResolve(resolution, note.trim() || undefined, restore);
      }}
    >
      <div className="filters">
        <label className="field">
          Resolution
          <select value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
            {RESOLUTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1, minWidth: '16rem' }}>
          Note (optional)
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </label>
      </div>
      <label style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', fontSize: '0.83rem' }}>
        <input
          type="checkbox"
          checked={restore}
          onChange={(e) => setRestore(e.target.checked)}
          style={{ width: 'auto' }}
        />
        Account is fit to be automated again
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Resolving…' : 'Resolve'}
        </button>
      </div>
    </form>
  );
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, session } from '@/lib/api';
import type { Member } from '@/lib/types';

const NAV = [
  { href: '/overview', label: 'Overview' },
  { href: '/exceptions', label: 'Exceptions', badge: true },
  { href: '/runs', label: 'Runs' },
  { href: '/applications', label: 'Applications' },
  { href: '/users', label: 'Job seekers' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [member, setMember] = useState<Member | null>(null);
  const [checked, setChecked] = useState(false);
  const [openExceptions, setOpenExceptions] = useState<number | null>(null);

  // Guard: no token means no console. Runs before anything renders.
  useEffect(() => {
    const token = session.token();
    if (!token) {
      router.replace('/login');
      return;
    }
    setMember(session.member());
    setChecked(true);
  }, [router]);

  const refreshBadge = useCallback(async () => {
    try {
      const open = await api.exceptions({ status: 'active' });
      setOpenExceptions(open.length);
    } catch {
      // A failed badge poll is not worth interrupting the page for.
      setOpenExceptions(null);
    }
  }, []);

  // The exception count is the one number that changes without the operator acting, so it
  // is the only thing polled. Everything else refreshes on navigation or on demand.
  useEffect(() => {
    if (!checked) return;
    refreshBadge();
    const timer = setInterval(refreshBadge, 20_000);
    return () => clearInterval(timer);
  }, [checked, refreshBadge, pathname]);

  function signOut() {
    session.clear();
    router.replace('/login');
  }

  if (!checked) return null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">Ops Console</span>
          <span className="brand-sub">Job Apply</span>
        </div>

        <nav className="nav">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="nav-link"
                aria-current={active ? 'page' : undefined}
              >
                <span>{item.label}</span>
                {item.badge && openExceptions ? <span className="nav-count">{openExceptions}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="whoami">
            <strong>{member?.fullName ?? '—'}</strong>
            {member?.role}
          </div>
          <button className="ghost small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}

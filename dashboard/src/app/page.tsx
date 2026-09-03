'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { session } from '@/lib/api';

/** Nothing lives at the root — send people to the console or the login screen. */
export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(session.token() ? '/overview' : '/login');
  }, [router]);

  return null;
}

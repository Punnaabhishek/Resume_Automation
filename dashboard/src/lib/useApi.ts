'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, session } from './api';

interface State<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * One data-loading hook for every page. Handles the case that matters operationally: an
 * expired token, which arrives as a 401 on whatever call happens next and must send the
 * operator to the login screen rather than showing them an empty table.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): State<T> & { reload: () => void } {
  const router = useRouter();
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetcher()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          session.clear();
          router.replace('/login');
          return;
        }
        setState({ data: null, error: err instanceof Error ? err.message : 'Something went wrong.', loading: false });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  return { ...state, reload };
}

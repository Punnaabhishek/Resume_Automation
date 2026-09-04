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
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: {
    /**
     * Re-fetch every N milliseconds. Used on screens where the data changes without the
     * operator doing anything — a run submitting applications in the background — so what is
     * on screen matches what the worker has already recorded.
     */
    pollMs?: number;
  } = {},
): State<T> & { reload: () => void } {
  const router = useRouter();
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    // `background` skips the loading state on poll ticks. Without it, every refresh would
    // blank the table into skeletons and the screen would flicker once a second.
    const load = (background: boolean) => {
      if (!background) setState((prev) => ({ ...prev, loading: true, error: null }));

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
          // A failed poll keeps the last good data on screen rather than replacing a working
          // table with an error; only the initial load surfaces the failure.
          if (background) return;
          setState({ data: null, error: err instanceof Error ? err.message : 'Something went wrong.', loading: false });
        });
    };

    load(false);

    if (!options.pollMs) {
      return () => {
        cancelled = true;
      };
    }

    const timer = setInterval(() => {
      // Polling a hidden tab is wasted work and, across several open tabs, a self-inflicted
      // load problem. Resume on the next tick after the tab comes back.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      load(true);
    }, options.pollMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, options.pollMs, ...deps]);

  return { ...state, reload };
}

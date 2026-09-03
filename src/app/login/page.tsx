'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api, session } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in — don't make them do it twice.
  useEffect(() => {
    if (session.token()) router.replace('/overview');
  }, [router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password);
      session.save(result.token, result.member);
      router.replace('/overview');
    } catch (err) {
      // 401 is by far the common case and deserves plain wording, not the raw message.
      if (err instanceof ApiError && err.status === 401) setError('That email and password do not match.');
      else setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div>
          <div className="eyebrow">Ops Console</div>
          <h1>Sign in</h1>
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        <form className="login-form" onSubmit={submit}>
          <label className="field">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className="primary" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-note">
          Only operator staff have accounts here. Job seekers are records, not logins — they never
          sign in to this system.
        </p>
      </div>
    </div>
  );
}

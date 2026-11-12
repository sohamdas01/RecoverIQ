'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { isGoogleSignInConfigured, requestGoogleIdToken } from '@/lib/firebase';
import { safeNextPath } from '@/lib/safe-redirect';

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal';
const fieldClass = 'w-full rounded-lg border border-line bg-ink-raised px-3.5 py-2.5 text-sm text-paper transition-colors hover:border-muted focus:outline-2 focus:outline-offset-1 focus:outline-signal';
const labelClass = 'font-mono text-xs uppercase tracking-[0.12em] text-muted';

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[18px]">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, login, loginWithGoogle } = useAuth();

  const nextPath = safeNextPath(searchParams.get('next'));
  const sessionExpired = searchParams.get('expired') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const busy = submitting || googleSubmitting;

  // Already signed in (e.g. opened /login in a second tab): go straight to the destination
  useEffect(() => {
    if (status === 'authenticated') {
      router.replace(nextPath);
    }
  }, [status, router, nextPath]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      router.replace(nextPath);
    } catch (err) {
      setError(err.message || 'Sign in failed. Please try again.');
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (busy) return;
    setError(null);
    setGoogleSubmitting(true);
    try {
      const idToken = await requestGoogleIdToken();
      if (!idToken) {
        setGoogleSubmitting(false);
        return;
      }
      await loginWithGoogle(idToken);
      router.replace(nextPath);
    } catch (err) {
      setError(err.message || 'Google sign-in failed. Please try again.');
      setGoogleSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink font-sans text-paper selection:bg-signal selection:text-ink lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <aside className="relative hidden overflow-hidden border-r border-line p-12 lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden="true" className="ledger-rules absolute inset-0" />
        <Link href="/" className={`relative w-fit rounded font-display text-2xl tracking-tight ${focusRing}`}>
          RecoverIQ
        </Link>
        <div className="relative">
          <p className="font-display text-[clamp(3rem,5.2vw,5.25rem)] leading-[0.98] tracking-[-0.02em]">
            Every decision, <em className="text-signal">on the record.</em>
          </p>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Review held cases, see why each action was taken, and follow every failed payment through to its outcome.
          </p>
        </div>
      </aside>

      <main className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <Link href="/" className={`mb-10 block w-fit rounded font-display text-2xl tracking-tight lg:hidden ${focusRing}`}>
            RecoverIQ
          </Link>

          <h1 className="font-display text-5xl leading-none tracking-tight">Sign in</h1>
          <p className="mt-3 text-sm text-muted">Access your recovery dashboard.</p>

          <div aria-live="polite" className="mt-6 empty:hidden">
            {sessionExpired && !error && (
              <p role="status" className="rounded-lg border border-hold/40 px-3.5 py-3 text-sm text-hold">
                Your session has expired. Please sign in again.
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg border border-stop/50 px-3.5 py-3 text-sm text-stop">
                {error}
              </p>
            )}
          </div>

          {isGoogleSignInConfigured && (
            <>
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={busy}
                className={`mt-7 flex w-full items-center justify-center gap-3 rounded-full bg-white px-4 py-3 text-sm font-medium text-[#1f1f1f] transition-colors hover:bg-paper disabled:opacity-60 ${focusRing}`}
              >
                <GoogleMark />
                {googleSubmitting ? 'Connecting to Google…' : 'Continue with Google'}
              </button>

              <div className="my-6 flex items-center gap-3 font-mono text-xs text-muted">
                <span aria-hidden="true" className="h-px flex-1 bg-line" />
                or
                <span aria-hidden="true" className="h-px flex-1 bg-line" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className={`space-y-4 ${isGoogleSignInConfigured ? '' : 'mt-7'}`} noValidate>
            <div className="space-y-1.5">
              <label htmlFor="email" className={labelClass}>Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={fieldClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className={labelClass}>Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={fieldClass}
              />
            </div>

            <button
              type="submit"
              disabled={busy || !email || !password}
              className={`w-full rounded-full bg-signal px-4 py-3 text-sm font-semibold text-ink transition-colors hover:bg-paper disabled:opacity-50 disabled:hover:bg-signal ${focusRing}`}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-8 text-xs text-muted">
            <Link href="/" className={`rounded transition-colors hover:text-paper ${focusRing}`}>
              ← Back to home
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

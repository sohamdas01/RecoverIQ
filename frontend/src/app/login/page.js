'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { safeNextPath } from '@/lib/safe-redirect';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, login } = useAuth();

  const nextPath = safeNextPath(searchParams.get('next'));
  const sessionExpired = searchParams.get('expired') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Already signed in (e.g. opened /login in a second tab): go straight to the destination
  useEffect(() => {
    if (status === 'authenticated') {
      router.replace(nextPath);
    }
  }, [status, router, nextPath]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md space-y-6 bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl">
        <div className="text-center space-y-2">
          <div className="mx-auto w-11 h-11 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center font-black text-white text-xl shadow-lg shadow-indigo-500/20">
            R
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Merchant Sign in</h1>
          <p className="text-sm text-slate-400">Access your RecoverIQ recovery dashboard.</p>
        </div>

        {sessionExpired && !error && (
          <div role="status" className="p-3 text-sm text-amber-200 bg-amber-950/40 border border-amber-700/40 rounded-xl">
            Your session has expired. Please sign in again.
          </div>
        )}

        {error && (
          <div role="alert" className="p-3 text-sm text-rose-200 bg-rose-950/40 border border-rose-700/40 rounded-xl">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm bg-slate-950 border border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm bg-slate-950 border border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !email || !password}
            className="w-full px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 rounded-xl shadow-lg shadow-indigo-500/20 transition disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-xs text-slate-500">
          <Link href="/" className="hover:text-slate-300 transition">
            ← Back to home
          </Link>
        </p>
      </div>
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

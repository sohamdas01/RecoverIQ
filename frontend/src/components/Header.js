'use client';

import React from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal';

export default function Header({ eyebrow, title, subtitle, onRefresh, refreshing, live = false, showSimulate = true, children }) {
  const { isAdmin } = useAuth();

  return (
    <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {(eyebrow || live) && (
          <p className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            {live && (
              <span className="relative flex size-1.5" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-signal opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex size-1.5 rounded-full bg-signal" />
              </span>
            )}
            {eyebrow}
          </p>
        )}
        <h1 className="mt-2.5 font-display text-4xl leading-none tracking-tight text-paper sm:text-[2.75rem]">{title}</h1>
        {subtitle && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{subtitle}</p>}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        {children}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className={`inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-xs font-medium text-paper transition-colors hover:border-paper/60 disabled:opacity-50 ${focusRing}`}
          >
            <svg
              className={`size-3.5 ${refreshing ? 'animate-spin text-signal' : 'text-muted'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? 'Syncing…' : 'Refresh'}
          </button>
        )}

        {isAdmin && showSimulate && (
          <Link
            href="/simulate"
            className={`inline-flex items-center gap-1.5 rounded-full bg-signal px-4 py-2 text-xs font-semibold text-ink transition-colors hover:bg-paper ${focusRing}`}
          >
            <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 5v14M5 12h14" />
            </svg>
            Simulate event
          </Link>
        )}
      </div>
    </header>
  );
}

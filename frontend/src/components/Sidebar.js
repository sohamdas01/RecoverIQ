'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

const focusRing = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal';

const ICONS = {
  overview: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z',
  cases: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  simulator: 'M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664zM21 12a9 9 0 11-18 0 9 9 0 0118 0z',
};

function NavIcon({ name }) {
  return (
    <svg className="size-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d={ICONS[name]} />
    </svg>
  );
}

function initials(email = '') {
  const name = email.split('@')[0] || '?';
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase();
}

export default function Sidebar({ isOpen, onClose }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, isAdmin } = useAuth();

  const handleSignOut = () => {
    logout();
    router.replace('/login');
  };

  const navItems = [
    { name: 'Overview', href: '/dashboard', exact: true, icon: 'overview' },
    { name: 'Recovery cases', href: '/dashboard/cases', exact: false, icon: 'cases' },
    ...(isAdmin ? [{ name: 'Simulator', href: '/simulate', exact: true, icon: 'simulator' }] : []),
  ];

  return (
    <>
      {isOpen && (
        <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-40 bg-ink/80 backdrop-blur-sm lg:hidden" />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-ink transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between px-6">
          <Link href="/" className={`flex items-center gap-2.5 rounded font-display text-2xl tracking-tight text-paper ${focusRing}`}>
            <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md bg-signal">
              <span className="size-2 rounded-full bg-ink" />
            </span>
            RecoverIQ
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className={`rounded-lg p-1.5 text-muted hover:text-paper lg:hidden ${focusRing}`}
          >
            <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav aria-label="Dashboard" className="flex-1 overflow-y-auto px-3 py-6">
          <p className="px-3 pb-3 font-mono text-[11px] uppercase tracking-[0.16em] text-muted/80">Workspace</p>
          <ul className="space-y-1">
            {navItems.map((item) => {
              const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${focusRing} ${
                      isActive ? 'bg-paper/[0.07] font-medium text-paper' : 'text-muted hover:bg-paper/[0.04] hover:text-paper'
                    }`}
                  >
                    <span className={isActive ? 'text-signal' : ''}>
                      <NavIcon name={item.icon} />
                    </span>
                    {item.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="space-y-3 p-3">
          <div className="rounded-xl border border-line px-3.5 py-3">
            <p className="flex items-center gap-2 text-xs text-paper">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
              Policy engine active
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted">Every action is checked before it runs.</p>
          </div>

          {user && (
            <div className="flex items-center gap-3 rounded-xl px-2 py-2">
              <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-paper/10 font-mono text-[11px] font-medium text-paper">
                {initials(user.email)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-paper" title={user.email}>{user.email}</p>
                <p className="mt-0.5 truncate text-[11px] capitalize text-muted">
                  {user.merchant?.name ? `${user.merchant.name} · ` : ''}{user.role}
                </p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                aria-label="Sign out"
                title="Sign out"
                className={`rounded-lg p-1.5 text-muted transition-colors hover:bg-paper/[0.06] hover:text-paper ${focusRing}`}
              >
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

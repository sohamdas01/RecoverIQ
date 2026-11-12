'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import AuthGuard from '@/components/AuthGuard';

export default function DashboardLayout({ children }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <AuthGuard>
      <div className="flex min-h-screen bg-ink font-sans text-paper selection:bg-signal selection:text-ink">
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

        <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
          <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-ink/90 px-4 backdrop-blur lg:hidden">
            <Link href="/" className="font-display text-xl tracking-tight">RecoverIQ</Link>
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open navigation"
              className="rounded-lg p-2 text-muted hover:text-paper focus-visible:outline-2 focus-visible:outline-signal"
            >
              <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>

          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-8 sm:py-10">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}

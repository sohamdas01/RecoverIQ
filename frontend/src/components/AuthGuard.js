'use client';

import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

function FullPageMessage({ title, detail }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-6 font-sans text-paper">
      <div className="max-w-sm space-y-2 text-center">
        <p className="font-display text-2xl tracking-tight">{title}</p>
        {detail && <p className="text-sm text-muted">{detail}</p>}
      </div>
    </div>
  );
}

/**
 * Client-side route guard: unauthenticated visitors are sent to /login (and returned afterwards).
 * Pass `roles` to additionally require one of the given roles. This is a UX layer only;
 * every API call is authenticated and authorized again by the backend.
 */
export default function AuthGuard({ children, roles }) {
  const { status, user, sessionExpired } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'unauthenticated') {
      const next = encodeURIComponent(pathname || '/dashboard');
      router.replace(`/login?${sessionExpired ? 'expired=1&' : ''}next=${next}`);
    }
  }, [status, sessionExpired, router, pathname]);

  if (status !== 'authenticated') {
    return <FullPageMessage title="Checking your session…" />;
  }

  if (roles && !roles.includes(user?.role)) {
    return (
      <FullPageMessage
        title="You do not have permission to view this page."
        detail={`Your role (${user?.role || 'unknown'}) cannot access it. Ask a merchant admin for access.`}
      />
    );
  }

  return children;
}

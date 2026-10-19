'use client';

import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

function FullPageMessage({ title, detail }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans">
      <div className="text-center space-y-2">
        <p className="text-sm font-semibold text-slate-200">{title}</p>
        {detail && <p className="text-xs text-slate-500">{detail}</p>}
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

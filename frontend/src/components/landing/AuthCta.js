'use client';

import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';

export default function AuthCta({ className, signedOutLabel = 'Sign in', signedInLabel = 'Open dashboard' }) {
  const { status } = useAuth();
  const isSignedIn = status === 'authenticated';

  return (
    <Link href={isSignedIn ? '/dashboard' : '/login'} className={className}>
      {isSignedIn ? signedInLabel : signedOutLabel}
    </Link>
  );
}

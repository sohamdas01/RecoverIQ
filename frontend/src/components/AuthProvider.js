'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  AuthError,
  fetchCurrentUser,
  getAuthToken,
  getStoredUser,
  login as apiLogin,
  logout as apiLogout,
  setSessionExpiredHandler,
} from '@/lib/api';

const AuthContext = createContext(null);

// Roles allowed to approve / modify / reject cases (the backend enforces this; the UI only hides controls)
const REVIEW_ROLES = ['reviewer', 'admin'];

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, expired: false });

  // A 401 from any API call means the session is gone: drop to unauthenticated (AuthGuard redirects)
  useEffect(() => {
    setSessionExpiredHandler(() => setState({ status: 'unauthenticated', user: null, expired: true }));
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Deferred so state is set from a callback rather than synchronously inside the effect
    const timer = setTimeout(async () => {
      if (!getAuthToken()) {
        if (!cancelled) setState({ status: 'unauthenticated', user: null });
        return;
      }
      try {
        // Validates the stored token with the backend and refreshes the role
        const user = await fetchCurrentUser();
        if (!cancelled) setState({ status: 'authenticated', user });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof AuthError) {
          setState({ status: 'unauthenticated', user: null });
          return;
        }
        // Backend unreachable: fall back to the cached profile (authorization is still enforced server-side)
        const cached = getStoredUser();
        setState(cached ? { status: 'authenticated', user: cached } : { status: 'unauthenticated', user: null });
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const user = await apiLogin(email, password);
    setState({ status: 'authenticated', user });
    return user;
  }, []);

  const logout = useCallback(() => {
    apiLogout();
    setState({ status: 'unauthenticated', user: null });
  }, []);

  const value = useMemo(() => ({
    status: state.status,
    user: state.user,
    login,
    logout,
    sessionExpired: state.expired === true,
    canReview: REVIEW_ROLES.includes(state.user?.role),
    isAdmin: state.user?.role === 'admin',
  }), [state, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}

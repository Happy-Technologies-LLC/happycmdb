// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@services/api';
import { abandonSession } from '../lib/session';
import { decodeToken, getToken, removeToken, subscribeToken } from '../utils/token';
import type { AuthState, LoginCredentials, User } from '../types';
import { logClientError } from '../utils/logger';
import { OrganizationContext } from './OrganizationContext';

/**
 * Outcome of `refreshUser`. `session-ended` means the session this refresh belonged to is gone (a failed token renewal
 * after an organization change signed the user out, or a logout landed meanwhile): callers must not report success.
 */
export type RefreshUserResult = 'refreshed' | 'session-ended';

interface AuthContextType extends AuthState {
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<RefreshUserResult>;
  hasRole: (roles: string[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

const SIGNED_OUT: AuthState = { user: null, token: null, isAuthenticated: false, isLoading: false };
/** Tabs of this origin tell each other about a logout (operator ruling D5). */
const LOGOUT_CHANNEL = 'cmdb-auth';
const LOGOUT_MESSAGE = 'logout';
/** Renew the access token this long before it expires, so requests and the WebSocket never carry an expired one. */
const RENEW_LEAD_MS = 60_000;
/** Never renew sooner than this after a token arrives, so a malformed or zero-lifetime token cannot spin the endpoint. */
const MIN_RENEW_MS = 30_000;
/** setTimeout keeps its delay in a signed 32-bit integer; anything longer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * HAP-1211 H2: the access token is held in memory (utils/token.ts) and the user only in this state; nothing goes
 * to Web Storage. A reload or new tab restores the session from the httpOnly refresh cookie.
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    isAuthenticated: false,
    isLoading: true,
  });
  const logoutChannel = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Bumped whenever the session ends or is replaced: an async refreshUser started under an earlier one must not
  // publish a user, clear the cache or sign out on top of the newer one.
  const sessionEpoch = useRef(0);
  const signOutLocally = useCallback(() => {
    sessionEpoch.current += 1;
    queryClient.clear();
    removeToken();
    setState(SIGNED_OUT);
  }, [queryClient]);

  // Every new access token (login, renewal, password change) reaches state.token, so useWebSocket reconnects with it.
  useEffect(() => subscribeToken((token) => setState((prev) => ({ ...prev, token }))), []);

  // Restore the session from the refresh cookie. A refused refresh (none, expired, past the HAP-1285 7-day cap) is
  // final: signed out, no /auth/me, no retry.
  useEffect(() => {
    let active = true;
    // Pre-H2 copies of the bearer and the user are dropped unread (one forced sign-in at the cut-over, E8).
    try {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user');
    } catch {
      // Storage unavailable: nothing to drop.
    }
    const restore = async () => {
      try {
        await api.refresh();
        const user = await api.getCurrentUser();
        if (active) setState({ user, token: getToken(), isAuthenticated: true, isLoading: false });
      } catch (error) {
        logClientError('Session restore failed', error);
        removeToken();
        if (active) setState(SIGNED_OUT);
      }
    };

    restore();
    return () => {
      active = false;
    };
  }, []);

  // Renew before expiry. A failed renewal (refused, past the 7-day cap, rate-limited) ends the session, never retried.
  // The delay comes from the server-issued lifetime (exp - iat), never exp against this browser's clock: a clock
  // running ahead would see every fresh token as expired and renew it in a tight loop.
  useEffect(() => {
    const claims = state.isAuthenticated && state.token ? decodeToken(state.token) : null;
    if (!claims?.exp || !claims.iat) return undefined;
    const issued = (claims.exp - claims.iat) * 1000;
    // A non-numeric exp or iat is malformed: treat it as a zero lifetime so MIN_RENEW_MS bounds it (NaN would fire at once).
    const lifetime = Number.isFinite(issued) ? issued : 0;
    const delay = Math.min(Math.max(lifetime - RENEW_LEAD_MS, lifetime / 2, MIN_RENEW_MS), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      api.refresh().catch((error) => {
        logClientError('Session renewal failed', error);
        signOutLocally();
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [state.isAuthenticated, state.token, signOutLocally]);

  // Another tab logged out: drop this tab's token too.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(LOGOUT_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data !== LOGOUT_MESSAGE) return;
      abandonSession();
      signOutLocally();
      navigate('/login');
    };
    logoutChannel.current = channel;
    return () => {
      channel.close();
      logoutChannel.current = null;
    };
  }, [navigate, signOutLocally]);

  const login = useCallback(async (credentials: LoginCredentials) => {
    try {
      // Note: deliberately not toggling the shared `isLoading` flag here.
      // `isLoading` gates route rendering in App.tsx's ProtectedRoute/PublicRoute
      // (used only for the initial auth check on mount); flipping it during a
      // login submission would unmount the Login page mid-request and discard
      // LoginForm's local error state before a failure alert could render.
      // LoginForm tracks its own `isSubmitting` state for submit-button feedback.

      // Stores the access token in memory; the server sets the refresh cookie.
      const authToken = await api.login(credentials);
      const user = await api.getCurrentUser();

      // Whatever the cache holds was fetched for a previous session, possibly another organization's.
      sessionEpoch.current += 1;
      queryClient.clear();
      setState({
        user,
        token: authToken.access_token,
        isAuthenticated: true,
        isLoading: false,
      });

      navigate('/');
    } catch (error) {
      signOutLocally();
      throw error;
    }
  }, [navigate, queryClient, signOutLocally]);

  const logout = useCallback(async () => {
    // A refreshUser in flight belongs to the session being ended: it must not publish anything afterwards.
    sessionEpoch.current += 1;
    try {
      await api.logout();
    } catch (error) {
      logClientError('Logout error:', error);
    } finally {
      logoutChannel.current?.postMessage(LOGOUT_MESSAGE);
      signOutLocally();
      navigate('/login');
    }
  }, [navigate, signOutLocally]);

  const refreshUser = useCallback(async (): Promise<RefreshUserResult> => {
    const epoch = sessionEpoch.current;
    try {
      const user = await api.getCurrentUser();
      if (epoch !== sessionEpoch.current) return 'session-ended';
      const previous = stateRef.current.user;
      if (!previous || (previous.organization_id ?? null) === (user.organization_id ?? null)) {
        setState((prev) => ({ ...prev, user }));
        return 'refreshed';
      }

      // The organization changed, but the access token still carries the old `_organizationId` claim until it renews.
      // Clearing the cache first would let the new organization's key fill with old-organization data (up to staleTime),
      // so renew first and clear only once the token is the new organization's. A renewal that fails ends the session.
      // The renewed token is authoritative: re-read the identity it speaks for. It can differ from the read above
      // (another change landed meanwhile); whatever it is, nothing cached before the renewal may be kept.
      let confirmed: User;
      try {
        await api.refresh();
        if (epoch !== sessionEpoch.current) return 'session-ended';
        confirmed = await api.getCurrentUser();
      } catch (error) {
        logClientError('Session renewal after organization change failed', error);
        if (epoch === sessionEpoch.current) signOutLocally();
        return 'session-ended';
      }
      if (epoch !== sessionEpoch.current) return 'session-ended';
      queryClient.clear();
      setState((prev) => ({ ...prev, user: confirmed, token: getToken() ?? prev.token }));
      return 'refreshed';
    } catch (error) {
      logClientError('Failed to refresh user:', error);
      throw error;
    }
  }, [queryClient, signOutLocally]);

  const hasRole = useCallback(
    (roles: string[]): boolean => {
      return state.user ? roles.includes(state.user.role) : false;
    },
    [state.user]
  );

  const value: AuthContextType = {
    ...state,
    login,
    logout,
    refreshUser,
    hasRole,
  };

  return (
    <AuthContext.Provider value={value}>
      <OrganizationContext.Provider value={state.user?.organization_id ?? null}>{children}</OrganizationContext.Provider>
    </AuthContext.Provider>
  );
};

export default AuthContext;

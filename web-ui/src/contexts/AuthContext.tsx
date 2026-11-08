// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@services/api';
import { decodeToken, getToken, removeToken, subscribeToken } from '../utils/token';
import type { AuthState, LoginCredentials } from '../types';
import { logClientError } from '../utils/logger';

interface AuthContextType extends AuthState {
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
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

  const navigate = useNavigate();

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

  // Renew before expiry. Only a refusal (401) ends the session; a network error leaves the 401 path to decide.
  useEffect(() => {
    const expiresAt = state.isAuthenticated && state.token ? decodeToken(state.token)?.exp : undefined;
    if (!expiresAt) return undefined;
    const left = expiresAt * 1000 - Date.now();
    const timer = setTimeout(() => {
      api.refresh().catch((error: { response?: { status?: number } }) => {
        if (error.response?.status !== 401) return;
        removeToken();
        setState(SIGNED_OUT);
      });
    }, Math.max(left - RENEW_LEAD_MS, left / 2));
    return () => clearTimeout(timer);
  }, [state.isAuthenticated, state.token]);

  // Another tab logged out: drop this tab's token too.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(LOGOUT_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data !== LOGOUT_MESSAGE) return;
      removeToken();
      setState(SIGNED_OUT);
      navigate('/login');
    };
    logoutChannel.current = channel;
    return () => {
      channel.close();
      logoutChannel.current = null;
    };
  }, [navigate]);

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

      setState({
        user,
        token: authToken.access_token,
        isAuthenticated: true,
        isLoading: false,
      });

      navigate('/');
    } catch (error) {
      removeToken();
      setState(SIGNED_OUT);
      throw error;
    }
  }, [navigate]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (error) {
      logClientError('Logout error:', error);
    } finally {
      logoutChannel.current?.postMessage(LOGOUT_MESSAGE);
      removeToken();
      setState(SIGNED_OUT);
      navigate('/login');
    }
  }, [navigate]);

  const refreshUser = useCallback(async () => {
    try {
      const user = await api.getCurrentUser();
      setState((prev) => ({ ...prev, user }));
    } catch (error) {
      logClientError('Failed to refresh user:', error);
      throw error;
    }
  }, []);

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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export default AuthContext;

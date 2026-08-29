// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@services/api';
import { isTokenExpired } from '../utils/token';
import type { User, AuthState, LoginCredentials } from '../types';

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

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    isAuthenticated: false,
    isLoading: true,
  });

  const navigate = useNavigate();

  // Initialize auth state from localStorage
  useEffect(() => {
    const initializeAuth = async () => {
      const token = localStorage.getItem('auth_token');
      const userStr = localStorage.getItem('user');

      if (token && userStr) {
        if (isTokenExpired(token)) {
          // Token is locally detectable as expired; reject immediately without
          // calling getCurrentUser() and without ever marking the session authenticated.
          localStorage.removeItem('auth_token');
          localStorage.removeItem('user');
          setState({
            user: null,
            token: null,
            isAuthenticated: false,
            isLoading: false,
          });
          return;
        }

        try {
          // Do NOT optimistically mark the session as authenticated from the cached
          // token/user. Keep isLoading:true (the initial state) while the server
          // verifies the token, and only flip to authenticated once it succeeds.
          const currentUser = await api.getCurrentUser();
          setState({
            user: currentUser,
            token,
            isAuthenticated: true,
            isLoading: false,
          });
          localStorage.setItem('user', JSON.stringify(currentUser));
        } catch (error) {
          console.error('Failed to refresh user:', error);
          // Token is invalid, clear auth state
          localStorage.removeItem('auth_token');
          localStorage.removeItem('user');
          setState({
            user: null,
            token: null,
            isAuthenticated: false,
            isLoading: false,
          });
        }
      } else {
        setState({
          user: null,
          token: null,
          isAuthenticated: false,
          isLoading: false,
        });
      }
    };

    initializeAuth();
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    try {
      // Note: deliberately not toggling the shared `isLoading` flag here.
      // `isLoading` gates route rendering in App.tsx's ProtectedRoute/PublicRoute
      // (used only for the initial auth check on mount); flipping it during a
      // login submission would unmount the Login page mid-request and discard
      // LoginForm's local error state before a failure alert could render.
      // LoginForm tracks its own `isSubmitting` state for submit-button feedback.

      const authToken = await api.login(credentials);
      localStorage.setItem('auth_token', authToken.access_token);

      // Fetch user data
      const user = await api.getCurrentUser();
      localStorage.setItem('user', JSON.stringify(user));

      setState({
        user,
        token: authToken.access_token,
        isAuthenticated: true,
        isLoading: false,
      });

      navigate('/');
    } catch (error) {
      setState({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
      });
      throw error;
    }
  }, [navigate]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user');
      setState({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
      });
      navigate('/login');
    }
  }, [navigate]);

  const refreshUser = useCallback(async () => {
    try {
      const user = await api.getCurrentUser();
      setState((prev) => ({ ...prev, user }));
      localStorage.setItem('user', JSON.stringify(user));
    } catch (error) {
      console.error('Failed to refresh user:', error);
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

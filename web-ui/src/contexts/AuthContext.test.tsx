// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import * as api from '@services/api';
import { mockApiHandlers } from '@/tests/mocks/handlers';
import type { User } from '../types';

// Mock the api module
vi.mock('@services/api', () => ({
  api: {
    login: vi.fn(),
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
  },
}));

// `Promise.withResolvers` exists at runtime (Node 22+, used by vitest here) but this
// project's tsconfig `lib` predates ES2024, so TS does not know about it yet.
interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): PromiseResolvers<T>;
  }
}

// Builds a syntactically valid JWT-shaped string with a controllable `exp` claim.
const createToken = (expiresInSeconds: number): string => {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      id: 'user-1',
      email: 'admin@happycmdb.com',
      roles: ['admin'],
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  );
  return `${header}.${payload}.mock-signature`;
};

const cachedUser = mockApiHandlers.getCurrentUser.success as unknown as User;

// Renders a minimal consumer so we can observe the auth state AuthProvider exposes.
const AuthProbe: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="isAuthenticated">{String(isAuthenticated)}</span>
      <span data-testid="isLoading">{String(isLoading)}</span>
    </div>
  );
};

const renderAuthProbe = () =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    </MemoryRouter>
  );

describe('AuthContext initializeAuth (stale/invalid cached token handling)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('never optimistically authenticates from a cached token while getCurrentUser is still in flight', async () => {
    localStorage.setItem('auth_token', createToken(3600));
    localStorage.setItem('user', JSON.stringify(cachedUser));

    const { promise: pending, resolve: resolveGetCurrentUser } = Promise.withResolvers<User>();
    vi.mocked(api.api.getCurrentUser).mockReturnValue(pending);

    renderAuthProbe();

    // Synchronously after mount -- before the server verification call resolves -- the
    // cached token/user must NOT be treated as an authenticated session.
    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
    expect(screen.getByTestId('isLoading').textContent).toBe('true');

    await act(async () => {
      resolveGetCurrentUser(cachedUser);
      await pending;
    });

    // Only after the server confirms the token does the session become authenticated.
    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('true');
      expect(screen.getByTestId('isLoading').textContent).toBe('false');
    });
  });

  it('rejects a cached token the server considers invalid, without ever authenticating', async () => {
    // Not locally expired, but the server rejects it (e.g. revoked server-side).
    localStorage.setItem('auth_token', createToken(3600));
    localStorage.setItem('user', JSON.stringify(cachedUser));

    vi.mocked(api.api.getCurrentUser).mockRejectedValue(new Error('401 Unauthorized'));

    renderAuthProbe();

    // Never authenticated, at any point, including before the rejection settles.
    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');

    await waitFor(() => {
      expect(screen.getByTestId('isLoading').textContent).toBe('false');
    });

    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('rejects a locally-detectable-expired token immediately, without calling getCurrentUser', async () => {
    localStorage.setItem('auth_token', createToken(-3600)); // expired an hour ago
    localStorage.setItem('user', JSON.stringify(cachedUser));

    renderAuthProbe();

    await waitFor(() => {
      expect(screen.getByTestId('isLoading').textContent).toBe('false');
    });

    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
    expect(api.api.getCurrentUser).not.toHaveBeenCalled();
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('treats a malformed/undecodable cached token as invalid, without calling getCurrentUser', async () => {
    localStorage.setItem('auth_token', 'not-a-real-jwt');
    localStorage.setItem('user', JSON.stringify(cachedUser));

    renderAuthProbe();

    await waitFor(() => {
      expect(screen.getByTestId('isLoading').textContent).toBe('false');
    });

    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
    expect(api.api.getCurrentUser).not.toHaveBeenCalled();
  });
});

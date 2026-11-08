// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, within, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import * as api from '@services/api';
import { mockApiHandlers } from '@/tests/mocks/handlers';
import { removeToken, setToken } from '../utils/token';
import type { User } from '../types';

// Mock the api module
vi.mock('@services/api', () => ({
  api: {
    login: vi.fn(),
    getCurrentUser: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
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

// Builds a syntactically valid JWT-shaped string; the server always signs iat and exp.
const jwtShaped = (iat: number, exp: number): string => {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ id: 'user-1', jti: crypto.randomUUID(), iat, exp }));
  return `${header}.${payload}.mock-signature`;
};
// A token issued now (by this clock) that lives for expiresInSeconds.
const createToken = (expiresInSeconds: number): string => {
  const now = Math.floor(Date.now() / 1000);
  return jwtShaped(now, now + expiresInSeconds);
};

const user = mockApiHandlers.getCurrentUser.success as unknown as User;

// Renders a minimal consumer so we can observe the auth state AuthProvider exposes.
const AuthProbe: React.FC = () => {
  const { isAuthenticated, isLoading, token, logout } = useAuth();
  return (
    <div>
      <span data-testid="isAuthenticated">{String(isAuthenticated)}</span>
      <span data-testid="isLoading">{String(isLoading)}</span>
      <span data-testid="token">{token ?? ''}</span>
      <button onClick={() => void logout()}>logout</button>
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

/** api.refresh as the real one behaves: the refresh cookie buys a new in-memory access token. */
const refreshIssues = (...tokens: string[]) => {
  for (const token of tokens) vi.mocked(api.api.refresh).mockImplementationOnce(async () => { setToken(token); });
};

describe('AuthContext session (HAP-1211 H2: in-memory access token, refresh cookie)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.api.refresh).mockReset();
    removeToken();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a reload restores the session from the refresh cookie, never from Web Storage, and drops the legacy copies', async () => {
    localStorage.setItem('auth_token', createToken(3600));
    localStorage.setItem('user', JSON.stringify(user));
    const restored = createToken(3600);
    refreshIssues(restored);
    const { promise: pending, resolve } = Promise.withResolvers<User>();
    vi.mocked(api.api.getCurrentUser).mockReturnValue(pending);

    renderAuthProbe();

    // Not authenticated before the server has confirmed the session.
    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
    expect(screen.getByTestId('isLoading').textContent).toBe('true');
    await act(async () => {
      resolve(user);
      await pending;
    });

    await waitFor(() => expect(screen.getByTestId('isAuthenticated').textContent).toBe('true'));
    expect(screen.getByTestId('token').textContent).toBe(restored);
    expect(api.api.refresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('a refused refresh (no cookie, expired, past the HAP-1285 7-day cap) leaves the user signed out, once, without /auth/me', async () => {
    vi.mocked(api.api.refresh).mockRejectedValue(Object.assign(new Error('refused'), { response: { status: 401 } }));

    renderAuthProbe();

    await waitFor(() => expect(screen.getByTestId('isLoading').textContent).toBe('false'));
    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
    expect(api.api.refresh).toHaveBeenCalledTimes(1);
    expect(api.api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('renews once per token, a minute before its server-issued 15 minutes end, even with the client clock past exp (no refresh loop)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = Math.floor(Date.now() / 1000);
    vi.setSystemTime((server + 20 * 60) * 1000); // this browser's clock runs 20 minutes ahead of the server's
    const [first, second] = [0, 840].map((issuedAt) => jwtShaped(server + issuedAt, server + issuedAt + 900));
    refreshIssues(first, second);
    vi.mocked(api.api.getCurrentUser).mockResolvedValue(user);
    const after = async (ms: number) => {
      await act(() => vi.advanceTimersByTimeAsync(ms));
      return [vi.mocked(api.api.refresh).mock.calls.length, screen.getByTestId('token').textContent];
    };

    renderAuthProbe();

    expect(await after(0)).toEqual([1, first]); // the boot restore
    expect(await after(13 * 60_000 + 59_000)).toEqual([1, first]);
    expect(await after(1_000)).toEqual([2, second]); // 14 minutes in: renewed, and the new token exposed
    expect(await after(13 * 60_000)).toEqual([2, second]); // the new token is not renewed at once either
    expect(screen.getByTestId('isAuthenticated').textContent).toBe('true');
  });

  it('logout in one tab signs the other tabs out (BroadcastChannel)', async () => {
    refreshIssues(createToken(3600), createToken(3600));
    vi.mocked(api.api.getCurrentUser).mockResolvedValue(user);
    vi.mocked(api.api.logout).mockResolvedValue(undefined);
    const tabA = renderAuthProbe();
    const tabB = renderAuthProbe();
    const signedIn = (tab: RenderResult) => within(tab.container).getByTestId('isAuthenticated').textContent;
    await waitFor(() => expect([signedIn(tabA), signedIn(tabB)]).toEqual(['true', 'true']));

    await act(async () => within(tabA.container).getByText('logout').click());

    await waitFor(() => expect(signedIn(tabB)).toBe('false'));
    expect(api.api.logout).toHaveBeenCalledTimes(1);
  });
});

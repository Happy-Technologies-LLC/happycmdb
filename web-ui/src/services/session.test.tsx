// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1211 H2: the access token lives in memory and is renewed from the refresh cookie. No network: a mocked
// axios adapter plays the server (it accepts only the newest access token it issued).
import type React from 'react';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, removeToken, setToken } from '../utils/token';

const jwtLike = () => [
  btoa(JSON.stringify({ alg: 'HS256' })),
  btoa(JSON.stringify({ jti: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600 })),
  'sig',
].join('.');
const STALE = jwtLike();
const loc = { href: '' };
let refreshStatus = 200;
let accepted = '';
let calls: Array<[string, unknown, unknown]> = [];
// What the server saw, in order: each request as it arrives, and `refresh answered` when its reply (and Set-Cookie) leaves.
let wire: string[] = [];

axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = String(config.url);
  calls.push([url, config.headers.Authorization, config.headers['X-CMDB-Auth']]);
  wire.push(url);
  const reply = (status: number, data: unknown) => {
    const response = { data, status, statusText: '', headers: {}, config, request: {} };
    if (status < 400) return response;
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
  };
  if (url.endsWith('/auth/refresh')) {
    const { promise, resolve } = Promise.withResolvers<void>(); // a real gap, so both 401s meet one in-flight refresh
    setTimeout(resolve, 10);
    await promise;
    wire.push('refresh answered');
    if (refreshStatus !== 200) return reply(refreshStatus, { success: false, error: 'Authentication failed' });
    accepted = jwtLike();
    return reply(200, { success: true, data: { _accessToken: accepted, _expiresIn: 900 } });
  }
  if (url.endsWith('/auth/logout')) return reply(200, { success: true });
  if (config.headers.Authorization !== `Bearer ${accepted}`) return reply(401, { success: false });
  if (url.endsWith('/auth/password')) {
    accepted = jwtLike();
    return reply(200, { success: true, data: { _accessToken: accepted, _expiresIn: 900 } });
  }
  return reply(200, { success: true, data: { _userId: 'u-1', _username: 'alice', _role: 'operator' } });
};
// Dynamic on purpose: axios.create copies defaults, so the clients must be created after the adapter is set.
const { api } = await import('./api');
const { AuthProvider, useAuth } = await import('../contexts/AuthContext');

const urls = () => calls.map(([url]) => url);

beforeEach(() => {
  refreshStatus = 200;
  accepted = '';
  calls = [];
  wire = [];
  loc.href = '';
  removeToken();
  vi.stubGlobal('location', loc);
});

describe('401 renewal from the refresh cookie', () => {
  it('renews the access token once (X-CMDB-Auth: 1, no bearer) and replays the request with it', async () => {
    setToken(STALE);

    await expect(api.getCurrentUser()).resolves.toMatchObject({ username: 'alice' });

    expect(calls).toEqual([
      ['/auth/me', `Bearer ${STALE}`, undefined],
      ['/auth/refresh', undefined, '1'],
      ['/auth/me', `Bearer ${accepted}`, undefined],
    ]);
    expect(getToken()).toBe(accepted);
    expect(loc.href).toBe('');
  });

  it('concurrent 401s share one refresh', async () => {
    setToken(STALE);

    await Promise.all([api.getCurrentUser(), api.getCurrentUser()]);

    expect(urls().filter((url) => url === '/auth/refresh')).toHaveLength(1);
  });

  it.each([
    [401, 'expired or past the HAP-1285 7-day cap'],
    [429, 'refresh rate limit, ruling A'],
  ])('a refused refresh (%i: %s) signs out to /login without a retry loop', async (status) => {
    refreshStatus = status;
    setToken(STALE);

    await expect(api.getCurrentUser()).rejects.toMatchObject({ response: { status: 401 } });

    expect(urls()).toEqual(['/auth/me', '/auth/refresh']);
    expect(getToken()).toBeNull();
    expect(loc.href).toBe('/login');
  });
});

const Probe: React.FC = () => {
  const { isAuthenticated, token, logout } = useAuth();
  return (
    <>
      <span data-testid="session">{isAuthenticated ? token : 'signed-out'}</span>
      <button onClick={() => void logout()}>logout</button>
    </>
  );
};

it('#193-F1: the token re-issued by a password change reaches AuthContext, where useWebSocket reads it', async () => {
  render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByTestId('session').textContent).toBe(accepted));
  const before = accepted;

  await act(() => api.changePassword({ currentPassword: crypto.randomUUID(), newPassword: crypto.randomUUID() }));

  expect(accepted).not.toBe(before);
  expect(screen.getByTestId('session').textContent).toBe(accepted);
});

it('logout while a renewal is in flight: the renewal is answered before the logout is sent, and its token is never published', async () => {
  render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByTestId('session').textContent).toBe(accepted));
  wire = [];

  const renewal = api.refresh(); // the renewal timer firing just before the user clicks logout
  await act(async () => screen.getByText('logout').click());
  await act(() => renewal.catch(() => undefined));

  await waitFor(() => expect(wire).toContain('/auth/logout'));
  // The late Set-Cookie lands first, so the logout's cookie expiry is the last word.
  expect(wire).toEqual(['/auth/refresh', 'refresh answered', '/auth/logout']);
  expect(getToken()).toBeNull();
  expect(screen.getByTestId('session').textContent).toBe('signed-out');
});

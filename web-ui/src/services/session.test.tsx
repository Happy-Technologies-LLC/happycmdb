// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1211 H2: the access token lives in memory and is renewed from the refresh cookie. No network: a mocked
// axios adapter plays the server (it accepts only the newest access token it issued).
import type React from 'react';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, removeToken, setToken, subscribeToken } from '../utils/token';

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
// When set, a refresh is answered only after it settles: a renewal held in flight.
let holdRefresh: Promise<void> | null = null;
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
    await holdRefresh;
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
const { abandonSession } = await import('../lib/session');
const { AuthProvider, useAuth } = await import('../contexts/AuthContext');

const urls = () => calls.map(([url]) => url);

beforeEach(() => {
  refreshStatus = 200;
  accepted = '';
  calls = [];
  holdRefresh = null;
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

describe('HAP-1688: sign-out races', () => {
  const noop = () => undefined;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('(a) a logout from another tab discards a renewal already in flight: its token is never published', async () => {
    render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('session').textContent).toBe(accepted));
    const published: Array<string | null> = [];
    const unsubscribe = subscribeToken((token) => published.push(token));
    const gate = Promise.withResolvers<void>();
    holdRefresh = gate.promise;
    const otherTab = new BroadcastChannel('cmdb-auth');
    try {
      const renewal = api.refresh(); // started before the other tab's logout is heard
      otherTab.postMessage('logout');
      await waitFor(() => expect(screen.getByTestId('session').textContent).toBe('signed-out'));
      gate.resolve();
      await act(() => renewal.catch(noop));

      expect(published).toEqual([null]);
      expect(getToken()).toBeNull();
    } finally {
      unsubscribe();
      otherTab.close();
    }
  });

  it('(b) a 401 while this tab logs out does not navigate away from the logout POST', async () => {
    setToken(STALE);

    const loggingOut = api.logout();
    await expect(api.getCurrentUser()).rejects.toMatchObject({ response: { status: 401 } });

    expect(loc.href).toBe('');
    await loggingOut;
    expect(wire).toContain('/auth/logout');
  });

  describe('LOW-A: a renewal in another tab cannot set the refresh cookie after this tab logs out', () => {
    let peer: BroadcastChannel;
    let announced: string[] = [];
    beforeEach(() => {
      peer = new BroadcastChannel('cmdb-session');
      announced = [];
    });
    afterEach(() => {
      peer.close();
      abandonSession(); // releases any hold a test left behind
    });

    it('the logout POST waits for a peer tab that is renewing to answer', async () => {
      peer.onmessage = (event) => {
        if (event.data.type !== 'logout-pending') return;
        announced.push(event.data.from);
        peer.postMessage({ type: 'busy', from: 'peer-tab', to: event.data.from });
      };

      const loggingOut = api.logout();
      await sleep(400); // past the grace window in which an idle tab is assumed
      expect(wire).not.toContain('/auth/logout');

      wire.push('peer renewal answered');
      peer.postMessage({ type: 'settled', from: 'peer-tab', to: announced[0] });
      await loggingOut;

      expect(wire).toEqual(['peer renewal answered', '/auth/logout']);
    });

    it('a tab that hears the announcement drops its in-flight renewal, answers busy then settled, and renews nothing until the logout', async () => {
      const heard: string[] = [];
      peer.onmessage = (event) => {
        if (event.data.to === 'peer-tab') {
          heard.push(event.data.type);
          wire.push(`peer ${event.data.type}`);
        }
      };
      const published: Array<string | null> = [];
      const unsubscribe = subscribeToken((token) => published.push(token));
      const gate = Promise.withResolvers<void>();
      holdRefresh = gate.promise;
      try {
        const renewal = api.refresh();
        peer.postMessage({ type: 'logout-pending', from: 'peer-tab' });
        await waitFor(() => expect(heard).toEqual(['busy']));
        await expect(api.refresh()).rejects.toThrow('Signing out');

        gate.resolve();
        await renewal.catch(noop);
        await waitFor(() => expect(heard).toEqual(['busy', 'settled']));

        expect(wire.indexOf('refresh answered')).toBeLessThan(wire.indexOf('peer settled'));
        expect(published).toEqual([]);
        expect(getToken()).toBeNull();

        abandonSession(); // the other tab's logout completed
        await api.refresh();
        expect(getToken()).toBe(accepted);
      } finally {
        unsubscribe();
      }
    });
  });
});

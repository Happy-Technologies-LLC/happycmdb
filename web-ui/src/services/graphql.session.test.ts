// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1682: a GraphQL 401 (an access token that expired while the device slept) renews the session once from the
// refresh cookie and replays the operation, like the REST interceptor (HAP-1211 H2). No network: a mocked axios
// adapter plays POST /auth/refresh, a stubbed fetch plays /graphql (it accepts only the newest token it issued).
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { gql } from '@apollo/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let refreshes = 0;
let graphqlStatus: number | null = null; // forces every /graphql answer to this status
let sent: Array<string | null> = [];
let posted: string[] = []; // every non-GraphQL request the server saw, in order

axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  posted.push(String(config.url));
  if (String(config.url).endsWith('/auth/logout')) {
    return { data: { success: true }, status: 200, statusText: '', headers: {}, config, request: {} };
  }
  refreshes += 1;
  const response = { data: {}, status: refreshStatus, statusText: '', headers: {}, config, request: {} };
  if (refreshStatus !== 200) {
    throw new AxiosError('refused', 'ERR_BAD_REQUEST', config, {}, response);
  }
  accepted = jwtLike();
  response.data = { success: true, data: { _accessToken: accepted, _expiresIn: 900 } };
  return response;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
  const authorization = new Headers(init.headers).get('authorization');
  sent.push(authorization);
  if (graphqlStatus !== null) return json(graphqlStatus, { errors: [{ message: 'refused' }] });
  if (authorization !== `Bearer ${accepted}`) return json(401, { errors: [{ message: 'Unauthorized' }] });
  return json(200, { data: { ping: 'pong' } });
});

// Dynamic on purpose: the renewal client inside lib/session is created at import, after the adapter is set.
const { apolloClient } = await import('./graphql');
const { api } = await import('./api');
const { abandonSession } = await import('../lib/session');
const PING = gql`query Ping { ping }`;
const ping = () => apolloClient.query({ query: PING });

beforeEach(async () => {
  refreshStatus = 200;
  refreshes = 0;
  graphqlStatus = null;
  accepted = jwtLike();
  sent = [];
  posted = [];
  loc.href = '';
  await apolloClient.clearStore();
  removeToken();
  vi.stubGlobal('location', loc);
});

describe('GraphQL 401 renewal from the refresh cookie (HAP-1682)', () => {
  it('renews once and replays the operation with the renewed token, without sending the user to /login', async () => {
    setToken(STALE);

    await expect(ping()).resolves.toMatchObject({ data: { ping: 'pong' } });

    expect(refreshes).toBe(1);
    expect(sent).toEqual([`Bearer ${STALE}`, `Bearer ${accepted}`]);
    expect(getToken()).toBe(accepted);
    expect(loc.href).toBe('');
  });

  it('a refused renewal signs out to /login with no replay', async () => {
    setToken(STALE);
    refreshStatus = 401;

    await expect(ping()).rejects.toThrow();

    expect(refreshes).toBe(1);
    expect(sent).toEqual([`Bearer ${STALE}`]);
    expect(getToken()).toBeNull();
    expect(loc.href).toBe('/login');
  });

  it('a 401 on the replay signs out after that one renewal instead of renewing again', async () => {
    setToken(STALE);
    graphqlStatus = 401;

    await expect(ping()).rejects.toThrow();

    expect(refreshes).toBe(1);
    expect(sent).toHaveLength(2);
    expect(getToken()).toBeNull();
    expect(loc.href).toBe('/login');
  });

  it('a non-401 failure neither renews nor signs out', async () => {
    setToken(STALE);
    graphqlStatus = 500;

    await expect(ping()).rejects.toThrow();

    expect(refreshes).toBe(0);
    expect(getToken()).toBe(STALE);
    expect(loc.href).toBe('');
  });
});

describe('GraphQL 401 during a sign-out (HAP-1688 b)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('while this tab logs out, does not navigate away before the logout POST is sent', async () => {
    setToken(STALE); // expired access token: the GraphQL 401 cannot be renewed because the sign-out refuses renewals

    const loggingOut = api.logout();
    await expect(ping()).rejects.toThrow();

    // The logout POST waits for peer tabs (150 ms or more), so it has not gone out yet; a hard navigation now would cancel it.
    expect(posted).not.toContain('/auth/logout');
    expect(loc.href).toBe('');
    await loggingOut;

    expect(posted).toEqual(['/auth/logout']);
    expect(loc.href).toBe('');
    expect(getToken()).toBeNull();
  });

  describe('while another tab logs out', () => {
    let peer: BroadcastChannel;
    beforeEach(() => {
      peer = new BroadcastChannel('cmdb-session');
    });
    afterEach(() => {
      peer.close();
      abandonSession(); // releases the hold the announcement armed
    });

    it('does not hard-reload (which would restore the session mid-logout), but still drops the token', async () => {
      setToken(STALE);
      peer.postMessage({ type: 'logout-pending', from: 'peer-tab' });
      await sleep(50); // delivery of the announcement

      await expect(ping()).rejects.toThrow();

      expect(refreshes).toBe(0);
      expect(loc.href).toBe('');
      expect(getToken()).toBeNull();
    });

    it('navigates to /login again once the peer completes its logout', async () => {
      setToken(STALE);
      peer.postMessage({ type: 'logout-pending', from: 'peer-tab' });
      await sleep(50);
      abandonSession(); // AuthContext's reaction to the peer's completed logout
      refreshStatus = 401;

      await expect(ping()).rejects.toThrow();

      expect(loc.href).toBe('/login');
    });
  });
});

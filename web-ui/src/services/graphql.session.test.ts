// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1682: a GraphQL 401 (an access token that expired while the device slept) renews the session once from the
// refresh cookie and replays the operation, like the REST interceptor (HAP-1211 H2). No network: a mocked axios
// adapter plays POST /auth/refresh, a stubbed fetch plays /graphql (it accepts only the newest token it issued).
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { gql } from '@apollo/client';
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
let refreshes = 0;
let graphqlStatus: number | null = null; // forces every /graphql answer to this status
let sent: Array<string | null> = [];

axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
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
const PING = gql`query Ping { ping }`;
const ping = () => apolloClient.query({ query: PING });

beforeEach(async () => {
  refreshStatus = 200;
  refreshes = 0;
  graphqlStatus = null;
  accepted = jwtLike();
  sent = [];
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

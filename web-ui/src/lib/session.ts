// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Session renewal (HAP-1211 H2).
 *
 * The access token is held in memory (utils/token.ts). The server keeps the session in the httpOnly
 * __Secure-cmdb_rt cookie (Path=/api/v1/auth), which only POST /auth/refresh with `X-CMDB-Auth: 1` exchanges for a
 * new access token. attachSession gives every shared API client the same Bearer header and the same 401 handling:
 * one renewal (shared by concurrent 401s), one replay, then sign-out to /login. A refused renewal (expired, past
 * the HAP-1285 7-day cap, credentials changed) is final: nothing retries it.
 */

import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { forbiddenReason, reportForbidden } from './forbidden';
import { redactAxiosError } from './redact-axios-error';
import { getToken, removeToken, setToken } from '../utils/token';

/** The custom header the server requires before it reads or sets the refresh cookie (operator ruling E4). */
export const AUTH_HEADER = { 'X-CMDB-Auth': '1' } as const;

// Session endpoints answer 401 for bad credentials or a refused cookie: renewing and replaying cannot help.
const SESSION_ENDPOINT = /\/auth\/(login|refresh|logout)$/;

const renewal = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1', timeout: 30000 });
let inFlight: Promise<string> | null = null;
// Bumped by every sign-out: a renewal started before it must not publish its token afterwards.
let generation = 0;
let ending: Promise<void> | null = null;

/** Exchanges the refresh cookie for a new in-memory access token. Concurrent callers share one request. */
export function refreshSession(): Promise<string> {
  if (ending) return Promise.reject(new Error('Signing out'));
  const startedIn = generation;
  inFlight ??= renewal
    .post<{ data?: { _accessToken?: unknown } }>('/auth/refresh', undefined, { headers: AUTH_HEADER })
    .then((response) => {
      if (startedIn !== generation) throw new Error('Signed out during the renewal');
      return setToken(response.data?.data?._accessToken);
    }, (error) => Promise.reject(redactAxiosError(error)))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Signs out with `logout` (POST /auth/logout). A renewal in flight is answered first: its Set-Cookie cannot be undone
 * by the client, so the logout's cookie expiry must come after it. Its token is never published, and no renewal
 * starts until the logout is answered. Concurrent sign-outs share one logout.
 */
export function endSession(logout: () => Promise<unknown>): Promise<void> {
  generation += 1;
  ending ??= (inFlight ?? Promise.resolve(''))
    .then(() => undefined, () => undefined)
    .then(logout)
    .then(() => undefined)
    .finally(() => {
      ending = null;
    });
  return ending;
}

type ReplayableConfig = InternalAxiosRequestConfig & { _sessionReplayed?: boolean; _issuedOnPath?: string };

/**
 * Bearer from memory on every request; on a 401, renew once and replay once, else sign out to /login. A 403 is not
 * a session problem: the server's reason is reported (lib/forbidden.ts) and the error still rejects to the caller.
 */
export function attachSession(client: AxiosInstance): void {
  client.interceptors.request.use((config) => {
    const token = getToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    // Where the request was issued (kept across a 401 replay): a late 403 is attributed to this page, not the current one.
    (config as ReplayableConfig)._issuedOnPath ??= window.location.pathname;
    return config;
  });
  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as ReplayableConfig | undefined;
    if (error.response?.status === 403) {
      reportForbidden({
        reason: forbiddenReason(error.response.data),
        method: (config?.method ?? 'get').toUpperCase(),
        sideRead: config?.sideRead === true,
        pathname: config?._issuedOnPath ?? window.location.pathname,
      });
    }
    if (error.response?.status !== 401 || !config || SESSION_ENDPOINT.test(config.url ?? '')) {
      return Promise.reject(redactAxiosError(error));
    }
    if (!config._sessionReplayed) {
      config._sessionReplayed = true;
      const renewed = await refreshSession().then(() => true, () => false);
      if (renewed) return client.request(config);
    }
    removeToken();
    window.location.href = '/login';
    return Promise.reject(redactAxiosError(error));
  });
}

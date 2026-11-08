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
import { redactAxiosError } from './redact-axios-error';
import { getToken, removeToken, setToken } from '../utils/token';

/** The custom header the server requires before it reads or sets the refresh cookie (operator ruling E4). */
export const AUTH_HEADER = { 'X-CMDB-Auth': '1' } as const;

// Session endpoints answer 401 for bad credentials or a refused cookie: renewing and replaying cannot help.
const SESSION_ENDPOINT = /\/auth\/(login|refresh|logout)$/;

const renewal = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1', timeout: 30000 });
let inFlight: Promise<string> | null = null;

/** Exchanges the refresh cookie for a new in-memory access token. Concurrent callers share one request. */
export function refreshSession(): Promise<string> {
  inFlight ??= renewal
    .post<{ data?: { _accessToken?: unknown } }>('/auth/refresh', undefined, { headers: AUTH_HEADER })
    .then((response) => setToken(response.data?.data?._accessToken), (error) => Promise.reject(redactAxiosError(error)))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

type ReplayableConfig = InternalAxiosRequestConfig & { _sessionReplayed?: boolean };

/** Bearer from memory on every request; on a 401, renew once and replay once, else sign out to /login. */
export function attachSession(client: AxiosInstance): void {
  client.interceptors.request.use((config) => {
    const token = getToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as ReplayableConfig | undefined;
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

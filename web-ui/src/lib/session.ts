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

/**
 * HAP-1688 LOW-A: logout only expires the refresh cookie, so a renewal in another tab whose Set-Cookie lands after
 * it would revive the session. The tab that signs out announces `logout-pending` on this channel first; every other
 * tab stops renewing (and discards its in-flight renewal's token), says `busy` while a renewal is in flight and
 * `settled` once it is answered. The logout POST goes out after those answers, bounded by PEER_WAIT_MAX_MS.
 */
const COORDINATION_CHANNEL = 'cmdb-session';
type PeerMessage =
  | { type: 'logout-pending'; from: string }
  | { type: 'busy' | 'settled'; from: string; to: string };
/** Peers answer `busy` within this window or are taken to be idle. */
const BUSY_GRACE_MS = 150;
/** The longest the logout waits for peers' renewals; the renewal request itself times out at 30 s. */
const PEER_WAIT_MAX_MS = 5_000;
/** A peer that announced a logout and never completed it stops holding this tab's renewals after this long. */
const PEER_HOLD_MAX_MS = 10_000;

const tabId = crypto.randomUUID();
const coordination = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(COORDINATION_CHANNEL);
let onPeerAnswer: ((message: PeerMessage & { type: 'busy' | 'settled' }) => void) | null = null;
let peerHold: ReturnType<typeof setTimeout> | null = null;

const releasePeerHold = (): void => {
  if (peerHold) clearTimeout(peerHold);
  peerHold = null;
};

/** True while this tab or another one is signing out: no renewal may start, and nothing may navigate away. */
const signingOut = (): boolean => ending !== null || peerHold !== null;

/**
 * The session is gone (a renewal was refused, or a replay was still 401): drop the token and hard-navigate to /login.
 * A logout in flight (this tab's, or a peer's) ends at /login by itself, and a hard navigation now would unload the
 * page before its POST /auth/logout is sent, so the refresh cookie would survive and sign the user back in (HAP-1688 b).
 * Every client that signs out on a 401 (REST and GraphQL) goes through here.
 */
export function signOutToLogin(): void {
  removeToken();
  if (!signingOut()) window.location.href = '/login';
}

if (coordination) {
  coordination.onmessage = (event: MessageEvent<PeerMessage>) => {
    const message = event.data;
    if (message?.from === tabId) return;
    if (message?.type === 'logout-pending') {
      generation += 1;
      releasePeerHold();
      peerHold = setTimeout(releasePeerHold, PEER_HOLD_MAX_MS);
      const pending = inFlight;
      if (!pending) return;
      coordination.postMessage({ type: 'busy', from: tabId, to: message.from });
      pending
        .then(() => undefined, () => undefined)
        .then(() => coordination.postMessage({ type: 'settled', from: tabId, to: message.from }));
    } else if ((message?.type === 'busy' || message?.type === 'settled') && message.to === tabId) {
      onPeerAnswer?.(message);
    }
  };
}

/** Announces the logout to the other tabs and resolves once every tab that was renewing has answered it. */
function settlePeers(): Promise<void> {
  const channel = coordination;
  if (!channel) return Promise.resolve();
  return new Promise((resolve) => {
    const busy = new Set<string>();
    let graceOver = false;
    const timers = [
      setTimeout(() => {
        graceOver = true;
        if (busy.size === 0) done();
      }, BUSY_GRACE_MS),
      setTimeout(() => done(), PEER_WAIT_MAX_MS),
    ];
    function done(): void {
      timers.forEach(clearTimeout);
      onPeerAnswer = null;
      resolve();
    }
    onPeerAnswer = (message) => {
      if (message.type === 'busy') busy.add(message.from);
      else busy.delete(message.from);
      if (graceOver && busy.size === 0) done();
    };
    channel.postMessage({ type: 'logout-pending', from: tabId } satisfies PeerMessage);
  });
}

/** Another tab finished a logout (AuthContext's channel): a renewal started before it must not publish its token. */
export function abandonSession(): void {
  generation += 1;
  releasePeerHold();
}

/** Exchanges the refresh cookie for a new in-memory access token. Concurrent callers share one request. */
export function refreshSession(): Promise<string> {
  if (signingOut()) return Promise.reject(new Error('Signing out'));
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
 * Signs out with `logout` (POST /auth/logout). Renewals in flight, in this tab and in every other one, are answered
 * first: their Set-Cookie cannot be undone by the client, so the logout's cookie expiry must come after them. Their
 * tokens are never published, and no renewal starts until the logout is answered. Concurrent sign-outs share one logout.
 */
export function endSession(logout: () => Promise<unknown>): Promise<void> {
  generation += 1;
  ending ??= Promise.all([
    (inFlight ?? Promise.resolve('')).then(() => undefined, () => undefined),
    settlePeers(),
  ])
    .then(() => logout())
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
    signOutToLogin();
    return Promise.reject(redactAxiosError(error));
  });
}

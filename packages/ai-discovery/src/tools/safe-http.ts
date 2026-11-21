// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { LookupAddress } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import { resolveDiscoveryHost, connectDiscoveryHost, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';

/** Hard ceiling on a discovery response body. Callers may lower it, never raise it. */
export const DISCOVERY_HTTP_MAX_BYTES = 1048576;
/** Default wall-clock deadline for one probe; `timeout` stays the socket idle timeout. */
export const DISCOVERY_HTTP_TOTAL_MS = 15000;
export const DISCOVERY_RESPONSE_TOO_LARGE = 'Discovery response too large';
export const DISCOVERY_RESPONSE_DEADLINE = 'Discovery response deadline exceeded';
export const DISCOVERY_HTTP_FAILED = 'Discovery HTTP request failed';

/**
 * The only error `safeDiscoveryHttp` rethrows for a transport failure. Axios errors carry
 * `config.url` (path, query, credentials) and the live request: none of that escapes. `code`
 * is the Axios/Node fixed code (ECONNREFUSED, ECONNABORTED, ...); `response` is the status
 * line and headers of an error-status reply (only when the caller's `validateStatus` rejects it).
 */
export class DiscoveryHttpError extends Error {
  readonly code: string | undefined;
  readonly response: { status: number; statusText: string; headers: AxiosResponse['headers'] } | undefined;
  constructor(code?: string, response?: AxiosResponse) {
    super(DISCOVERY_HTTP_FAILED);
    this.name = 'DiscoveryHttpError';
    this.code = code;
    this.response = response && { status: response.status, statusText: response.statusText, headers: response.headers };
  }
}

/** Per-call extras: `totalMs` is the total deadline (default DISCOVERY_HTTP_TOTAL_MS). */
export type SafeDiscoveryHttpOptions = AxiosRequestConfig & { totalMs?: number };

function contentLimit(requested: number | undefined): number {
  return typeof requested === 'number' && requested > 0
    ? Math.min(requested, DISCOVERY_HTTP_MAX_BYTES) : DISCOVERY_HTTP_MAX_BYTES;
}

/** `totalMs` may only lower the deadline, like `contentLimit`; unusable values get the default. */
function totalDeadlineMs(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(Math.floor(requested), 1), DISCOVERY_HTTP_TOTAL_MS) : DISCOVERY_HTTP_TOTAL_MS;
}

/**
 * Bound a step that cannot be cancelled by the deadline signal. getaddrinfo (behind
 * `dns.lookup`) has no cancellation, so the lookup keeps running on the libuv threadpool until the
 * system resolver gives up (resolv.conf timeout/attempts); only the caller is released. A
 * `dns.Resolver({ timeout, tries })` would be cancellable but ignores /etc/hosts and the
 * platform resolver the egress policy resolves with, so it is deliberately not used. The late
 * result is discarded; it never feeds a connection because `pinned` is only set by the winner.
 */
function untilDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const expire = () => reject(new Error(DISCOVERY_RESPONSE_DEADLINE));
    if (signal.aborted) { work.catch((): void => undefined); expire(); return; }
    signal.addEventListener('abort', expire, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', expire));
  });
}

/**
 * Body-size abort from Axios' own limit: ERR_BAD_RESPONSE with no response object. A server that
 * resets mid-body is also ERR_BAD_RESPONSE; Axios words that one 'stream has been aborted'.
 */
function isOversize(error: unknown): boolean {
  return axios.isAxiosError(error) && error.code === AxiosError.ERR_BAD_RESPONSE &&
    error.response === undefined && error.message !== 'stream has been aborted';
}

/** Preserve Host/SNI; connect via checked DNS callback. Redirects and proxies cannot bypass it. */
export async function safeDiscoveryHttp(url: string, options: SafeDiscoveryHttpOptions = {}): Promise<AxiosResponse> {
  let destination: URL;
  try {
    destination = new URL(url);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
      throw new Error(DISCOVERY_TARGET_REFUSED);
    }
  } catch {
    throw new Error(DISCOVERY_TARGET_REFUSED);
  }
  const host = destination.hostname.replace(/^\[([^\]]+)\]$/, '$1');
  // One deadline for the whole probe, started before the (uncancellable) DNS step.
  const signal = AbortSignal.timeout(totalDeadlineMs(options.totalMs));
  const pinned = await untilDeadline(resolveDiscoveryHost(host), signal);
  let refused = false;
  const lookupAtConnect = (_hostname: string, options: { all?: boolean },
    callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[],
      family?: number) => void) => {
    connectDiscoveryHost(host, pinned).then(address => {
      const family = isIP(address);
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }).catch(() => {
      refused = true;
      callback(new Error(DISCOVERY_TARGET_REFUSED), options.all ? [] : '', 0);
    });
  };
  const agent = destination.protocol === 'https:'
    ? new HttpsAgent({ lookup: lookupAtConnect }) : new HttpAgent({ lookup: lookupAtConnect });
  try {
    return await axios({
      method: options.method,
      headers: options.headers,
      timeout: options.timeout,
      validateStatus: options.validateStatus,
      url: destination.toString(),
      maxRedirects: 0,
      maxContentLength: contentLimit(options.maxContentLength),
      maxBodyLength: DISCOVERY_HTTP_MAX_BYTES,
      proxy: false,
      httpAgent: agent,
      httpsAgent: agent,
      signal,
    });
  } catch (error) {
    if (refused) throw new Error(DISCOVERY_TARGET_REFUSED);
    if (isOversize(error)) throw new Error(DISCOVERY_RESPONSE_TOO_LARGE);
    if (signal.aborted) throw new Error(DISCOVERY_RESPONSE_DEADLINE);
    throw new DiscoveryHttpError(
      axios.isAxiosError(error) ? error.code : undefined,
      axios.isAxiosError(error) ? error.response : undefined,
    );
  }
}

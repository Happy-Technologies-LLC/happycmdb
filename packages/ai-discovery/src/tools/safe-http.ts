// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
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

/** Per-call extras: `totalMs` is the total deadline (default DISCOVERY_HTTP_TOTAL_MS). */
export type SafeDiscoveryHttpOptions = AxiosRequestConfig & { totalMs?: number };

function contentLimit(requested: number | undefined): number {
  return typeof requested === 'number' && requested > 0
    ? Math.min(requested, DISCOVERY_HTTP_MAX_BYTES) : DISCOVERY_HTTP_MAX_BYTES;
}

function totalDeadlineMs(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? requested : DISCOVERY_HTTP_TOTAL_MS;
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
  const pinned = await resolveDiscoveryHost(host);
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
  const signal = AbortSignal.timeout(totalDeadlineMs(options.totalMs));
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
    // Axios errors carry config.url and the request: replace them with fixed text.
    if (axios.isAxiosError(error) && error.response === undefined && /maxContentLength/.test(error.message)) {
      throw new Error(DISCOVERY_RESPONSE_TOO_LARGE);
    }
    if (signal.aborted) {
      throw new Error(DISCOVERY_RESPONSE_DEADLINE);
    }
    throw error;
  }
}

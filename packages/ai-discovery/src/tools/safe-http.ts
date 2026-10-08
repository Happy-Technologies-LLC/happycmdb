// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { LookupAddress } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import { resolveDiscoveryHost, connectDiscoveryHost, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';

/** Preserve Host/SNI; connect via checked DNS callback. Redirects and proxies cannot bypass it. */
export async function safeDiscoveryHttp(url: string, options: AxiosRequestConfig = {}): Promise<AxiosResponse> {
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
  try {
    return await axios({
      method: options.method,
      headers: options.headers,
      timeout: options.timeout,
      validateStatus: options.validateStatus,
      url: destination.toString(),
      maxRedirects: 0,
      proxy: false,
      httpAgent: agent,
      httpsAgent: agent,
    });
  } catch (error) {
    if (refused) throw new Error(DISCOVERY_TARGET_REFUSED);
    throw error;
  }
}

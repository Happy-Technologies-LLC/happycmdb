// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { logger, errorClassFields } from '@cmdb/common';
import type { Express } from 'express';

/**
 * HAP-1091: set Express `trust proxy` from TRUST_PROXY / server.trustProxy, the only source of req.ip that every
 * rate limiter keys on. Accepted: a hop count N (the N proxies nearest the API append to X-Forwarded-For), or a
 * comma list of IP/CIDR/loopback|linklocal|uniquelocal. Unset, empty, 0 or false trusts nothing: req.ip is the socket
 * address. `true` (trust every hop = the client-chosen leftmost entry) and any invalid value are logged and fail
 * closed to the socket address; startup never fails on this setting.
 */
export function applyTrustProxy(app: Express, value: unknown): void {
  const raw = typeof value === 'string' ? value.trim() : value;
  let setting: false | number | string[] | undefined;
  if (raw === undefined || raw === null || raw === false || raw === '' || raw === 'false') {
    setting = false;
  } else if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) {
    const hops = Number(raw);
    if (Number.isSafeInteger(hops) && hops >= 0) {
      setting = hops === 0 ? false : hops;
    }
  } else if (typeof raw === 'string' && raw !== 'true') {
    setting = raw.split(',').map(entry => entry.trim());
  }

  try {
    if (setting === undefined) {
      throw new Error('not a hop count or an address list');
    }
    // Express compiles the setting here and throws on an invalid address or CIDR.
    app.set('trust proxy', setting);
  } catch (error) {
    app.set('trust proxy', false);
    logger.error('TRUST_PROXY is invalid; trusting no proxy (req.ip = socket address)', {
      value: String(value),
      ...errorClassFields(error),
    });
  }
}

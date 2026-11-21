// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Utility functions for credential affinity matching
 */

import { logger } from '@cmdb/common';

/**
 * Check if an IP address is within a CIDR range
 * Supports IPv4 only (basic implementation)
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const [cidrIp, prefixLength] = cidr.split('/');
    if (!cidrIp || !prefixLength) {
      return false;
    }

    const prefix = parseInt(prefixLength, 10);

    if (isNaN(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }

    const ipInt = ipToInt(ip);
    const cidrIpInt = ipToInt(cidrIp);

    // Create subnet mask
    const mask = prefix === 0 ? 0 : -1 << (32 - prefix);

    return (ipInt & mask) === (cidrIpInt & mask);
  } catch (error) {
    logger.error('Failed to match CIDR', { ip, cidr, error });
    return false;
  }
}

/**
 * Convert IPv4 address to 32-bit integer
 */
function ipToInt(ip: string): number {
  const parts = ip.split('.').map((part) => parseInt(part, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IP address: ${ip}`);
  }
  const p0 = parts[0] ?? 0;
  const p1 = parts[1] ?? 0;
  const p2 = parts[2] ?? 0;
  const p3 = parts[3] ?? 0;
  return (
    (p0 << 24) | (p1 << 16) | (p2 << 8) | p3
  ) >>> 0;
}

/**
 * Match hostname against glob pattern
 * Supports * (any run of characters, including none) and ? (exactly one
 * character); everything else is a literal, compared case-insensitively.
 *
 * No regular expression is built from the pattern (it is user-authored): an
 * iterative two-pointer matcher that remembers a single `*` position, so the
 * worst case is O(pattern.length * hostname.length) and it cannot throw.
 */
export function matchGlob(hostname: string, pattern: string): boolean {
  const text = hostname.toLowerCase();
  const glob = pattern.toLowerCase();
  let t = 0;
  let g = 0;
  let starG = -1; // pattern index just after the last `*` seen
  let starT = 0; // text index that `*` currently extends to

  while (t < text.length) {
    const c = glob[g];
    if (c === '*') {
      starG = ++g;
      starT = t;
    } else if (g < glob.length && (c === '?' || c === text[t])) {
      g++;
      t++;
    } else if (starG !== -1) {
      // Let the last `*` swallow one more character and retry after it
      g = starG;
      t = ++starT;
    } else {
      return false;
    }
  }

  while (glob[g] === '*') {
    g++;
  }
  return g === glob.length;
}

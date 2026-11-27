// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Utility functions for credential affinity matching
 */

import { MAX_IPV4_LENGTH, MAX_NETWORK_LENGTH } from '@cmdb/common';

/** One octet: 1-3 ASCII digits, no sign, no padding, no leading zero (`010` is refused, not read as 10 or as octal). */
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;

/**
 * Convert a dotted-quad IPv4 address to a 32-bit integer, or null when it is not one.
 *
 * The length is checked before anything else, so an oversize string (the match
 * context `ip` is caller-controlled) is refused without a split or any other
 * allocation. Every octet must match `IPV4_OCTET` before it is parsed, so `1x`,
 * `+1`, whitespace and leading-zero octets are refused rather than coerced by
 * `parseInt`. It never throws and never logs the input.
 */
export function ipToInt(ip: string): number | null {
  if (ip.length > MAX_IPV4_LENGTH) {
    return null;
  }
  const octets = ip.split('.');
  if (octets.length !== 4 || !octets.every((octet) => IPV4_OCTET.test(octet))) {
    return null;
  }
  const parts = octets.map((octet) => parseInt(octet, 10));
  if (parts.some((p) => p > 255)) {
    return null;
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
 * Check whether an already-parsed IPv4 address (see `ipToInt`) is within a CIDR range.
 * IPv4 only. A null address, a malformed or oversize CIDR matches nothing; nothing is logged.
 */
export function isIpIntInCidr(ipInt: number | null, cidr: string): boolean {
  if (ipInt === null || cidr.length > MAX_NETWORK_LENGTH) {
    return false;
  }
  const [cidrIp, prefixLength] = cidr.split('/');
  if (!cidrIp || !prefixLength) {
    return false;
  }

  const prefix = parseInt(prefixLength, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const cidrIpInt = ipToInt(cidrIp);
  if (cidrIpInt === null) {
    return false;
  }

  // Create subnet mask
  const mask = prefix === 0 ? 0 : -1 << (32 - prefix);

  return (ipInt & mask) === (cidrIpInt & mask);
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

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';

export const DISCOVERY_TARGET_REFUSED = 'Discovery target refused';

// Refuse reserved/non-global space as well as the explicitly prohibited private,
// metadata and platform ranges. Never pass an unparsed target to a network client.
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
  ['168.63.129.16', 32], ['100.100.100.200', 32],
];
const blocked = new BlockList();
for (const [address, prefix] of V4) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16],
] as Array<[string, number]>) blocked.addSubnet(address, prefix, 'ipv6');

const platformNames: Record<string, true> = {
  postgres: true, postgresql: true, redis: true, neo4j: true, 'api-server': true,
  database: true, db: true, mysql: true, mongodb: true, elasticsearch: true,
  kafka: true, rabbitmq: true, localhost: true, metadata: true,
};

function ipv4Number(value: string): number {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error(DISCOVERY_TARGET_REFUSED);
  }
  return parts.reduce((number, part) => (number * 256 + Number(part)) >>> 0, 0);
}

export function assertDiscoveryAddress(address: string): void {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6') ||
    (family === 6 && !['2', '3'].includes(address[0]!.toLowerCase()))) {
    throw new Error(DISCOVERY_TARGET_REFUSED);
  }
  if (family === 4) ipv4Number(address); // Reject alternative numeric representations.
}

export function assertDiscoveryHostname(host: string): void {
  if (typeof host !== 'string' || host.length > 253 || !host ||
    /[^a-zA-Z0-9.\-:]/.test(host) || host.startsWith('-') ||
    host.toLowerCase().split('.').some(label => platformNames[label] === true) ||
    host.toLowerCase().endsWith('.internal') || host.toLowerCase().endsWith('.localhost') ||
    host.toLowerCase().endsWith('.local') || host.toLowerCase().endsWith('.svc') ||
    host.toLowerCase().endsWith('.cluster.local')) {
    throw new Error(DISCOVERY_TARGET_REFUSED);
  }
  if (isIP(host)) assertDiscoveryAddress(host);
  else if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.?$/.test(host)) {
    throw new Error(DISCOVERY_TARGET_REFUSED);
  }
}

/** DNS is checked twice; callers must connect to the returned *numeric* IP, never the hostname. */
export async function resolveDiscoveryHost(host: string): Promise<string> {
  assertDiscoveryHostname(host);
  if (isIP(host)) return host;
  try {
    const results = await lookup(host, { all: true, verbatim: true });
    if (!results.length) throw new Error(DISCOVERY_TARGET_REFUSED);
    for (const result of results) assertDiscoveryAddress(result.address);
    return results[0]!.address;
  } catch {
    throw new Error(DISCOVERY_TARGET_REFUSED);
  }
}

/** Recheck DNS immediately at the socket boundary, then pin the original IP. */
export async function connectDiscoveryHost(host: string, pinned: string): Promise<string> {
  assertDiscoveryAddress(pinned);
  if (!isIP(host)) {
    const current = await resolveDiscoveryHost(host);
    if (current !== pinned) throw new Error(DISCOVERY_TARGET_REFUSED);
  }
  return pinned;
}

/** Refuse ranges touching any blocked address; no nmap range or option syntax. */
export function assertDiscoveryRange(range: string): string {
  if (typeof range !== 'string') throw new Error(DISCOVERY_TARGET_REFUSED);
  const [address, prefixText, extra] = range.split('/');
  if (extra !== undefined || !address || (prefixText !== undefined && !/^(0|[1-9]\d?)$/.test(prefixText))) {
    throw new Error(DISCOVERY_TARGET_REFUSED);
  }
  assertDiscoveryAddress(address);
  const family = isIP(address);
  if (prefixText === undefined) return address;
  const prefix = Number(prefixText);
  if (family === 6) {
    if (prefix !== 128) throw new Error(DISCOVERY_TARGET_REFUSED);
    return address;
  }
  if (prefix < 1 || prefix > 32) throw new Error(DISCOVERY_TARGET_REFUSED);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4Number(address) & mask) >>> 0;
  if (network !== ipv4Number(address)) throw new Error(DISCOVERY_TARGET_REFUSED);
  for (const [blockedIp, blockedPrefix] of V4) {
    const overlapMask = (0xffffffff << (32 - Math.min(prefix, blockedPrefix))) >>> 0;
    if (((network & overlapMask) >>> 0) === ((ipv4Number(blockedIp) & overlapMask) >>> 0)) {
      throw new Error(DISCOVERY_TARGET_REFUSED);
    }
  }
  return range;
}

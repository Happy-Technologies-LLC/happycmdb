// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { isIP } from 'net';

const SCAN_MODE_KEYS = ['aggressive', 'osDetection', 'serviceDetection', 'fullPortScan', 'portScan'] as const;
type ScanModeKey = typeof SCAN_MODE_KEYS[number];

export interface SafeDiscoveryScanConfig {
  targets?: string[];
  range?: string;
  scanOptions?: Partial<Record<ScanModeKey, boolean>>;
}

const MAX_DISCOVERY_TARGETS = 256;
// Same RFC 1123 grammar as security/discovery-egress.ts; egress allow/deny policy stays at execution.
const HOSTNAME = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.?$/;

/** Syntax only: an IP literal (no zone id) or CIDR with an in-family prefix. */
function isDiscoveryRange(value: string): boolean {
  const [address = '', prefix, extra] = value.split('/');
  const family = /^[0-9a-fA-F.:]+$/.test(address) ? isIP(address) : 0;
  if (!family || extra !== undefined) return false;
  return prefix === undefined || (/^(0|[1-9]\d{0,2})$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
}

/** Definition writes must not retain opaque values that readers can later retrieve. */
export function strictDiscoveryDefinitionConfig(input: unknown): SafeDiscoveryScanConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid discovery scan configuration');
  }
  const config = input as Record<string, unknown>;
  if (Object.keys(config).some(key => !['targets', 'range', 'scanOptions'].includes(key)) ||
      (config['targets'] !== undefined && config['range'] !== undefined) ||
      config['scanOptions'] === null) {
    throw new Error('Invalid discovery scan configuration');
  }
  const options = config['scanOptions'];
  if (options && typeof options === 'object' && !Array.isArray(options) &&
      Object.keys(options).some(key => !SCAN_MODE_KEYS.includes(key as ScanModeKey))) {
    throw new Error('Invalid discovery scan configuration');
  }
  try {
    const sanitized = safeDiscoveryScanConfig(config);
    if (config['range'] !== undefined && typeof config['range'] !== 'string') {
      throw new Error('Invalid discovery scan configuration');
    }
    return sanitized;
  } catch {
    throw new Error('Invalid discovery scan configuration');
  }
}

/** Never project any part of unsafe historical JSON, including legacy aliases. */
export function publicDiscoveryDefinitionConfig(input: unknown): SafeDiscoveryScanConfig {
  try {
    return strictDiscoveryDefinitionConfig(input);
  } catch {
    return {};
  }
}

/** Legacy rows stay untouched until approved migration, but cannot be run. */
export function hasUnsafeDiscoveryDefinitionConfig(input: unknown): boolean {
  try {
    strictDiscoveryDefinitionConfig(input);
    return false;
  } catch {
    return true;
  }
}

/** Keep only network targets and boolean scan-mode switches; never queue opaque config. */
export function safeDiscoveryScanConfig(input: unknown): SafeDiscoveryScanConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const config = input as Record<string, unknown>;
  const result: SafeDiscoveryScanConfig = {};
  const targets = config['targets'] ?? config['_targets'];
  if (targets !== undefined) {
    // Each target is a hostname, IP or CIDR: never userinfo, scheme, port, path, whitespace or control characters.
    if (!Array.isArray(targets) || targets.length > MAX_DISCOVERY_TARGETS ||
        targets.some(target => typeof target !== 'string' || !(HOSTNAME.test(target) || isDiscoveryRange(target)))) {
      throw new Error('Invalid discovery targets');
    }
    result.targets = targets;
  } else if (typeof config['range'] === 'string') {
    if (!isDiscoveryRange(config['range'])) throw new Error('Invalid discovery range');
    result.range = config['range'];
  }

  const options = config['scanOptions'];
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Invalid discovery scan options');
    }
    const modes = options as Record<string, unknown>;
    for (const key of SCAN_MODE_KEYS) {
      const value = modes[key];
      if (value !== undefined && typeof value !== 'boolean') {
        throw new Error('Invalid discovery scan option');
      }
      if (value !== undefined) (result.scanOptions ??= {})[key] = value;
    }
  }
  return result;
}

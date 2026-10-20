// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const SCAN_MODE_KEYS = ['aggressive', 'osDetection', 'serviceDetection', 'fullPortScan', 'portScan'] as const;
type ScanModeKey = typeof SCAN_MODE_KEYS[number];

export interface SafeDiscoveryScanConfig {
  targets?: string[];
  range?: string;
  scanOptions?: Partial<Record<ScanModeKey, boolean>>;
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
    if (!Array.isArray(targets) || targets.some(target => typeof target !== 'string')) {
      throw new Error('Invalid discovery targets');
    }
    result.targets = targets;
  } else if (typeof config['range'] === 'string') {
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

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const SCAN_MODE_KEYS = ['aggressive', 'osDetection', 'serviceDetection', 'fullPortScan', 'portScan'] as const;
type ScanModeKey = typeof SCAN_MODE_KEYS[number];

export interface SafeDiscoveryScanConfig {
  targets?: string[];
  range?: string;
  scanOptions?: Partial<Record<ScanModeKey, true>>;
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
      if (value === true) (result.scanOptions ??= {})[key] = true;
    }
  }
  return result;
}

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1731: `metadata` is stored on a :CI node as a JSON string. A value that is not a JSON object (a row written
 * before merge stopped accepting `metadata`) reads as empty metadata instead of failing the whole read; the row is not rewritten.
 */
export function parseStoredMetadata(stored: unknown): Record<string, unknown> {
  if (typeof stored !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

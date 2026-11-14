// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Normalized, read-only `owner` / `provider` / `ip_address` / `tier` projection of a CI (BW2).
 *
 * Discovery and the connectors write these facts under whatever name the source uses, inside the CI's free-form
 * metadata bag. The CI list (GET /cis) and detail (GET /cis/:id) responses add four nullable strings computed
 * from the CI at read time. Nothing is stored, migrated or rewritten; the raw CI (including `metadata`) is
 * returned unchanged next to the projection. The projection reads only the CI object it is given, so it never
 * reaches across organizations: callers pass CIs already scoped to the caller's organization.
 *
 * Rules:
 * - A field is resolved by walking its key list in {@link CI_FIELD_KEYS} order (earlier key wins). For each key the
 *   sources are checked in this order: the CI's `attributes` bag, then its `metadata` bag. Top-level node properties
 *   are not read: the detail response only carries a fixed set of them, and list and detail must agree.
 * - `metadata` is stored as a JSON string on the graph node and is parsed here only when it is at most
 *   {@link CI_METADATA_MAX_PARSE_CHARS} characters; a larger or unparseable string contributes nothing.
 * - A value counts only if it is a string that is non-empty after trimming and at most
 *   {@link CI_FIELD_MAX_LENGTH} characters after trimming. Numbers, objects, arrays, empty and oversized
 *   strings are skipped (the next key or source is tried), so a field is `null` when no usable value exists.
 * - The projected value is the trimmed string. The key lists below are the key names discovery and the seed data
 *   actually use (see packages/etl-processor ci-transformer.ts, the nmap and active-directory discovery workers);
 *   extend them here only.
 */

export type CINormalizedField = 'owner' | 'provider' | 'ip_address' | 'tier';

/** Ordered source keys per projected field; earlier keys win. */
export const CI_FIELD_KEYS: Readonly<Record<CINormalizedField, readonly string[]>> = Object.freeze({
  owner: ['owner', 'owned_by', 'managed_by', 'owner_name'],
  provider: ['cloud_provider', 'provider', 'vendor'],
  ip_address: ['ip_address', 'ip', 'primary_ip', 'private_ip', 'public_ip'],
  tier: ['tier', 'service_tier', 'criticality_tier'],
});

/** A usable value is at most this many characters after trimming. */
export const CI_FIELD_MAX_LENGTH = 256;

/** A stored `metadata` JSON string longer than this is not parsed at read time. */
export const CI_METADATA_MAX_PARSE_CHARS = 65_536;

export type CINormalizedFields = Record<CINormalizedField, string | null>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function metadataBag(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return asRecord(value);
  if (value.length > CI_METADATA_MAX_PARSE_CHARS) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function usableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= CI_FIELD_MAX_LENGTH ? trimmed : null;
}

/** The four normalized fields of one CI; pure, no I/O. */
export function projectCIFields(ci: Record<string, unknown>): CINormalizedFields {
  const bags = [asRecord(ci['attributes']), metadataBag(ci['metadata'])];
  const resolve = (keys: readonly string[]): string | null => {
    for (const key of keys) {
      for (const bag of bags) {
        if (bag === null || !Object.hasOwn(bag, key)) continue;
        const value = usableString(bag[key]);
        if (value !== null) return value;
      }
    }
    return null;
  };
  return {
    owner: resolve(CI_FIELD_KEYS.owner),
    provider: resolve(CI_FIELD_KEYS.provider),
    ip_address: resolve(CI_FIELD_KEYS.ip_address),
    tier: resolve(CI_FIELD_KEYS.tier),
  };
}

/** The CI with the four normalized fields added; every other key is unchanged. */
export function withNormalizedCIFields<T extends Record<string, unknown>>(ci: T): T & CINormalizedFields {
  return { ...ci, ...projectCIFields(ci) };
}

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Normalized, read-only `owner` / `provider` / `ip_address` / `tier` view of a CI (BW2).
 *
 * Discovery and the connectors write these facts under whatever name the source uses. The CI list (GET /cis) and
 * detail (GET /cis/:id) responses always carry the four keys, computed from the stored node at read time. Nothing is
 * stored, migrated or rewritten; the raw CI (including `metadata`) is returned unchanged next to the projection. The
 * projection reads only the node it is given, so it never reaches across organizations: callers pass nodes already
 * scoped to the caller's organization.
 *
 * Rules, per field:
 * 1. A stored top-level node property of the same name wins and is returned exactly as stored, whatever its type
 *    (`owner: 'alice'`, `ip_address: ['10.0.0.5']`). Identity reconciliation (`mergeableOnCreate`) and the connectors
 *    write these top-level properties, so the projection never shadows them. Only an absent or null property falls
 *    through to rule 2.
 * 2. Otherwise the field is resolved from the node's `metadata` (a JSON string on the node) by walking its key list
 *    in {@link CI_FIELD_KEYS} order (earlier key wins). `metadata` is the only bag a stored CI has: Neo4j cannot
 *    store a map property, and the merge path flattens `attributes` onto the node top level (rule 1) rather than
 *    storing an `attributes` bag, so no `attributes` source is read.
 * 3. A `metadata` value counts only if it is a string that is non-empty after trimming and at most
 *    {@link CI_FIELD_MAX_LENGTH} characters after trimming. Numbers, objects, arrays, empty and oversized strings are
 *    skipped (the next key is tried), so the field is `null` when no usable value exists. The projected value is the
 *    trimmed string.
 * - `metadata` is parsed only when it is at most {@link CI_METADATA_MAX_PARSE_CHARS} characters; a larger or
 *   unparseable string contributes nothing.
 * - The key lists below are the key names discovery and the seed data actually use (see packages/etl-processor
 *   ci-transformer.ts, the nmap and active-directory discovery workers); extend them here only.
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

/**
 * A stored top-level value is returned as stored (so any type, `ip_address` may be a string array); a value resolved
 * from `metadata` is a trimmed string; `null` when neither exists.
 */
export type CINormalizedFields = Record<CINormalizedField, unknown>;

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

/** The four normalized fields of one stored node; pure, no I/O. */
export function projectCIFields(stored: Record<string, unknown>): CINormalizedFields {
  const bag = metadataBag(stored['metadata']);
  const resolve = (field: CINormalizedField): unknown => {
    const own = stored[field];
    if (own !== undefined && own !== null) return own;
    if (bag === null) return null;
    for (const key of CI_FIELD_KEYS[field]) {
      if (!Object.hasOwn(bag, key)) continue;
      const value = usableString(bag[key]);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    owner: resolve('owner'),
    provider: resolve('provider'),
    ip_address: resolve('ip_address'),
    tier: resolve('tier'),
  };
}

/**
 * The CI with the four normalized fields set; every other key is unchanged. `stored` is the node the fields are
 * projected from (default: the CI itself); pass it when the CI was narrowed from the node, as the detail response is.
 */
export function withNormalizedCIFields<T extends Record<string, unknown>>(
  ci: T, stored: Record<string, unknown> = ci,
): T & CINormalizedFields {
  return { ...ci, ...projectCIFields(stored) };
}

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j created_at is the immutable birth of this CI incarnation. Older SQL
 * rows keyed only by ci_id must not become visible after delete/re-create.
 * Missing or invalid dates fail closed for legacy graph nodes.
 */
export function ciCreationEpoch(ci: { _created_at?: unknown; created_at?: unknown } | null): Date | null {
  const value = ci?._created_at ?? ci?.created_at;
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

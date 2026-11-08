// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * v16 §4.4, D17-3, HAP-499: the properties a merge (create, update, hold or resolve) may write onto a :CI node.
 * System properties are never mergeable: identity and tenant (journal W stamps id and organization_id; external_id
 * is REST create only), the fence and incarnation (journal FENCE), timestamps (journal W and restore) and the class
 * (the node label; owned-write admission reads `type`) and `metadata` (HAP-1731: stored as a JSON string that only the
 * direct create and update write; a merged string would not parse). Keys outside plain identifiers are never mergeable either.
 */
const SYSTEM_PROPERTIES = new Set(['id', 'organization_id', 'organizationid', 'external_id', 'op_id', 'reconciliation_op_id',
  'incarnation_id', 'created_at', 'updated_at', 'discovered_at', 'type', 'ci_type', 'metadata']);

export function isMergeable(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !SYSTEM_PROPERTIES.has(key.toLowerCase());
}

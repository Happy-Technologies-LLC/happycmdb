// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scope of the reconciliation tables. reconciliation_conflicts,
 * ci_source_lineage and ci_field_sources have no organization column: a row
 * belongs to the organization of the :CI node its ci_id names. A row whose CI
 * is in another organization, has no organization, does not exist, or whose
 * ci_id is NULL belongs to no organization: callers fail closed (404 / empty).
 *
 * `organizationId` must come from the token (requestOrganizationId /
 * requireGraphQLOrganization), never from request params or body.
 */

import { getPostgresClient } from '@cmdb/database';
import { getIdentityReconciliationEngine } from '@cmdb/identity-resolution';

export interface ReconciliationConflictRow {
  id: string;
  ci_id: string;
  conflict_type: string;
  source_data: unknown;
  target_data: unknown;
  conflicting_fields: unknown;
  status: string;
  created_at: Date;
}

/** Whether the CI exists in the organization. */
export async function ciInOrganization(organizationId: string, ciId: string): Promise<boolean> {
  const owned = await getIdentityReconciliationEngine().organizationCIIds([ciId], organizationId);
  return owned.length > 0;
}

/** One page of the organization's conflicts with `status`, newest first, and their total. */
export async function listOrganizationConflicts(
  organizationId: string,
  status: string,
  limit: number,
  offset: number
): Promise<{ rows: ReconciliationConflictRow[]; total: number }> {
  const postgresClient = getPostgresClient();

  const candidates = await postgresClient.query(
    `SELECT DISTINCT ci_id::text AS ci_id
     FROM reconciliation_conflicts
     WHERE status = $1 AND ci_id IS NOT NULL`,
    [status]
  );
  const ownedCIIds = await getIdentityReconciliationEngine().organizationCIIds(
    candidates.rows.map((row: { ci_id: string }) => row.ci_id),
    organizationId
  );
  if (ownedCIIds.length === 0) {
    return { rows: [], total: 0 };
  }

  const result = await postgresClient.query(
    `SELECT id, ci_id, conflict_type, source_data, target_data,
            conflicting_fields, status, created_at
     FROM reconciliation_conflicts
     WHERE status = $1 AND ci_id::text = ANY($2::text[])
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [status, ownedCIIds, limit, offset]
  );
  const total = await postgresClient.query(
    `SELECT COUNT(*) AS count
     FROM reconciliation_conflicts
     WHERE status = $1 AND ci_id::text = ANY($2::text[])`,
    [status, ownedCIIds]
  );

  return { rows: result.rows, total: parseInt(total.rows[0].count, 10) };
}

/** reconciliation_conflicts.id is a UUID; any other id names no conflict. */
const CONFLICT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conflict when its CI is in the organization; null for a foreign, missing or malformed id. */
export async function findOrganizationConflict(
  organizationId: string,
  conflictId: string
): Promise<ReconciliationConflictRow | null> {
  if (!CONFLICT_ID_RE.test(conflictId)) {
    return null;
  }
  const result = await getPostgresClient().query(
    'SELECT * FROM reconciliation_conflicts WHERE id = $1',
    [conflictId]
  );
  const conflict: ReconciliationConflictRow | undefined = result.rows[0];
  if (conflict === undefined || conflict.ci_id === null) {
    return null;
  }
  return (await ciInOrganization(organizationId, String(conflict.ci_id))) ? conflict : null;
}

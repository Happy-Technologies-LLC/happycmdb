// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { PostgresClient } from '@cmdb/database';
import type { QueryResult } from 'pg';

// Interim LH-5 ownership gate: metadata tables do not carry organization_id.
// Only a current, explicitly owned CI in the SQL dimension authorizes access.
const ownedConflict = `EXISTS (
  SELECT 1 FROM cmdb.dim_ci ci
  WHERE ci.ci_id = c.ci_id::text AND ci.is_current = TRUE AND ci.organization_id = $2
)`;

// LEFT JOIN keeps the owned CI visible when it has no metadata. A missing/foreign
// CI produces zero rows, so ownership and metadata are read in one SQL snapshot.
export async function getOwnedLineage(db: PostgresClient, ciId: string, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT lineage.source_name, lineage.source_id, lineage.confidence_score,
      lineage.discovered_at AS first_seen_at, lineage.last_seen_at
    FROM cmdb.dim_ci ci LEFT JOIN ci_source_lineage lineage ON lineage.ci_id = ci.ci_id
    WHERE ci.ci_id = $1 AND ci.is_current = TRUE AND ci.organization_id = $2
    ORDER BY lineage.last_seen_at DESC`, [ciId, organizationId]);
}

export async function getOwnedFieldSources(db: PostgresClient, ciId: string, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT fields.field_name, fields.field_value, fields.source_name, fields.updated_at
    FROM cmdb.dim_ci ci LEFT JOIN ci_field_sources fields ON fields.ci_id = ci.ci_id
    WHERE ci.ci_id = $1 AND ci.is_current = TRUE AND ci.organization_id = $2
    ORDER BY fields.field_name`, [ciId, organizationId]);
}

export async function listOwnedConflicts(db: PostgresClient, status: string, limit: number, offset: number, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT c.id, c.ci_id, c.conflict_type, c.source_data, c.target_data,
      c.conflicting_fields, c.status, c.created_at
    FROM reconciliation_conflicts c
    WHERE c.status = $1 AND EXISTS (
      SELECT 1 FROM cmdb.dim_ci ci
      WHERE ci.ci_id = c.ci_id::text AND ci.is_current = TRUE AND ci.organization_id = $4
    )
    ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`, [status, limit, offset, organizationId]);
}

export async function countOwnedConflicts(db: PostgresClient, status: string, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT COUNT(*) AS count FROM reconciliation_conflicts c
    WHERE c.status = $1 AND EXISTS (
      SELECT 1 FROM cmdb.dim_ci ci
      WHERE ci.ci_id = c.ci_id::text AND ci.is_current = TRUE AND ci.organization_id = $2
    )`, [status, organizationId]);
}

export async function getOwnedConflict(db: PostgresClient, id: string, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT c.* FROM reconciliation_conflicts c
    WHERE c.id = $1 AND ${ownedConflict}`, [id, organizationId]);
}

export async function updateOwnedConflict(db: PostgresClient, id: string, organizationId: string, resolutionData: string): Promise<QueryResult> {
  return db.query(`UPDATE reconciliation_conflicts c
    SET status = 'resolved', resolution_data = $3, resolved_at = NOW()
    WHERE c.id = $1 AND ${ownedConflict} RETURNING c.id`, [id, organizationId, resolutionData]);
}

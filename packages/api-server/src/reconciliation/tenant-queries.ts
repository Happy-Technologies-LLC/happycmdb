// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { PostgresClient } from '@cmdb/database';
import type { QueryResult } from 'pg';

// LEFT JOIN keeps the owned CI visible when it has no metadata. A missing/foreign
// CI produces zero rows, so ownership and metadata are read in one SQL snapshot.
export async function getOwnedLineage(db: PostgresClient, ciId: string, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT lineage.source_name, lineage.source_id, lineage.confidence_score,
      lineage.discovered_at AS first_seen_at, lineage.last_seen_at
    FROM cmdb.dim_ci ci LEFT JOIN ci_source_lineage lineage
      ON lineage.ci_id = ci.ci_id AND lineage.organization_id = $2
    WHERE ci.ci_id = $1 AND ci.is_current = TRUE AND NOT ci.org_backfilled
      AND ci.organization_id = $2
      AND NOT EXISTS (SELECT 1 FROM ci_reconciliation_operations j
                      WHERE j.organization_id = $2 AND j.ci_id = ci.ci_id
                        AND j.state IN ('pending','failed'))
    ORDER BY lineage.last_seen_at DESC`, [ciId, organizationId]);
}

export async function getOwnedFieldSources(db: PostgresClient, ciId: string, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT fields.field_name, fields.field_value, fields.source_name, fields.updated_at
    FROM cmdb.dim_ci ci LEFT JOIN ci_field_sources fields
      ON fields.ci_id = ci.ci_id AND fields.organization_id = $2
    WHERE ci.ci_id = $1 AND ci.is_current = TRUE AND NOT ci.org_backfilled
      AND ci.organization_id = $2
      AND NOT EXISTS (SELECT 1 FROM ci_reconciliation_operations j
                      WHERE j.organization_id = $2 AND j.ci_id = ci.ci_id
                        AND j.state IN ('pending','failed'))
    ORDER BY fields.field_name`, [ciId, organizationId]);
}

/**
 * v16 §7.5: O's conflicts on currently owned, non-gapped CIs; page and total
 * come from one statement (one snapshot). Legacy NULL-org evidence is never attributed.
 */
export async function listOwnedConflicts(db: PostgresClient, status: string, limit: number, offset: number,
  organizationId: string): Promise<{ total: number; rows: Array<Record<string, any>> }> {
  const result = await db.query(`WITH owned AS (
      SELECT c.id, c.ci_id, c.conflict_type, c.source_data, c.target_data, c.conflicting_fields, c.status, c.created_at,
        c.field_name, c.source_name, c.source_id, c.incoming_json, c.target_json, c.target_source_name, c.content_hash,
        c.detected_by
      FROM reconciliation_conflicts c
      WHERE c.status = $1 AND c.organization_id = $4 AND EXISTS (
        SELECT 1 FROM cmdb.dim_ci ci
        WHERE ci.ci_id = c.ci_id::text AND ci.is_current = TRUE
          AND NOT ci.org_backfilled AND ci.organization_id = $4
          AND NOT EXISTS (SELECT 1 FROM ci_reconciliation_operations j
                          WHERE j.organization_id = $4 AND j.ci_id = ci.ci_id
                            AND j.state IN ('pending','failed'))))
    SELECT (SELECT count(*) FROM owned)::int AS total,
      coalesce((SELECT json_agg(page) FROM (SELECT * FROM owned ORDER BY created_at DESC, id LIMIT $2 OFFSET $3) page),
        '[]'::json) AS rows`, [status, limit, offset, organizationId]);
  return result.rows[0];
}

const RULE_COLUMNS = 'id, name, description, enabled, identification_rules, merge_strategies, created_at, updated_at';
/** v16 §8 rules of O only; legacy NULL-org rules are inert and never listed here. */
export function listOrgRules(db: PostgresClient, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT ${RULE_COLUMNS} FROM reconciliation_rules WHERE organization_id = $1
    ORDER BY updated_at DESC, id DESC`, [organizationId]);
}

export interface RuleInput {
  name: string; description?: string | null; enabled?: boolean;
  identification_rules: unknown[]; merge_strategies: unknown[];
}
export function insertOrgRule(db: PostgresClient, organizationId: string, rule: RuleInput): Promise<QueryResult> {
  return db.query(`INSERT INTO reconciliation_rules (organization_id, name, description, enabled, identification_rules,
      merge_strategies) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING ${RULE_COLUMNS}`,
  [organizationId, rule.name, rule.description ?? null, rule.enabled ?? true, JSON.stringify(rule.identification_rules),
    JSON.stringify(rule.merge_strategies)]);
}

/** Foreign, missing and legacy (NULL-org) rules match no row: the caller's identical 404. */
export function updateOrgRule(db: PostgresClient, id: string, organizationId: string, rule: RuleInput): Promise<QueryResult> {
  return db.query(`UPDATE reconciliation_rules SET name = $3, description = $4, enabled = $5,
      identification_rules = $6::jsonb, merge_strategies = $7::jsonb, updated_at = now()
    WHERE id = $1 AND organization_id = $2 RETURNING ${RULE_COLUMNS}`,
  [id, organizationId, rule.name, rule.description ?? null, rule.enabled ?? true, JSON.stringify(rule.identification_rules),
    JSON.stringify(rule.merge_strategies)]);
}

export function deleteOrgRule(db: PostgresClient, id: string, organizationId: string): Promise<QueryResult> {
  return db.query('DELETE FROM reconciliation_rules WHERE id = $1 AND organization_id = $2 RETURNING id', [id, organizationId]);
}

export function listOrgAuthorities(db: PostgresClient, organizationId: string): Promise<QueryResult> {
  return db.query(`SELECT source_name, authority_score, description FROM source_authority
    WHERE organization_id = $1 ORDER BY source_name`, [organizationId]);
}

/** v16 §8: authority writes go only to (O, source); a legacy NULL-org row is never touched. */
export function upsertOrgAuthority(db: PostgresClient, organizationId: string, source: string, score: number,
  description: string | null): Promise<QueryResult> {
  return db.query(`INSERT INTO source_authority (organization_id, source_name, authority_score, description)
    VALUES ($1, $2, $3, $4) ON CONFLICT (organization_id, source_name) WHERE organization_id IS NOT NULL
    DO UPDATE SET authority_score = EXCLUDED.authority_score, description = EXCLUDED.description, updated_at = now()
    RETURNING source_name, authority_score, description`, [organizationId, source, score, description]);
}

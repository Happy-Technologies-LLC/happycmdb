// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// ============================================
// 001: organization_id backfill for :CI nodes
// ============================================
// /api/v1/cis only returns, updates and deletes :CI nodes whose
// organization_id equals the caller's token organization. :CI nodes created
// before that carry no organization_id and are invisible to every
// organization. This assigns them to the internal organization
// 00000000-0000-0000-0000-000000000000, the organization PostgreSQL migration
// 008_business_service_organization_scope.sql backfills business services into.
//
// Idempotent: only nodes whose organization_id is null are written, so a
// second run changes nothing and a CI that already has an organization keeps it.
// Note: CIs written later by unscoped system writers (discovery, connectors,
// ETL, reconciliation) also have no organization_id, so a later re-run assigns
// those to the internal organization as well.
//
// Not run automatically and not part of schema initialization. Operator
// action against a chosen database, for example:
//   cypher-shell -a bolt://<host>:7687 -u <user> -f packages/database/src/neo4j/migrations/001_ci_organization_backfill.cypher
// (cypher-shell prompts for the password when -p is omitted)

CREATE INDEX ci_organization_id_idx IF NOT EXISTS
FOR (ci:CI) ON (ci.organization_id);

MATCH (ci:CI)
WHERE ci.organization_id IS NULL
SET ci.organization_id = '00000000-0000-0000-0000-000000000000'
RETURN count(ci) AS backfilled;

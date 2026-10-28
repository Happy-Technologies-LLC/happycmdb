// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// ============================================
// 005: CI external_id unique per organization (FD17-S2)
// ============================================
// Replaces the global ci_external_id_unique with uniqueness on
// (organization_id, external_id): two organizations may hold the same
// external_id, one organization may not hold it twice. Expand, then contract:
// the composite is created before the global constraint is dropped, so there is
// never a moment without one; if the CREATE fails, cypher-shell stops there.
//
// The composite ignores a CI without organization_id: run the backfill
// 001_ci_organization_backfill.cypher first, then both pre-checks (each must return 0):
//   MATCH (c:CI) WHERE c.external_id IS NOT NULL AND c.organization_id IS NULL RETURN count(c);
//   MATCH (c:CI) WHERE c.external_id IS NOT NULL WITH c.organization_id AS o, c.external_id AS e, count(*) AS n WHERE n > 1 RETURN count(*);
// Post-check: SHOW CONSTRAINTS lists ci_org_external_id_unique and no uniqueness
// constraint on CI(external_id) alone.
//
// New databases get only the composite from init-neo4j.cypher and schema.cypher,
// which never drop. Existing databases must NOT re-run init-neo4j.cypher; apply
// this file once instead. Idempotent and schema-only. MANUAL operator step; this
// change authorizes no apply. (cypher-shell prompts for the password without -p)
//   cypher-shell -a bolt://<host>:7687 -u <user> -f packages/database/src/neo4j/migrations/005_ci_external_id_org_unique.cypher
// Rollback: DROP CONSTRAINT ci_org_external_id_unique; re-creating the global
// constraint fails once two organizations share a value (restore the backup).

CREATE CONSTRAINT ci_org_external_id_unique IF NOT EXISTS
FOR (ci:CI) REQUIRE (ci.organization_id, ci.external_id) IS UNIQUE;

DROP CONSTRAINT ci_external_id_unique IF EXISTS;

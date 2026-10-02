-- 011_ci_organization_scope.sql
--
-- Tenant scoping for the CI dimension (T3d). Every cmdb.dim_ci row belongs to
-- exactly one organization: the organization of the :CI node it versions
-- (Neo4j CI.organization_id, see packages/database/src/neo4j/migrations/
-- 001_ci_organization_backfill.cypher). The API uses it to
--   - refuse mapping a CI into a business service of another organization
--     (POST /api/v1/business-services/:id/cis),
--   - count only the caller organization's CIs in /:id/costs, even through a
--     stale cross-organization ci_business_service_mappings row,
--   - sum only the caller organization's CIs in TBM cost trends.
--
-- Existing rows are backfilled to the internal organization
-- 00000000-0000-0000-0000-000000000000 (founder decision FD-4), the id
-- 008_business_service_organization_scope.sql backfills business services
-- into and the Neo4j backfill assigns org-less :CI nodes to. Every SCD
-- version of a ci_id carries the same organization.
--
-- A CI whose :CI node already names a customer organization (created through
-- POST /api/v1/cis, which stamps it) and that the ETL synced before 011 is
-- backfilled to the internal organization too; SQL cannot read Neo4j. The
-- ETL corrects it: when a synced node names an organization other than the
-- stored one, every version of that CI is relabelled to the node's
-- organization. Run a neo4j-to-postgres sync without incrementalSince after
-- applying 011 so every CI is visited (an incremental sync only visits
-- updated nodes).
--
-- Backfill: ADD COLUMN ... NOT NULL DEFAULT <constant> fills existing rows
-- from the catalog without rewriting the table (PostgreSQL 11+), so the SCD
-- history is not rewritten under the ACCESS EXCLUSIVE lock. The DEFAULT is
-- dropped in the same transaction: as in 008, there is no column DEFAULT
-- afterwards, so an insert that does not name its organization fails on
-- NOT NULL instead of silently landing in the internal organization. ETL
-- writers name it explicitly: the :CI node's organization_id; for a node
-- without one, the CI's stored organization, or the internal organization
-- for a CI new to cmdb.dim_ci (FD-4).
--
-- ci_business_service_mappings keeps no organization_id: a mapping is
-- reached only through its org-filtered parent service, and its CI is
-- matched against cmdb.dim_ci.organization_id.
--
-- Re-runnable. Rollback (manual): rollback/011_ci_organization_scope.down.sql.

ALTER TABLE cmdb.dim_ci
  ADD COLUMN IF NOT EXISTS organization_id UUID NOT NULL
  DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE cmdb.dim_ci ALTER COLUMN organization_id DROP DEFAULT;

-- Serves the org-scoped cost trends (WHERE organization_id = $1 AND
-- effective_from >= ...). ci_id lookups keep using idx_dim_ci_id_current,
-- with organization_id as a filter.
CREATE INDEX IF NOT EXISTS idx_dim_ci_organization
  ON cmdb.dim_ci(organization_id, effective_from);

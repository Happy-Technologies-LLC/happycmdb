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
-- into and the Neo4j backfill assigns org-less :CI nodes to.
--
-- No stored row ever changes organization afterwards. A pre-011 ci_id can
-- carry more than one lineage (a CI deleted and its id reused), so its rows
-- cannot be attributed to whichever node holds the id now. The backfilled
-- rows, and only those, carry org_backfilled = TRUE; no writer sets it (rows
-- written after 011 get the column DEFAULT FALSE). When the ETL syncs a CI
-- whose current row is backfilled and whose :CI node names an organization
-- (a customer CI created through POST /api/v1/cis before 011), it writes a
-- NEW current version in that organization, built from the node alone; the
-- backfilled history stays internal, so the node's organization reads none
-- of it. Every visit clears the marker. A complete neo4j-to-postgres sync
-- (no incrementalSince, no ciTypes filter) clears the markers of every CI
-- without a live node, even when some batches failed, so a node created
-- later with a deleted CI's id cannot take the backfilled CI over. Rows
-- labelled internal after 011 and customer organizations never get a version
-- in another organization. Nothing a client can write (such as a node's
-- created_at) takes part in the decision. Run that complete sync right after
-- applying 011.
--
-- Backfill: ADD COLUMN ... NOT NULL DEFAULT <constant> fills existing rows
-- from the catalog without rewriting the table (PostgreSQL 11+), so the SCD
-- history is not rewritten under the ACCESS EXCLUSIVE lock. The DEFAULT is
-- dropped in the same transaction: as in 008, there is no column DEFAULT
-- afterwards, so an insert that does not name its organization fails on
-- NOT NULL instead of silently landing in the internal organization. ETL
-- writers name it explicitly: the stored organization of a CI already in
-- cmdb.dim_ci (moved only as above); otherwise the :CI node's
-- organization_id, or the internal organization when the node has none (FD-4).
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

-- TRUE for every existing row (filled from the catalog, no rewrite), FALSE
-- for every row inserted afterwards.
ALTER TABLE cmdb.dim_ci
  ADD COLUMN IF NOT EXISTS org_backfilled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE cmdb.dim_ci ALTER COLUMN org_backfilled SET DEFAULT FALSE;

-- Serves the org-scoped cost trends (WHERE organization_id = $1 AND
-- effective_from >= ...). Current-row lookups keep using
-- idx_dim_ci_id_current, with organization_id as a filter.
CREATE INDEX IF NOT EXISTS idx_dim_ci_organization
  ON cmdb.dim_ci(organization_id, effective_from);

-- Serves the per-CI statements over every version of a ci_id (marker
-- clearing, WHERE ci_id = $1); idx_dim_ci_id_current covers current rows
-- only.
CREATE INDEX IF NOT EXISTS idx_dim_ci_ci_id_effective_from
  ON cmdb.dim_ci(ci_id, effective_from);

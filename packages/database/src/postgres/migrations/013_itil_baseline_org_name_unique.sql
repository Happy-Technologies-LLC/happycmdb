-- LH-2: the 001 global UNIQUE(name) prevents one tenant from reusing a hidden
-- foreign or legacy baseline name after 012 introduces organization ownership.
-- Create the per-tenant constraint before removing the global one: unexpected
-- duplicate names within an organization fail the migration rather than leave
-- the table without enforced same-organization uniqueness. The migrator applies
-- each file transactionally; NULL-owner legacy rows remain inaccessible to REST.
CREATE UNIQUE INDEX idx_itil_baselines_org_name
  ON itil_baselines(organization_id, name) WHERE organization_id IS NOT NULL;

-- Reject old API writers that omit organization_id without rewriting trusted
-- ownership onto historical NULL rows. NOT VALID skips existing rows but is
-- enforced for new inserts/updates; old writers fail closed after this cutover.
ALTER TABLE itil_baselines
  ADD CONSTRAINT itil_baselines_new_owner_required CHECK (organization_id IS NOT NULL) NOT VALID;

DROP INDEX IF EXISTS idx_itil_baselines_unique_name;

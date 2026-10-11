-- Roll back HAP-483 only; owner mapping must be reviewed before any deployment rollback.
DROP INDEX IF EXISTS idx_discovery_definitions_organization_id_id;
ALTER TABLE discovery_definitions DROP COLUMN IF EXISTS organization_id;

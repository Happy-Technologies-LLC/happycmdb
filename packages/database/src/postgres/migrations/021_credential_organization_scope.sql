-- LH-4 / HAP-473. Existing rows have no verified organization provenance.
-- Keep them NULL and inaccessible until an independently reviewed owner mapping
-- exists; never infer a tenant from an unverified creator string.
ALTER TABLE credentials ADD COLUMN organization_id UUID;
ALTER TABLE credential_sets ADD COLUMN organization_id UUID;

CREATE INDEX idx_credentials_owner_org ON credentials (created_by, organization_id);
CREATE INDEX idx_credential_sets_owner_org ON credential_sets (created_by, organization_id);
-- Names are unique within an owner and organization, not across tenants.
DROP INDEX idx_credentials_unique_name;
DROP INDEX idx_credential_sets_unique_name;
CREATE UNIQUE INDEX idx_credentials_unique_name ON credentials (name, created_by, organization_id)
  WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX idx_credential_sets_unique_name ON credential_sets (name, created_by, organization_id)
  WHERE organization_id IS NOT NULL;

-- The summary view must expose the tenant column for SQL-side filtering.
CREATE OR REPLACE VIEW credential_summaries AS
SELECT
  c.id, c.name, c.description, c.protocol, c.scope, c.affinity, c.tags,
  c.created_by, c.created_at, c.updated_at, c.last_validated_at, c.validation_status,
  (SELECT COUNT(*) FROM discovery_definitions dd WHERE dd.credential_id = c.id) AS usage_count,
  (SELECT COUNT(*) FROM connector_configurations cc WHERE cc.credential_id = c.id) AS connector_usage_count,
  c.organization_id
FROM credentials c
ORDER BY c.created_at DESC;

CREATE OR REPLACE VIEW credential_set_summaries AS
SELECT
  cs.id, cs.name, cs.description, cs.strategy, cs.stop_on_success, cs.tags,
  cs.created_by, cs.created_at, cs.updated_at, cs.credential_ids,
  (SELECT COUNT(*) FROM discovery_definitions dd WHERE dd.credential_set_id = cs.id) AS usage_count,
  (SELECT json_agg(
    json_build_object(
      'id', c.id, 'name', c.name, 'protocol', c.protocol, 'scope', c.scope,
      'affinity', c.affinity, 'priority', COALESCE((c.affinity->>'priority')::int, 5)
    )
    ORDER BY array_position(cs.credential_ids, c.id)
  ) FROM credentials c WHERE c.id = ANY(cs.credential_ids)
    AND c.created_by = cs.created_by AND c.organization_id = cs.organization_id) AS credentials,
  cs.organization_id
FROM credential_sets cs
ORDER BY cs.created_at DESC;

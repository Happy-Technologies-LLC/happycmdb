-- HAP-483: no verified tenant provenance exists for old definitions; leave NULL inaccessible.
ALTER TABLE discovery_definitions ADD COLUMN organization_id UUID;
CREATE INDEX idx_discovery_definitions_organization_id_id
  ON discovery_definitions (organization_id, id) WHERE organization_id IS NOT NULL;

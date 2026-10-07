-- R-CRED-2: additive org ownership; historical NULL records remain legacy.
ALTER TABLE connector_configurations ADD COLUMN organization_id UUID;
ALTER TABLE connector_run_history ADD COLUMN organization_id UUID;

-- Names are tenant-local. Preserve legacy name uniqueness without allowing
-- a foreign organization's name to be inferred through a create conflict.
DROP INDEX idx_connector_configs_name;
CREATE UNIQUE INDEX idx_connector_configs_org_name ON connector_configurations(organization_id, name)
  WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX idx_connector_configs_legacy_name ON connector_configurations(name)
  WHERE organization_id IS NULL;
CREATE INDEX idx_connector_configs_org ON connector_configurations(organization_id, id);
CREATE INDEX idx_connector_runs_org ON connector_run_history(organization_id, started_at DESC);

-- Serialize parent organization changes with run inserts, and refuse
-- mismatched run and parent organization (including NULL vs non-NULL).
CREATE FUNCTION enforce_connector_run_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_org UUID;
BEGIN
  SELECT organization_id INTO parent_org FROM connector_configurations
    WHERE id = NEW.config_id FOR SHARE;
  IF NOT FOUND OR NEW.organization_id IS DISTINCT FROM parent_org THEN
    RAISE EXCEPTION 'Connector run organization mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_run_organization_guard BEFORE INSERT OR UPDATE OF config_id, organization_id
  ON connector_run_history FOR EACH ROW EXECUTE FUNCTION enforce_connector_run_organization();

CREATE FUNCTION enforce_connector_config_organization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM connector_run_history WHERE config_id = NEW.id
             AND organization_id IS DISTINCT FROM NEW.organization_id) THEN
    RAISE EXCEPTION 'Connector configuration organization mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_config_organization_guard BEFORE UPDATE OF organization_id
  ON connector_configurations FOR EACH ROW EXECUTE FUNCTION enforce_connector_config_organization();

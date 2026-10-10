-- Keep 022's checksum stable. Replace its per-key full-document copies with
-- one object aggregation per level; continue treating nested {} as a no-op.
CREATE OR REPLACE FUNCTION public.connector_jsonb_merge(base jsonb, patch jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  merged jsonb;
BEGIN
  IF jsonb_typeof(patch) <> 'object' THEN
    RETURN patch;
  END IF;

  SELECT COALESCE(jsonb_object_agg(COALESCE(saved.key, changed.key),
    CASE
      WHEN changed.key IS NULL OR changed.value = '{}'::jsonb THEN saved.value
      WHEN jsonb_typeof(changed.value) = 'object'
        THEN public.connector_jsonb_merge(saved.value, changed.value)
      ELSE changed.value
    END) FILTER (WHERE saved.key IS NOT NULL OR changed.value <> '{}'::jsonb), '{}'::jsonb)
  INTO merged
  FROM jsonb_each(CASE WHEN jsonb_typeof(base) = 'object' THEN base ELSE '{}'::jsonb END) AS saved
  FULL JOIN jsonb_each(patch) AS changed USING (key);
  RETURN merged;
END;
$$;

-- Include every object value and array element; reject excessive depth.
CREATE FUNCTION public.connector_jsonb_nodes(doc jsonb, depth integer DEFAULT 0) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  child jsonb;
  total integer := 1;
BEGIN
  IF depth > 12 THEN RETURN 4097; END IF;
  IF jsonb_typeof(doc) = 'object' THEN
    FOR child IN SELECT value FROM jsonb_each(doc) LOOP
      total := total + public.connector_jsonb_nodes(child, depth + 1);
      IF total > 4096 THEN RETURN total; END IF;
    END LOOP;
  ELSIF jsonb_typeof(doc) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(doc) LOOP
      total := total + public.connector_jsonb_nodes(child, depth + 1);
      IF total > 4096 THEN RETURN total; END IF;
    END LOOP;
  END IF;
  RETURN total;
END;
$$;

-- Existing rows may exceed the new limit; do not reject those rows during
-- migration. All subsequent INSERT/UPDATE writes must satisfy the constraint.
ALTER TABLE connector_configurations ADD CONSTRAINT connector_config_json_budget CHECK (
  octet_length(connection::text)
    + octet_length(COALESCE(options, '{}'::jsonb)::text)
    + octet_length(COALESCE(resource_configs, '{}'::jsonb)::text) <= 65536
  AND public.connector_jsonb_nodes(connection)
    + public.connector_jsonb_nodes(COALESCE(options, '{}'::jsonb))
    + public.connector_jsonb_nodes(COALESCE(resource_configs, '{}'::jsonb)) <= 4096
) NOT VALID;

-- Merge connector write-only JSON without reading stored secrets into the application.
-- Empty nested objects are no-ops; a non-object base becomes an empty object when
-- the patch is an object. Callers bound patch size, nodes and depth before SQL.
CREATE FUNCTION public.connector_jsonb_merge(base jsonb, patch jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  merged jsonb;
  key text;
  child jsonb;
BEGIN
  IF jsonb_typeof(patch) <> 'object' THEN
    RETURN patch;
  END IF;
  merged := CASE WHEN jsonb_typeof(base) = 'object' THEN base ELSE '{}'::jsonb END;
  FOR key, child IN SELECT entry.key, entry.value FROM jsonb_each(patch) AS entry LOOP
    IF jsonb_typeof(child) = 'object' THEN
      IF child <> '{}'::jsonb THEN
        merged := jsonb_set(merged, ARRAY[key], public.connector_jsonb_merge(merged -> key, child), true);
      END IF;
    ELSE
      merged := jsonb_set(merged, ARRAY[key], child, true);
    END IF;
  END LOOP;
  RETURN merged;
END;
$$;

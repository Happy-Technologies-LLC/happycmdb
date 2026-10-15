-- HP1-S2 / HAP-441: keep pre-cutover NULL records inert. Never attribute them.
-- 012/013 already add baseline ownership and tenant name uniqueness on V1.
-- Only a complete V1 ITIL schema is activated; V2/V3 have no ITIL tables.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hp1$
DECLARE
  table_name text;
  present_count integer;
  relation_kind "char";
BEGIN
  SELECT count(*) INTO present_count FROM unnest(ARRAY[
    'itil_baselines', 'itil_incidents', 'itil_changes'
  ]) AS t(name) WHERE to_regclass(format('public.%I', name)) IS NOT NULL;
  IF present_count = 0 THEN
    RAISE NOTICE 'HP1-S2 ITIL records absent (V2/V3); no ITIL DDL';
    RETURN;
  END IF;
  IF present_count <> 3 THEN
    RAISE EXCEPTION 'HP1-S2 incomplete ITIL schema';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['itil_baselines', 'itil_incidents', 'itil_changes'] LOOP
    SELECT relkind INTO relation_kind FROM pg_class WHERE oid = to_regclass(format('public.%I', table_name));
    IF relation_kind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION 'HP1-S2 wrong object: %', table_name;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id uuid', table_name);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (organization_id IS NOT NULL) NOT VALID',
      table_name, table_name || '_organization_write_guard');
  END LOOP;
END
$hp1$;

DO $hp1$
BEGIN
  IF to_regclass('public.itil_baselines') IS NULL THEN RETURN; END IF;
  CREATE INDEX idx_itil_incidents_org_reported ON itil_incidents(organization_id, reported_at DESC);
  CREATE INDEX idx_itil_incidents_org_affected ON itil_incidents(organization_id, affected_ci_id);
  CREATE INDEX idx_itil_changes_org_created ON itil_changes(organization_id, created_at DESC);
  -- 013 removed the original global name index. Preserve its tenant index and
  -- recover uniqueness for the historical NULL-owner namespace.
  CREATE UNIQUE INDEX idx_itil_baselines_legacy_name ON itil_baselines(name) WHERE organization_id IS NULL;
END
$hp1$;

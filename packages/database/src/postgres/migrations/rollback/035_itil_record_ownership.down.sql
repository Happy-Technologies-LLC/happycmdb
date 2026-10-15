-- MANUAL ONLY. Never roll back while any owned record exists: old writers lack
-- tenant predicates. Baseline 012/013 ownership and name index remain intact.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $hp1$
DECLARE table_name text;
DECLARE present_count integer;
DECLARE owned boolean;
BEGIN
  SELECT count(*) INTO present_count FROM unnest(ARRAY[
    'itil_baselines', 'itil_incidents', 'itil_changes'
  ]) AS t(name) WHERE to_regclass(format('public.%I', name)) IS NOT NULL;
  IF present_count NOT IN (0, 3) THEN RAISE EXCEPTION '035 down incomplete ITIL schema'; END IF;
  IF present_count = 0 THEN RETURN; END IF;
  FOREACH table_name IN ARRAY ARRAY['itil_baselines', 'itil_incidents', 'itil_changes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass(format('public.%I', table_name)) AND relkind IN ('r', 'p')) THEN
      RAISE EXCEPTION '035 down wrong object: %', table_name;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE organization_id IS NOT NULL)', table_name) INTO owned;
    IF owned THEN RAISE EXCEPTION '035 down refuses owned ITIL records in %', table_name; END IF;
  END LOOP;
  DROP INDEX idx_itil_incidents_org_reported;
  DROP INDEX idx_itil_incidents_org_affected;
  DROP INDEX idx_itil_changes_org_created;
  DROP INDEX idx_itil_baselines_legacy_name;
  ALTER TABLE itil_baselines DROP CONSTRAINT itil_baselines_organization_write_guard;
  ALTER TABLE itil_incidents DROP CONSTRAINT itil_incidents_organization_write_guard;
  ALTER TABLE itil_changes DROP CONSTRAINT itil_changes_organization_write_guard;
  ALTER TABLE itil_incidents DROP COLUMN organization_id;
  ALTER TABLE itil_changes DROP COLUMN organization_id;
END
$hp1$;
DO $ledger$ BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NOT NULL THEN
    DELETE FROM cmdb.schema_migrations WHERE migration_name = '035_itil_record_ownership.sql';
  END IF;
END $ledger$;
COMMIT;

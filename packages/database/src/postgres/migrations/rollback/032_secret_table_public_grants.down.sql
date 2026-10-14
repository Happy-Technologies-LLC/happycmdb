-- HAP-630 manual rollback ONLY; restores 001's unsafe PUBLIC grants.
-- Requires separate explicit authorization; never run as routine recovery.
-- BI blanket grants are intentionally NOT recreated: historical named grants
-- cannot be reconstructed from the migration, and doing so would leak secrets.
-- Run: psql -v ON_ERROR_STOP=1 -f 032_secret_table_public_grants.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $acl$
DECLARE
  name text;
  kind "char";
BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NULL THEN
    RAISE EXCEPTION '032 down requires its migration ledger row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cmdb.schema_migrations
                 WHERE migration_name = '032_secret_table_public_grants.sql') THEN
    RAISE EXCEPTION '032 down requires its migration ledger row';
  END IF;
  FOREACH name IN ARRAY ARRAY[
    'api_keys', 'credentials', 'credential_sets', 'discovery_definitions',
    'connector_configurations', 'system_config', 'active_api_keys',
    'credential_summaries', 'credential_set_summaries',
    'discovery_definitions_with_credentials'
  ] LOOP
    SELECT c.relkind INTO kind FROM pg_class c
      WHERE c.oid = to_regclass(format('public.%I', name));
    IF kind IS DISTINCT FROM CASE WHEN name IN ('active_api_keys', 'credential_summaries',
        'credential_set_summaries', 'discovery_definitions_with_credentials')
      THEN 'v'::"char" ELSE 'r'::"char" END THEN
      RAISE EXCEPTION '032 down wrong or missing public.% relation', name;
    END IF;
  END LOOP;
END
$acl$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys, public.credentials,
  public.credential_sets, public.discovery_definitions TO PUBLIC;
GRANT SELECT ON public.active_api_keys, public.credential_summaries,
  public.credential_set_summaries, public.discovery_definitions_with_credentials TO PUBLIC;
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '032_secret_table_public_grants.sql';
COMMIT;

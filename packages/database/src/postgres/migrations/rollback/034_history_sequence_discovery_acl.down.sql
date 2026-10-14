-- HAP-668 manual rollback ONLY; restores unsafe raw-history and cmdb sequence
-- PUBLIC grants. Requires separate authorization. Discovery-agent grants stay
-- closed: migration 019 already removed them on upgraded databases.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  item record;
  kind "char";
  sequence_name text;
BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NULL OR NOT EXISTS
    (SELECT 1 FROM cmdb.schema_migrations
     WHERE migration_name = '034_history_sequence_discovery_acl.sql') THEN
    RAISE EXCEPTION '034 down requires its migration ledger row';
  END IF;
  IF EXISTS (SELECT 1 FROM cmdb.schema_migrations
             WHERE migration_name > '034_history_sequence_discovery_acl.sql') THEN
    RAISE EXCEPTION '034 down refused: later migration still recorded';
  END IF;
  IF EXISTS (SELECT 1 FROM cmdb.schema_migrations
             WHERE migration_name = '032_secret_table_public_grants.sql')
     AND NOT EXISTS (SELECT 1 FROM cmdb.schema_migrations
                     WHERE migration_name = '033_public_business_service_audit_acl.sql') THEN
    RAISE EXCEPTION '034 down requires 033 while 032 is recorded';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('public.ci_change_history', 'r'),
    ('public.discovery_agents', 'r'),
    ('public.active_discovery_agents', 'v'),
    ('public.agent_network_coverage', 'v')
  ) AS required(name, expected) LOOP
    SELECT c.relkind INTO kind FROM pg_class c WHERE c.oid = to_regclass(item.name);
    IF kind IS DISTINCT FROM item.expected::"char" THEN
      RAISE EXCEPTION '034 down wrong or missing relation %', item.name;
    END IF;
  END LOOP;
  FOREACH sequence_name IN ARRAY ARRAY[
    'dim_ci', 'dim_location', 'dim_owner', 'fact_discovery',
    'fact_ci_changes', 'fact_ci_relationships'
  ] LOOP
    IF pg_get_serial_sequence(format('cmdb.%I', sequence_name),
      CASE sequence_name
        WHEN 'dim_ci' THEN 'ci_key'
        WHEN 'dim_location' THEN 'location_key'
        WHEN 'dim_owner' THEN 'owner_key'
        WHEN 'fact_discovery' THEN 'discovery_key'
        WHEN 'fact_ci_changes' THEN 'change_key'
        ELSE 'relationship_key'
      END) IS NULL THEN
      RAISE EXCEPTION '034 down missing cmdb serial sequence for %', sequence_name;
    END IF;
  END LOOP;
END
$acl$;
GRANT SELECT ON public.ci_change_history TO PUBLIC;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cmdb TO PUBLIC;
-- Never restore the pre-019 raw discovery-agent grants.
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '034_history_sequence_discovery_acl.sql';
COMMIT;

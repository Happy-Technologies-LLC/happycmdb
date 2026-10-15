-- HAP-668 manual rollback ONLY. Restore only the PUBLIC history/sequence ACLs
-- captured by 034: legacy 001 was open, but standalone fresh init was closed.
-- Requires separate authorization; discovery-agent grants remain closed by 019.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  item record;
  kind "char";
  sequence_name text;
BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NULL THEN
    RAISE EXCEPTION '034 down requires its migration ledger row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cmdb.schema_migrations
                 WHERE migration_name = '034_history_sequence_discovery_acl.sql') THEN
    RAISE EXCEPTION '034 down requires its migration ledger row';
  END IF;
  IF to_regclass('cmdb.hap668_acl_prior') IS NULL THEN
    RAISE EXCEPTION '034 down requires its prior ACL snapshot';
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
  -- Refuse to restore against missing/replaced objects or newly added sequences:
  -- a partial snapshot must never accidentally widen a fresh installation.
  IF NOT EXISTS (
      SELECT 1 FROM cmdb.hap668_acl_prior
      WHERE relation_oid = 'public.ci_change_history'::regclass AND relation_kind = 'r'
    ) OR EXISTS (
      SELECT 1 FROM cmdb.hap668_acl_prior p
      LEFT JOIN pg_class c ON c.oid = p.relation_oid
      WHERE c.relkind IS DISTINCT FROM p.relation_kind
         OR (p.relation_kind = 'S' AND c.relnamespace IS DISTINCT FROM 'cmdb'::regnamespace)
         OR (p.relation_kind <> 'S' AND p.relation_oid <> 'public.ci_change_history'::regclass)
    ) OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'cmdb' AND c.relkind = 'S'
        AND NOT EXISTS (SELECT 1 FROM cmdb.hap668_acl_prior p WHERE p.relation_oid = c.oid)
    ) THEN
    RAISE EXCEPTION '034 down prior ACL snapshot does not match current relations';
  END IF;
  FOR item IN SELECT * FROM cmdb.hap668_acl_prior LOOP
    IF item.relation_kind = 'S' THEN
      IF item.public_usage THEN
        EXECUTE format('GRANT USAGE ON SEQUENCE %s TO PUBLIC', item.relation_oid::regclass);
      ELSE
        EXECUTE format('REVOKE USAGE ON SEQUENCE %s FROM PUBLIC', item.relation_oid::regclass);
      END IF;
    END IF;
    IF item.public_select THEN
      EXECUTE format('GRANT SELECT ON %s %s TO PUBLIC',
        CASE WHEN item.relation_kind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
        item.relation_oid::regclass);
    ELSE
      EXECUTE format('REVOKE SELECT ON %s %s FROM PUBLIC',
        CASE WHEN item.relation_kind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
        item.relation_oid::regclass);
    END IF;
  END LOOP;
END
$acl$;
-- Leave 019's raw discovery-agent grants closed; remove only 034's own state.
DROP TABLE cmdb.hap668_acl_prior;
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '034_history_sequence_discovery_acl.sql';
COMMIT;

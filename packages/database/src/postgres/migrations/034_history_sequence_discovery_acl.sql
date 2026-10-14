-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-668: close legacy raw history, cmdb sequence and discovery-agent ACLs.
-- The migrator executes this file and records it in one transaction.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  item record;
  kind "char";
  sequence_name text;
BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cmdb.schema_migrations
               WHERE migration_name = '032_secret_table_public_grants.sql')
       AND NOT EXISTS (SELECT 1 FROM cmdb.schema_migrations
                       WHERE migration_name = '033_public_business_service_audit_acl.sql') THEN
      RAISE EXCEPTION '034 requires 033 while 032 is recorded';
    END IF;
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('public.ci_change_history', 'r'),
    ('public.discovery_agents', 'r'),
    ('public.active_discovery_agents', 'v'),
    ('public.agent_network_coverage', 'v')
  ) AS required(name, expected) LOOP
    SELECT c.relkind INTO kind FROM pg_class c WHERE c.oid = to_regclass(item.name);
    IF kind IS DISTINCT FROM item.expected::"char" THEN
      RAISE EXCEPTION '034 wrong or missing relation %', item.name;
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
      RAISE EXCEPTION '034 missing cmdb serial sequence for %', sequence_name;
    END IF;
  END LOOP;
  -- Preserve the actual PUBLIC ACL, not an assumption about 001 vs. a
  -- standalone initializer. A repeated manual apply must not overwrite it.
  IF to_regclass('cmdb.hap668_acl_prior') IS NOT NULL THEN
    RAISE EXCEPTION '034 prior ACL snapshot already exists';
  END IF;
  CREATE TABLE cmdb.hap668_acl_prior (
    relation_oid oid PRIMARY KEY,
    relation_kind "char" NOT NULL,
    public_select boolean NOT NULL,
    public_usage boolean NOT NULL
  );
  INSERT INTO cmdb.hap668_acl_prior
    (relation_oid, relation_kind, public_select, public_usage)
  SELECT c.oid, c.relkind,
    EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
            WHERE a.grantee = 0 AND a.privilege_type = 'SELECT'),
    EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
            WHERE a.grantee = 0 AND a.privilege_type = 'USAGE')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = 'public.ci_change_history'::regclass
     OR (n.nspname = 'cmdb' AND c.relkind = 'S');
  REVOKE SELECT ON public.ci_change_history FROM PUBLIC;
  REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cmdb FROM PUBLIC;
  REVOKE SELECT, INSERT, UPDATE, DELETE ON public.discovery_agents FROM PUBLIC;
  REVOKE SELECT ON public.active_discovery_agents, public.agent_network_coverage FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    GRANT SELECT, INSERT ON public.ci_change_history TO cmdb_user;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA cmdb TO cmdb_user;
    GRANT SELECT, INSERT ON cmdb.dim_ci, cmdb.dim_location, cmdb.dim_owner,
      cmdb.fact_discovery, cmdb.fact_ci_changes, cmdb.fact_ci_relationships TO cmdb_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_agents TO cmdb_user;
    GRANT SELECT ON public.active_discovery_agents, public.agent_network_coverage TO cmdb_user;
  END IF;
END
$acl$;

-- HAP-644 manual rollback ONLY. Restores unsafe 001 PUBLIC privileges;
-- requires separate authorization. Named BI raw/health grants are NOT restored.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  item record;
  kind "char";
BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NULL OR NOT EXISTS
    (SELECT 1 FROM cmdb.schema_migrations
     WHERE migration_name = '033_public_business_service_audit_acl.sql') THEN
    RAISE EXCEPTION '033 down requires its migration ledger row';
  END IF;
  IF EXISTS (SELECT 1 FROM cmdb.schema_migrations
             WHERE migration_name = '034_history_sequence_discovery_acl.sql') THEN
    RAISE EXCEPTION '033 down refused: 034 migration still recorded';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('public.dim_business_services', 'r'),
    ('public.business_service_dependencies', 'r'),
    ('public.ci_business_service_mappings', 'r'),
    ('public.fact_business_service_incidents', 'r'),
    ('public.fact_business_service_changes', 'r'),
    ('public.business_services', 'r'),
    ('public.audit_log', 'r'),
    ('public.v_ci_change_history_audit', 'v'),
    ('public.v_business_service_health', 'v'),
    ('public.v_tbm_tower_summary', 'v'),
    ('cmdb.dim_ci', 'r')
  ) AS required(name, expected) LOOP
    IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NULL
       AND item.name IN ('public.dim_business_services', 'public.business_service_dependencies',
         'public.ci_business_service_mappings', 'public.fact_business_service_incidents',
         'public.fact_business_service_changes', 'public.business_services',
         'public.v_business_service_health', 'public.v_tbm_tower_summary') THEN
      CONTINUE;
    END IF;
    SELECT c.relkind INTO kind FROM pg_class c WHERE c.oid = to_regclass(item.name);
    IF kind IS DISTINCT FROM item.expected::"char" THEN
      RAISE EXCEPTION '033 down wrong or missing relation %', item.name;
    END IF;
  END LOOP;
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NULL
     AND EXISTS (SELECT 1 FROM unnest(ARRAY[
       'public.dim_business_services', 'public.business_service_dependencies',
       'public.ci_business_service_mappings', 'public.fact_business_service_incidents',
       'public.fact_business_service_changes', 'public.business_services',
       'public.v_business_service_health', 'public.v_tbm_tower_summary'
     ]) AS names(relation) WHERE to_regclass(relation) IS NOT NULL) THEN
    RAISE EXCEPTION '033 down requires the complete FD-6 business-service schema';
  END IF;
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL THEN
    IF (SELECT p.prosecdef FROM pg_proc p
        WHERE p.oid = to_regprocedure('cmdb.fn_business_service_health(uuid)')) IS DISTINCT FROM true THEN
      RAISE EXCEPTION '033 down requires its definer health function';
    END IF;
    EXECUTE 'ALTER FUNCTION cmdb.fn_business_service_health(uuid) SECURITY INVOKER';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION cmdb.fn_business_service_health(uuid) FROM metabase_readonly';
    END IF;
  END IF;
END
$acl$;
-- Restore only 001's cmdb grants on the 001 schema. Older standalone V3
-- initializers did grant PUBLIC cmdb SELECT; that legacy path stays intentionally
-- closed on rollback rather than reinstating an unsafe blanket grant.
DO $acl$
BEGIN
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL THEN
    GRANT SELECT ON cmdb.dim_time, cmdb.dim_ci, cmdb.dim_location,
      cmdb.dim_owner, cmdb.fact_discovery, cmdb.fact_ci_changes,
      cmdb.fact_ci_relationships, cmdb.v_current_ci_inventory,
      cmdb.v_ci_discovery_summary, cmdb.v_ci_change_history,
      cmdb.v_ci_relationships TO PUBLIC;
  END IF;
END
$acl$;
GRANT SELECT ON public.audit_log, public.v_ci_change_history_audit TO PUBLIC;
DO $acl$
BEGIN
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.dim_business_services,
      public.business_service_dependencies, public.ci_business_service_mappings TO PUBLIC;
    GRANT SELECT, INSERT ON public.fact_business_service_incidents,
      public.fact_business_service_changes TO PUBLIC;
  END IF;
END
$acl$;
-- 010 already revoked PUBLIC from both org views; business_services had no
-- PUBLIC grant in 001. Neither is widened by this rollback.
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '033_public_business_service_audit_acl.sql';
COMMIT;

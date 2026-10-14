-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-644: close legacy PUBLIC and named BI access to sensitive CI,
-- business-service and audit data. Run as the schema/view owner. The migrator
-- commits this file and its ledger entry in the same transaction.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  item record;
  kind "char";
  sequence_table text;
BEGIN
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NULL
     AND EXISTS (SELECT 1 FROM unnest(ARRAY[
       'public.dim_business_services', 'public.business_service_dependencies',
       'public.ci_business_service_mappings', 'public.fact_business_service_incidents',
       'public.fact_business_service_changes', 'public.business_services',
       'public.v_business_service_health', 'public.v_tbm_tower_summary'
     ]) AS names(relation) WHERE to_regclass(relation) IS NOT NULL) THEN
    RAISE EXCEPTION '033 requires the complete FD-6 business-service schema';
  END IF;
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL
     AND (SELECT p.prosecdef FROM pg_proc p
          WHERE p.oid = to_regprocedure('cmdb.fn_business_service_health(uuid)')) IS DISTINCT FROM false THEN
    RAISE EXCEPTION '033 requires the invoker-only FD-6 health function';
  END IF;
  FOR item IN
    SELECT c.oid, c.relname, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'cmdb' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    EXECUTE format('REVOKE SELECT ON %s FROM PUBLIC', item.oid::regclass);
  END LOOP;
  FOR item IN
    SELECT * FROM (VALUES
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
    ) AS required(name, expected)
  LOOP
    -- The standalone V3 initializer does not create the 001/010 service
    -- objects. Its audit and cmdb ACLs still need to be closed.
    IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NULL
       AND item.name IN ('public.dim_business_services', 'public.business_service_dependencies',
         'public.ci_business_service_mappings', 'public.fact_business_service_incidents',
         'public.fact_business_service_changes', 'public.business_services',
         'public.v_business_service_health', 'public.v_tbm_tower_summary') THEN
      CONTINUE;
    END IF;
    SELECT c.relkind INTO kind FROM pg_class c WHERE c.oid = to_regclass(item.name);
    IF kind IS DISTINCT FROM item.expected::"char" THEN
      RAISE EXCEPTION '033 wrong or missing relation %', item.name;
    END IF;
  END LOOP;
  REVOKE ALL ON public.audit_log, public.v_ci_change_history_audit FROM PUBLIC;
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL THEN
    REVOKE ALL ON public.dim_business_services, public.business_service_dependencies,
      public.ci_business_service_mappings, public.fact_business_service_incidents,
      public.fact_business_service_changes, public.business_services FROM PUBLIC;
  END IF;
  -- Never give BI the unfiltered definer view. 032's allowlist may have
  -- installed the named grant even though 010 removed its PUBLIC grant.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    REVOKE ALL ON public.audit_log, public.v_ci_change_history_audit FROM metabase_readonly;
    IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL THEN
      REVOKE ALL ON public.dim_business_services, public.business_service_dependencies,
        public.ci_business_service_mappings, public.fact_business_service_incidents,
        public.fact_business_service_changes, public.business_services,
        public.v_business_service_health, public.v_tbm_tower_summary FROM metabase_readonly;
    END IF;
    REVOKE SELECT ON ALL TABLES IN SCHEMA cmdb FROM metabase_readonly;
    -- Restore only the audited redacted view after removing the legacy blanket.
    GRANT SELECT ON cmdb.v_ci_discovery_summary TO metabase_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    GRANT SELECT ON ALL TABLES IN SCHEMA cmdb TO cmdb_user;
    IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.dim_business_services,
        public.business_service_dependencies, public.ci_business_service_mappings,
        public.business_services TO cmdb_user;
      GRANT SELECT, INSERT ON public.fact_business_service_incidents,
        public.fact_business_service_changes TO cmdb_user;
      FOREACH sequence_table IN ARRAY ARRAY[
        'business_service_dependencies', 'ci_business_service_mappings',
        'fact_business_service_incidents', 'fact_business_service_changes'
      ] LOOP
        IF pg_get_serial_sequence(format('public.%I', sequence_table), 'id') IS NULL THEN
          RAISE EXCEPTION '033 missing business-service id sequence for %', sequence_table;
        END IF;
        EXECUTE format('GRANT USAGE ON SEQUENCE %s TO cmdb_user',
          pg_get_serial_sequence(format('public.%I', sequence_table), 'id'));
      END LOOP;
      GRANT SELECT ON public.v_business_service_health, public.v_tbm_tower_summary TO cmdb_user;
    END IF;
    GRANT SELECT, INSERT ON public.audit_log TO cmdb_user;
    GRANT SELECT ON public.v_ci_change_history_audit TO cmdb_user;
  END IF;
END
$acl$;
-- 010's fixed-search-path function filters on p_org inside its definer view.
-- Its owner must also own the view; no caller can read the view directly.
DO $acl$
BEGIN
  IF to_regprocedure('cmdb.fn_business_service_health(uuid)') IS NOT NULL THEN
    IF (SELECT p.proowner FROM pg_proc p
        WHERE p.oid = 'cmdb.fn_business_service_health(uuid)'::regprocedure) IS DISTINCT FROM
       (SELECT c.relowner FROM pg_class c
        WHERE c.oid = 'public.v_business_service_health'::regclass) THEN
      RAISE EXCEPTION '033 health function and view require the same owner';
    END IF;
    EXECUTE 'ALTER FUNCTION cmdb.fn_business_service_health(uuid) SECURITY DEFINER';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION cmdb.fn_business_service_health(uuid) FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION cmdb.fn_business_service_health(uuid) TO metabase_readonly';
    END IF;
  END IF;
END
$acl$;

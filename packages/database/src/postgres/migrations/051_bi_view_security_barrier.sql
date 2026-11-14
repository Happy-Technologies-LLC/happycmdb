-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- cmdb#318 security review follow-up (HAP-659). Three changes, all idempotent:
--
-- 1. security_barrier on every BI-granted view of infrastructure/database/views/cost-analysis.sql that has no LIMIT
--    (the seven views 032 grants, plus v_underutilized_resources). Without it the planner may push a predicate that
--    metabase_readonly supplies (a leaky function or a cast that raises) below the view's own WHERE, so the
--    predicate runs on rows the view filters out (non-current or inactive CIs) and leaks them through errors or
--    side effects. v_top_cost_drivers_bi already has LIMIT 20, which blocks that push-down, so it is untouched.
--    cost-analysis.sql now creates them WITH (security_barrier), because CREATE OR REPLACE VIEW without the option
--    resets it. Cost: the planner cannot push a BI filter into these views, so a filtered BI query scans the whole
--    view first.
--
-- 2. 050's shape guard, tightened (050 is applied and checksummed, so this file is its successor). A per-CI cost view
--    is granted to metabase_readonly only when it is a view, is owned by the migration role, and carries no json or
--    jsonb value: not as a column, not through a domain, array or composite type over json/jsonb, and no column named
--    metadata. Otherwise it is skipped and any grant on it is revoked. "The migration role" is the owner of
--    cmdb.dim_ci (cmdb_user, the login that builds the schema and runs cost-analysis.sql); a view owned by anyone
--    else could be redefined by that owner after this check. A view that does not exist is skipped, and so is a
--    database without metabase_readonly.
--
-- 3. REVOKE TEMPORARY ON DATABASE from metabase_readonly. No BI feature needs it: the Metabase PostgreSQL driver
--    reads the allowlisted views with plain SELECTs, and nothing in this repository creates a temporary object as the
--    BI role. NOTE: TEMPORARY is granted to PUBLIC by default, and a role keeps it through PUBLIC; this REVOKE
--    removes only a grant made to metabase_readonly itself. This migration does NOT revoke it from PUBLIC (that
--    changes every role); it warns while metabase_readonly can still create temporary tables.
--
-- Run as the owner of the views (or a member of that role). Manual rollback: rollback/051_bi_view_security_barrier.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $bi$
DECLARE
  name text;
  rel regclass;
  expected_owner oid := (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass('cmdb.dim_ci'));
  has_bi boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly');
  unsafe boolean;
BEGIN
  -- (1) security_barrier on the unbounded cost views.
  FOREACH name IN ARRAY ARRAY[
    'public.v_executive_cost_summary', 'public.v_cost_by_tower', 'public.v_cost_trends',
    'public.v_unit_economics', 'public.v_cloud_vs_onprem_costs', 'public.v_cost_allocation_summary',
    'public.v_depreciation_summary', 'public.v_underutilized_resources'
  ] LOOP
    rel := to_regclass(name);
    CONTINUE WHEN rel IS NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = rel AND c.relkind = 'v'
                   AND c.relowner IS NOT DISTINCT FROM expected_owner) THEN
      RAISE WARNING '051 % is not a view owned by the owner of cmdb.dim_ci; security_barrier not set', rel;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER VIEW %s SET (security_barrier = true)', rel);
  END LOOP;

  IF NOT has_bi THEN
    RETURN;
  END IF;

  -- (2) the per-CI views BI may read, granted by shape.
  FOREACH name IN ARRAY ARRAY['public.v_top_cost_drivers_bi', 'public.v_underutilized_resources'] LOOP
    rel := to_regclass(name);
    CONTINUE WHEN rel IS NULL;
    SELECT NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = rel AND c.relkind = 'v'
                       AND c.relowner IS NOT DISTINCT FROM expected_owner)
        OR EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
                     AND lower(a.attname) = 'metadata')
        OR EXISTS (
          WITH RECURSIVE ty(oid) AS (
            SELECT a.atttypid FROM pg_attribute a
            WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
            UNION
            SELECT n.oid
            FROM ty
              JOIN pg_type t ON t.oid = ty.oid
              CROSS JOIN LATERAL (
                SELECT t.typbasetype WHERE t.typtype = 'd'
                UNION ALL
                SELECT t.typelem WHERE t.typcategory = 'A'
                UNION ALL
                SELECT f.atttypid FROM pg_attribute f
                WHERE t.typtype = 'c' AND f.attrelid = t.typrelid AND f.attnum > 0 AND NOT f.attisdropped
              ) n(oid)
          )
          SELECT 1 FROM ty WHERE ty.oid IN ('json'::regtype, 'jsonb'::regtype))
      INTO unsafe;
    IF unsafe THEN
      RAISE WARNING '051 % is not a view owned by the owner of cmdb.dim_ci, or carries json/jsonb or a metadata column; not granting it to metabase_readonly', rel;
      EXECUTE format('REVOKE ALL ON %s FROM metabase_readonly', rel);
    ELSE
      EXECUTE format('GRANT SELECT ON %s TO metabase_readonly', rel);
    END IF;
  END LOOP;

  -- (3) no temporary objects for the BI role.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM metabase_readonly', current_database());
  IF has_database_privilege('metabase_readonly', current_database(), 'TEMPORARY') THEN
    RAISE WARNING '051 metabase_readonly can still create temporary tables through the PUBLIC grant on database %; REVOKE TEMPORARY ... FROM PUBLIC is a separate, all-roles decision', current_database();
  END IF;
END
$bi$;

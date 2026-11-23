-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-659: the BI role reads two per-CI cost views that infrastructure/database/views/cost-analysis.sql creates:
-- v_top_cost_drivers_bi (v_top_cost_drivers without ci.metadata) and v_underutilized_resources. 032's allowlist is
-- frozen, and a `--no-acl` restore (backup-postgres.sh) brings back no GRANT, so this migration is the successor
-- that re-grants them after a restore (it is in restore-postgres.sh's post-restore list).
-- The grant depends on the view's SHAPE, not only its name: a view with any json/jsonb column or a column named
-- metadata is not granted (and loses any grant), because dim_ci.metadata is unbounded, secret-capable JSONB that BI
-- must never read. v_top_cost_drivers itself carries ci.metadata and is never granted. A view that does not exist
-- is skipped (the view file is run by hand); so is a database without metabase_readonly. Additive and idempotent.
-- Manual rollback: rollback/050_bi_cost_view_grants.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  name text;
  rel regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    RETURN;
  END IF;
  FOREACH name IN ARRAY ARRAY['public.v_top_cost_drivers_bi', 'public.v_underutilized_resources'] LOOP
    rel := to_regclass(name);
    CONTINUE WHEN rel IS NULL;
    IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = rel AND c.relkind <> 'v')
       OR EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
                    AND (a.atttypid IN ('jsonb'::regtype, 'json'::regtype, 'jsonb[]'::regtype, 'json[]'::regtype)
                         OR lower(a.attname) = 'metadata')) THEN
      RAISE WARNING '050 % has a jsonb or metadata column or is not a view; not granting it to metabase_readonly', rel;
      EXECUTE format('REVOKE ALL ON %s FROM metabase_readonly', rel);
    ELSE
      EXECUTE format('GRANT SELECT ON %s TO metabase_readonly', rel);
    END IF;
  END LOOP;
END
$acl$;

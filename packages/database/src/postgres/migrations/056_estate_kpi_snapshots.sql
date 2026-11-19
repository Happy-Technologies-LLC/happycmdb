-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-1925 (UX-4b BW7): daily snapshots of four estate KPIs, so GET /analytics/dashboard can return per-KPI history
-- (up to 10 recorded days) and the delta against the previous recorded day.
--   key      (organization_id, snapshot_date, metric): one value per organization, UTC day and metric. The first snapshot
--            of a day is the day's value and is never rewritten (INSERT ... ON CONFLICT DO NOTHING).
--   metric   closed token list: health_score, open_drift_count, configuration_coverage_ratio, total_cis.
--   value    finite and non-negative; an unavailable (unknown) figure is never written, so there is no row to read as 0.
-- No FKs: CIs and organizations live elsewhere (precedent 054). Rows are written on dashboard reads: a day with no read
-- has no row (a sparse series, not a filled calendar).
-- Append-only twice: SELECT, INSERT only to the app logins that exist (cmdb_user, cmdb_app; per-table, as 054), and a
-- trigger that refuses UPDATE, DELETE and TRUNCATE with 55000 so an API that connects as the table owner is protected too.
-- Tenancy is the organization_id column and the org predicate of every query AND, for this table only, row level security:
-- ENABLE and FORCE (the owner is subject too) with one policy keyed on the transaction-local setting cmdb.organization_id.
-- An unset or empty setting matches no row (reads see nothing, INSERT fails WITH CHECK). Defence in depth, not a sole
-- control: any session may SET the setting. As 046/047/048/054, rollback/045 also un-records 056 so the migrator
-- re-grants cmdb_app on the way back.
--
-- Idempotent; the migrator records it in one transaction. A wrong relation kind aborts.
-- Manual rollback: rollback/056_estate_kpi_snapshots.down.sql (refuses while the table holds a row).
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hap1925$
DECLARE
  app_login text;
BEGIN
  -- NULL (no such relation) is not <> 'r', so only a wrong existing object aborts.
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.estate_kpi_snapshots')) <> 'r' THEN
    RAISE EXCEPTION 'HAP-1925 wrong object: estate_kpi_snapshots';
  END IF;

  CREATE TABLE IF NOT EXISTS public.estate_kpi_snapshots (
    organization_id UUID NOT NULL,
    snapshot_date DATE NOT NULL,
    metric VARCHAR(40) NOT NULL,
    value NUMERIC NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, snapshot_date, metric),
    CONSTRAINT estate_kpi_snapshots_metric CHECK (metric IN
      ('health_score', 'open_drift_count', 'configuration_coverage_ratio', 'total_cis')),
    CONSTRAINT estate_kpi_snapshots_value CHECK (value >= 0 AND value <> 'NaN'::numeric)
  );

  CREATE OR REPLACE FUNCTION public.estate_kpi_snapshots_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'estate_kpi_snapshots is append-only' USING ERRCODE = '55000';
  END;
  $fn$;

  CREATE OR REPLACE TRIGGER estate_kpi_snapshots_no_update_delete
    BEFORE UPDATE OR DELETE ON public.estate_kpi_snapshots
    FOR EACH ROW EXECUTE FUNCTION public.estate_kpi_snapshots_append_only();
  CREATE OR REPLACE TRIGGER estate_kpi_snapshots_no_truncate
    BEFORE TRUNCATE ON public.estate_kpi_snapshots
    FOR EACH STATEMENT EXECUTE FUNCTION public.estate_kpi_snapshots_append_only();

  ALTER TABLE public.estate_kpi_snapshots ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.estate_kpi_snapshots FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS estate_kpi_snapshots_organization ON public.estate_kpi_snapshots;
  CREATE POLICY estate_kpi_snapshots_organization ON public.estate_kpi_snapshots
    USING (organization_id = nullif(current_setting('cmdb.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('cmdb.organization_id', true), '')::uuid);

  REVOKE ALL ON public.estate_kpi_snapshots FROM PUBLIC;
  FOREACH app_login IN ARRAY ARRAY['cmdb_user', 'cmdb_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_login) THEN
      EXECUTE format('GRANT SELECT, INSERT ON public.estate_kpi_snapshots TO %I', app_login);
    END IF;
  END LOOP;
END
$hap1925$;

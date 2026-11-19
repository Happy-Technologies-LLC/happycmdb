-- Rollback for 056_estate_kpi_snapshots.sql. MANUAL ONLY; not authorized for any environment without a separate
-- named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- When: AFTER replacing the API image with one older than HAP-1925 BW7. An older image never names the table; a BW7 image
-- answers `kpi_history: null` (and names it in `unavailable`) while the table is gone, the dashboard keeps its figures.
--
-- REFUSES while the table holds any row: the history is not rebuildable (a snapshot is the figure of its day). To discard
-- it deliberately, an operator empties the table first as the owner, with the append-only trigger disabled in a
-- disposable database (ALTER TABLE ... DISABLE TRIGGER USER); that is a separate named decision, never part of this script.
-- Empty: drops the table and function and un-records the migration (re-applying 056 creates an empty table).
--
-- Run: psql -v ON_ERROR_STOP=1 -f 056_estate_kpi_snapshots.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $hap1925$
BEGIN
  IF to_regclass('public.estate_kpi_snapshots') IS NOT NULL THEN
    -- The table forces row level security, so even its owner sees no row without the organization setting. Counting needs
    -- every row: switch RLS off for this transaction only (the refusal below rolls the ALTERs back too).
    ALTER TABLE public.estate_kpi_snapshots NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.estate_kpi_snapshots DISABLE ROW LEVEL SECURITY;
    IF EXISTS (SELECT 1 FROM public.estate_kpi_snapshots) THEN
      RAISE EXCEPTION '056 rollback refused: estate_kpi_snapshots holds history (rows are never dropped by accident)';
    END IF;
  END IF;
END
$hap1925$;
DROP TABLE IF EXISTS public.estate_kpi_snapshots;
DROP FUNCTION IF EXISTS public.estate_kpi_snapshots_append_only();
DELETE FROM cmdb.schema_migrations WHERE migration_name = '056_estate_kpi_snapshots.sql';
COMMIT;

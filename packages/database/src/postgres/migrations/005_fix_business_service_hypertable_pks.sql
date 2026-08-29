-- 005_fix_business_service_hypertable_pks.sql
--
-- fact_business_service_incidents and fact_business_service_changes are
-- TimescaleDB hypertables partitioned on incident_date / change_date. A
-- single-column PRIMARY KEY (id) on a hypertable is not enforced across
-- chunks -- only a unique constraint that includes the partitioning
-- column is. 001_complete_schema.sql has since been corrected in place to
-- create these tables with composite primary keys (id, incident_date) and
-- (id, change_date), so any newly bootstrapped database already has the
-- right shape and this migration is a no-op for it.
--
-- This migration is a defensive repair for schemas provisioned outside the
-- numbered migrator before the corrected 001 landed. The normal migration
-- runner could not record the broken 001: the hypertable conversion and the
-- schema_migrations insert share one transaction, so the TimescaleDB error
-- rolled both back. Manually provisioned legacy schemas can still contain the
-- single-column primary key, so this migration inspects the real catalog and
-- repairs that shape in place. It is idempotent and a no-op when the primary
-- key already covers the partitioning column.
--
-- No runtime SQL rewriting: this migration only ever executes the two
-- fixed operations below (DROP CONSTRAINT / ADD PRIMARY KEY), gated by a
-- catalog check, never SQL built from untrusted input.
DO $$
DECLARE
  fix RECORD;
  tbl regclass;
  pk_conname text;
  pk_has_time_col boolean;
BEGIN
  FOR fix IN
    SELECT * FROM (VALUES
      ('fact_business_service_incidents', 'incident_date'),
      ('fact_business_service_changes', 'change_date')
    ) AS t(table_name, time_column)
  LOOP
    tbl := to_regclass(fix.table_name);

    IF tbl IS NULL THEN
      -- Table does not exist yet (e.g. this migration ran ahead of
      -- 001 in some unexpected ordering). Nothing to fix.
      CONTINUE;
    END IF;

    SELECT c.conname INTO pk_conname
    FROM pg_constraint c
    WHERE c.conrelid = tbl AND c.contype = 'p';

    IF pk_conname IS NULL THEN
      -- No primary key at all -- add the correct composite one.
      EXECUTE format('ALTER TABLE %s ADD PRIMARY KEY (id, %I)', tbl, fix.time_column);
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conname = pk_conname
        AND c.conrelid = tbl
        AND a.attname = fix.time_column
    ) INTO pk_has_time_col;

    IF pk_has_time_col THEN
      -- Already the composite (id, time_column) shape -- no-op.
      CONTINUE;
    END IF;

    -- Legacy single-column PK: id alone is already globally unique, so
    -- (id, time_column) is trivially unique too and this always
    -- succeeds without a data backfill or uniqueness violation.
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, pk_conname);
    EXECUTE format('ALTER TABLE %s ADD PRIMARY KEY (id, %I)', tbl, fix.time_column);
  END LOOP;
END $$;

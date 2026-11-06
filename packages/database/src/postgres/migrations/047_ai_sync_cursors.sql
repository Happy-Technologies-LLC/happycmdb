-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-1442 (AAI S1, design brief §4): one sync cursor per organization and AI source stream.
--   ai_sync_cursors   organization_id + stream (PRIMARY KEY), the source's opaque cursor, as_of (the source time the
--                     cursor covers), last_success_at, last_error_code (a short code, never a message or credential)
--                     and updated_at. stream is one of the brief's five feeds; anything else is a CHECK violation.
-- No row is created here: the sync job (AAI S2+) inserts its cursor on first run and then updates it in place.
-- Grants: SELECT, INSERT, UPDATE (no DELETE or TRUNCATE: a cursor is reset by UPDATE, never removed) to the app
-- logins that exist: cmdb_user (HAP-1422 non-owner login) and cmdb_app (HAP-1562 staging login, per-table grants).
-- As for 046, rollback/045 also un-records 047 so the migrator re-grants cmdb_app on the way back.
--
-- Additive and idempotent; a non-table ai_sync_cursors aborts. The migrator records it in one transaction.
-- Manual rollback: rollback/047_ai_sync_cursors.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hap1442$
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.ai_sync_cursors')) <> 'r' THEN
    RAISE EXCEPTION 'HAP-1442 wrong object: ai_sync_cursors';
  END IF;

  CREATE TABLE IF NOT EXISTS public.ai_sync_cursors (
    organization_id UUID NOT NULL,
    stream VARCHAR(32) NOT NULL
      CONSTRAINT ai_sync_cursors_stream_check
      CHECK (stream IN ('c4_releases', 'c6_receipts', 'c8_cells', 'c8_admissions', 'c9_definitions')),
    cursor TEXT,
    as_of TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error_code VARCHAR(64),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ai_sync_cursors_pkey PRIMARY KEY (organization_id, stream)
  );

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    GRANT SELECT, INSERT, UPDATE ON public.ai_sync_cursors TO cmdb_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.ai_sync_cursors TO cmdb_app;
  END IF;
END
$hap1442$;

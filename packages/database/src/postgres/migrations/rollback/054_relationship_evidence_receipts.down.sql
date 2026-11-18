-- Rollback for 054_relationship_evidence_receipts.sql. MANUAL ONLY; not authorized for any environment without a separate
-- named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- When: AFTER replacing the API image with one older than HAP-2029. A HAP-2029 image fails closed with 503 on every
-- relationship write once the table is gone; an older image never names it.
--
-- Loses data: every receipt. Re-applying 054 creates an empty table, so existing edges render `unsupported` (HAP-2030)
-- until they are asserted again. The relationships, CIs and audit_log rows stay.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 054_relationship_evidence_receipts.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DROP TABLE IF EXISTS public.relationship_evidence_receipts;
DROP FUNCTION IF EXISTS public.relationship_evidence_receipts_append_only();
DELETE FROM cmdb.schema_migrations WHERE migration_name = '054_relationship_evidence_receipts.sql';
COMMIT;

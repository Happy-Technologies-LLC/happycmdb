-- 003_audit_hash_chain.sql
--
-- Make the audit_log trail tamper-evident. Each row carries the previous
-- row's hash for its chain partition (prev_hash) and its own content hash
-- (entry_hash), computed by the shared @happy-technologies/audit kernel.
-- Recomputing the chain detects any insert, delete, reorder, or content
-- edit made after the fact.
--
-- happycmdb's audit_log has no tenant_id column: it is a single
-- append-only log for the whole instance, so all rows share one chain
-- partition (the constant key 'global'; see AuditService.logAudit).
--
-- Columns are nullable so pre-existing rows stay valid; the chain is
-- enforced from the first write after this migration forward. Additive
-- and idempotent: no backfill, no existing column touched.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash VARCHAR(64);

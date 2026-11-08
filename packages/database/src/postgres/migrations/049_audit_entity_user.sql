-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-1368: audit_entity_type gains USER. Each self-service password change attempt (PUT /auth/password, outcome
-- success or wrong_password) appends one hash-chained audit_log row: entity USER, the user id, the client address and
-- the actor's organization; never a password, hash or token.
--
-- Catalog-only and idempotent (ADD VALUE IF NOT EXISTS; 043/046 pattern); skipped where audit_entity_type does not
-- exist. Irreversible: PostgreSQL cannot drop an enum value. Manual rollback: rollback/049_audit_entity_user.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hap1368$
BEGIN
  -- Enum values cannot be used in the transaction that adds them; nothing here writes audit_log.
  IF to_regtype('public.audit_entity_type') IS NOT NULL THEN
    ALTER TYPE public.audit_entity_type ADD VALUE IF NOT EXISTS 'USER';
  END IF;
END
$hap1368$;

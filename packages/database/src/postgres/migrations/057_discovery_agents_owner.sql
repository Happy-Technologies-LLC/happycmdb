-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- Bind each discovery agent to the principal that registered it (follow-up to the #500 review).
--   owner_user_id  the verified user id of the credential that created the row (an API key authenticates as its owning
--                  user, so this is that user's id, not the key's). Written by POST /agents/register only.
--                  Nullable, no default, NO backfill: a row registered before this migration has no owner, and an
--                  `agent`-role caller can neither heartbeat, re-register nor delete it until an operator or admin
--                  re-registers it (which claims it for that operator). Ownership is never inferred from the past.
-- Additive and idempotent; no grant changes (the table-level grants already cover a new column). The migrator records
-- the file in one transaction. A wrong relation kind aborts.
-- Manual rollback: rollback/057_discovery_agents_owner.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $own$
BEGIN
  -- NULL (no such relation) is not <> 'r', so only a wrong existing object aborts; a missing table fails the ALTER.
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.discovery_agents')) <> 'r' THEN
    RAISE EXCEPTION '057 wrong object: discovery_agents';
  END IF;
END
$own$;

ALTER TABLE public.discovery_agents ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(255);

COMMENT ON COLUMN public.discovery_agents.owner_user_id IS
  'Verified user id that registered the agent; NULL = pre-057 row, controllable only by operator/admin callers';

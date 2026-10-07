-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- Standalone additive migration; depends only on 001 discovery_agents.
-- Legacy rows remain NULL and are inaccessible to all API callers.
ALTER TABLE discovery_agents ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE INDEX IF NOT EXISTS idx_discovery_agents_org_heartbeat
  ON discovery_agents (organization_id, last_heartbeat_at DESC);

-- 001 grants PUBLIC access to the base table and two unscoped legacy views.
-- No API reader uses those views; remove their public access rather than
-- leaving a parallel database-reader path to foreign or NULL-org agents.
REVOKE SELECT, INSERT, UPDATE, DELETE ON discovery_agents FROM PUBLIC;
REVOKE SELECT ON active_discovery_agents FROM PUBLIC;
REVOKE SELECT ON agent_network_coverage FROM PUBLIC;

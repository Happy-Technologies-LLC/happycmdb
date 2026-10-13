-- HAP-496: historical AI sessions and patterns have no verified organization.
-- Leave NULL inaccessible; never infer ownership from target, ID or pattern.
-- The migrator wraps this metadata-only change in its transaction.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE ai_discovery_sessions ADD COLUMN organization_id UUID;
ALTER TABLE ai_discovery_patterns ADD COLUMN organization_id UUID;

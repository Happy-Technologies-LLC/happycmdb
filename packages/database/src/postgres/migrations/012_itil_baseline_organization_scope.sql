-- LH-2 / HAP-456: legacy baselines have no trustworthy tenant provenance.
-- Leave them NULL and inaccessible until dedicated platform-admin authority exists;
-- the seeded/default organization and ordinary admin role do not own them.
ALTER TABLE itil_baselines ADD COLUMN IF NOT EXISTS organization_id UUID;

CREATE INDEX IF NOT EXISTS idx_itil_baselines_organization_created
  ON itil_baselines(organization_id, created_at DESC);

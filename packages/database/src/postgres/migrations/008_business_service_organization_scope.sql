-- 008_business_service_organization_scope.sql
--
-- Tenant scoping for business services (S6g). Every dim_business_services
-- row belongs to exactly one organization. The API filters every
-- /api/v1/business-services read and write by the caller token's
-- _organizationId claim (see business-service.controller.ts).
--
-- Existing rows predate multi-tenancy and all belong to the single internal
-- organization, 00000000-0000-0000-0000-000000000000. That is the id HappyHive
-- seeds as its Default Organization (happyhive db/migrations/001_create_organizations.sql),
-- so HappyHive tenants and CMDB tenants share one id space.
--
-- Child tables (business_service_dependencies, ci_business_service_mappings,
-- fact_business_service_incidents, fact_business_service_changes) carry no
-- organization_id: each row hangs off a parent service_id, and every API path
-- reaches them only through an org-filtered parent row.
--
-- No column DEFAULT: an insert that does not name its organization fails on
-- NOT NULL instead of silently landing in the internal org.

ALTER TABLE dim_business_services ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE dim_business_services
   SET organization_id = '00000000-0000-0000-0000-000000000000'
 WHERE organization_id IS NULL;

ALTER TABLE dim_business_services ALTER COLUMN organization_id SET NOT NULL;

-- Serves the org-scoped list (WHERE organization_id = $1 ORDER BY created_at DESC).
-- service_id lookups keep using the primary key, with organization_id as a filter.
CREATE INDEX IF NOT EXISTS idx_dim_business_services_organization
  ON dim_business_services(organization_id, created_at DESC);

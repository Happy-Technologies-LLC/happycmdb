-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-1408 (CO-1 S2, Suite Contracts v2 C1): the internal IT portfolio seed. CO-1 Design Brief v1 section 3 requires
-- at least one real business service in HappyCMDB before a request names it, seeded by a migration, not UI clicks.
--
-- Seeds into the internal organization 00000000-0000-0000-0000-000000000000 (migration 008; HappyHive's Default
-- Organization, so both products share the tenant id):
--   bs-11ab0f28-85c8-4494-b220-e90758c6219a  Access request fulfilment (the first CO-1 service, D12)
--   bs-ea0cc18a-823a-429b-9846-470882fbdfa3  Identity and access management, which the first service depends on, so
--                                            GET /api/v1/business-services/{service_id}/context is not empty.
-- service_id follows C1 (F1): 'bs-' plus a lowercase UUID v4. CIs are not seeded here: a :CI node lives in Neo4j behind
-- the reconciliation journal, which a PostgreSQL migration cannot write.
--
-- Idempotent and fail-closed: an existing row with either id is never overwritten, and the migration aborts unless
-- both ids end up as internal-organization services, so it can never attach a dependency to another tenant's row.
-- Manual rollback: rollback/042_co1_access_request_fulfilment_seed.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

INSERT INTO dim_business_services (
  service_id, name, description, service_classification, tbm_tower, business_criticality, operational_status,
  service_type, owned_by, managed_by, support_group, category, tags, metadata, organization_id
) VALUES
  ('bs-11ab0f28-85c8-4494-b220-e90758c6219a', 'Access request fulfilment',
   'Grants, changes and revokes access to internal systems on approved requests.',
   'end_user', 'end_user', 'high', 'active', 'business', 'Internal IT', 'Internal IT', 'Internal IT Service Desk',
   'access_management', ARRAY['co-1', 'internal-it'],
   '{"seeded_by": "042_co1_access_request_fulfilment_seed"}'::jsonb, '00000000-0000-0000-0000-000000000000'),
  ('bs-ea0cc18a-823a-429b-9846-470882fbdfa3', 'Identity and access management',
   'Directory, authentication and role assignment for internal systems.',
   'security', 'security', 'critical', 'active', 'platform', 'Internal IT', 'Internal IT', 'Internal IT Service Desk',
   'access_management', ARRAY['co-1', 'internal-it'],
   '{"seeded_by": "042_co1_access_request_fulfilment_seed"}'::jsonb, '00000000-0000-0000-0000-000000000000')
ON CONFLICT (service_id) DO NOTHING;

DO $seed$
BEGIN
  IF (SELECT count(*) FROM dim_business_services
      WHERE service_id IN ('bs-11ab0f28-85c8-4494-b220-e90758c6219a', 'bs-ea0cc18a-823a-429b-9846-470882fbdfa3')
        AND organization_id = '00000000-0000-0000-0000-000000000000') <> 2 THEN
    RAISE EXCEPTION '042 seed ids exist outside the internal organization';
  END IF;
END
$seed$;

INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
VALUES ('bs-11ab0f28-85c8-4494-b220-e90758c6219a', 'bs-ea0cc18a-823a-429b-9846-470882fbdfa3', 'platform')
ON CONFLICT (service_id, depends_on_service_id) DO NOTHING;

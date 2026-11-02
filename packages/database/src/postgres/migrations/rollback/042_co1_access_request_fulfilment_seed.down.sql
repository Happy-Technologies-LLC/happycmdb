-- Rollback for 042_co1_access_request_fulfilment_seed.sql. MANUAL ONLY; not authorized for any environment without a
-- separate named instruction. Deletes the two seeded internal-organization services only while they still carry the
-- seed marker (their dependency, CI mappings and facts cascade). Consumers that stored either service_id (HappyHive
-- requests, HIVE decisions) then read 404 for it.
-- Run: psql -v ON_ERROR_STOP=1 -f 042_co1_access_request_fulfilment_seed.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DELETE FROM dim_business_services
WHERE service_id IN ('bs-11ab0f28-85c8-4494-b220-e90758c6219a', 'bs-ea0cc18a-823a-429b-9846-470882fbdfa3')
  AND organization_id = '00000000-0000-0000-0000-000000000000'
  AND metadata @> '{"seeded_by": "042_co1_access_request_fulfilment_seed"}'::jsonb;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '042_co1_access_request_fulfilment_seed.sql';
COMMIT;

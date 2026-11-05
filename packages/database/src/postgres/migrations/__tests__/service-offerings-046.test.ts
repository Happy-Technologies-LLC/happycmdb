// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1424 migration 046 and its manual rollback on PGlite, as the NOSUPERUSER owner role cmdb_user (asserted).
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const host = fork(join(__dirname, '../../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'), [],
  { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(Object.assign(new Error(error), { code }));
  else reply.resolve(rows);
});
function exec(sql: string): Promise<unknown[]> {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op: /^\s*SELECT/i.test(sql) ? 'query' : 'exec', sql, params: [] });
  return promise;
}
const migrations = join(__dirname, '..');
const file = (name: string) => readFileSync(join(migrations, name), 'utf8');
const migrate = (name: string) => exec(`BEGIN;\n${file(name)}\nCOMMIT;`);
const up = () => migrate('046_service_offerings.sql');
const down = () => exec(file('rollback/046_service_offerings.down.sql'));
const schema = file('001_complete_schema.sql');
const T = '6a1d2c3b-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const state = `SELECT to_regclass('public.service_offerings')::text AS t, enum_range(NULL::audit_entity_type)::text AS e,
  (SELECT count(*)::int FROM pg_constraint WHERE conname = 'dim_business_services_service_org_key') AS k`;

beforeAll(async () => {
  const [{ db }] = await exec('SELECT current_database() AS db') as Array<{ db: string }>;
  await exec(`CREATE ROLE cmdb_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_user; GRANT CREATE ON SCHEMA public TO cmdb_user; SET ROLE cmdb_user;
    CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);`);
  expect(await exec('SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user'))
    .toEqual([{ name: 'cmdb_user', rolsuper: false }]);
}, 30000);
afterAll(() => host.kill());

it('creates nothing on a V2/V3 schema without the business-service table or the audit enum', async () => {
  await up();
  expect(await exec(`SELECT to_regclass('public.service_offerings') AS t, to_regtype('public.audit_entity_type') AS e`))
    .toEqual([{ t: null, e: null }]);
}, 30000);

it('is idempotent, rolls back (offerings dropped, enum value kept) and re-applies; a guard-less table aborts', async () => {
  await exec([schema.match(/CREATE TYPE audit_entity_type AS ENUM \([^;]*\);/)![0],
    schema.match(/CREATE TABLE IF NOT EXISTS dim_business_services \([\s\S]*?\n\);/)![0]].join('\n'));
  await migrate('008_business_service_organization_scope.sql');
  await migrate('043_business_service_record_c1.sql');
  await exec(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
    operational_status, organization_id) VALUES ('bs-t', 'T', 'application', 'application', 'low', 'active', '${T}')`);
  const applied = [{ t: 'service_offerings', e: '{CI,RELATIONSHIP,BUSINESS_SERVICE,SERVICE_OFFERING}', k: 1 }];
  await up();
  await exec(`INSERT INTO service_offerings (offering_id, service_id, organization_id, name) VALUES ('so-t', 'bs-t', '${T}', 'Desk')`);
  await up(); // re-run keeps the rows
  expect([await exec(state), await exec('SELECT offering_id, lifecycle, audience, version FROM service_offerings')]).toEqual([
    applied, [{ offering_id: 'so-t', lifecycle: 'planned', audience: 'internal', version: 1 }]]);

  await exec(`INSERT INTO cmdb.schema_migrations VALUES ('046_service_offerings.sql')`);
  await down();
  expect([await exec(state), await exec('SELECT migration_name FROM cmdb.schema_migrations')])
    .toEqual([[{ t: null, e: '{CI,RELATIONSHIP,BUSINESS_SERVICE,SERVICE_OFFERING}', k: 0 }], []]);
  await down(); // idempotent
  await up();
  expect(await exec(state)).toEqual(applied);

  await down();
  await exec('CREATE TABLE service_offerings (offering_id varchar(50) PRIMARY KEY, service_id varchar(50))');
  await expect(up()).rejects.toThrow(/service_offerings exists without the composite tenant guard/);
  await exec('ROLLBACK');
}, 30000);

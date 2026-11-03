// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1423 migration 043 and its manual rollback on PGlite, as the NOSUPERUSER owner role cmdb_user (asserted).
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
const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
const up = () => exec(`BEGIN;\n${readFileSync(join(migrations, '043_business_service_record_c1.sql'), 'utf8')}\nCOMMIT;`);
const down = () => exec(readFileSync(join(migrations, 'rollback/043_business_service_record_c1.down.sql'), 'utf8'));
const SERVICE_TABLE = schema.match(/CREATE TABLE IF NOT EXISTS dim_business_services \([\s\S]*?\n\);/)![0];
const ENTITY_ENUM = schema.match(/CREATE TYPE audit_entity_type AS ENUM \([^;]*\);/)![0];
const enumValues = `SELECT enum_range(NULL::audit_entity_type)::text AS v`;
const columns = `SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull AS not_null,
    pg_get_expr(d.adbin, d.adrelid) AS default_value
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE attrelid = to_regclass('public.dim_business_services') AND NOT attisdropped
    AND attname IN ('lifecycle', 'owner_principal_id', 'owner_group', 'version') ORDER BY attname`;
const records = 'SELECT service_id, operational_status, lifecycle, owner_principal_id, version FROM dim_business_services ORDER BY service_id';
const insert = (id: string, status: string) => `INSERT INTO dim_business_services (service_id, name, service_classification,
  tbm_tower, business_criticality, operational_status) VALUES ('${id}', '${id}', 'application', 'application', 'low', '${status}')`;

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
  expect(await exec(`SELECT to_regclass('public.dim_business_services') AS t, to_regtype('public.audit_entity_type') AS e`))
    .toEqual([{ t: null, e: null }]);
}, 30000);

it('backfills existing rows (live only when active), adds BUSINESS_SERVICE, and a re-run is a no-op', async () => {
  await exec(`${ENTITY_ENUM}\n${SERVICE_TABLE}\n${['active', 'maintenance', 'inactive', 'decommissioned']
    .map(status => insert(`bs-${status}`, status)).join(';\n')}`);
  await up();
  expect(await exec(records)).toEqual([
    { service_id: 'bs-active', operational_status: 'active', lifecycle: 'live', owner_principal_id: null, version: 1 },
    { service_id: 'bs-decommissioned', operational_status: 'decommissioned', lifecycle: 'planned', owner_principal_id: null, version: 1 },
    { service_id: 'bs-inactive', operational_status: 'inactive', lifecycle: 'planned', owner_principal_id: null, version: 1 },
    { service_id: 'bs-maintenance', operational_status: 'maintenance', lifecycle: 'planned', owner_principal_id: null, version: 1 },
  ]);
  expect(await exec(columns)).toEqual([
    { attname: 'lifecycle', type: 'character varying(20)', not_null: true, default_value: "'planned'::character varying" },
    { attname: 'owner_group', type: 'character varying(255)', not_null: false, default_value: null },
    { attname: 'owner_principal_id', type: 'character varying(255)', not_null: false, default_value: null },
    { attname: 'version', type: 'integer', not_null: true, default_value: '1' },
  ]);
  expect(await exec(enumValues)).toEqual([{ v: '{CI,RELATIONSHIP,BUSINESS_SERVICE}' }]);

  // A new row takes the defaults; the CHECKs refuse values outside the record's vocabulary.
  await exec(insert('bs-new', 'active'));
  expect(await exec(`SELECT lifecycle, version FROM dim_business_services WHERE service_id = 'bs-new'`))
    .toEqual([{ lifecycle: 'planned', version: 1 }]);
  for (const bad of [`lifecycle = 'active'`, 'version = 0', `owner_principal_id = '  '`]) {
    await expect(exec(`UPDATE dim_business_services SET ${bad} WHERE service_id = 'bs-new'`)).rejects.toMatchObject({ code: '23514' });
  }

  // Re-run: stored values written after 043 are never re-backfilled.
  await exec(`UPDATE dim_business_services SET lifecycle = 'retired', owner_principal_id = 'idp|alice', version = 5
    WHERE service_id = 'bs-active'`);
  const before = await exec(records);
  await up();
  expect([await exec(records), await exec(enumValues)]).toEqual([before, [{ v: '{CI,RELATIONSHIP,BUSINESS_SERVICE}' }]]);
}, 30000);

it('rolls back with the manual down script (rows kept, enum value kept, migrator row removed) and re-applies', async () => {
  await exec(`INSERT INTO cmdb.schema_migrations VALUES ('043_business_service_record_c1.sql')`);
  await down();
  expect([await exec(columns), await exec('SELECT migration_name FROM cmdb.schema_migrations'),
    await exec('SELECT count(*)::int AS n FROM dim_business_services'), await exec(enumValues)])
    .toEqual([[], [], [{ n: 5 }], [{ v: '{CI,RELATIONSHIP,BUSINESS_SERVICE}' }]]);
  await down(); // idempotent
  await up();
  expect(await exec(`SELECT service_id, lifecycle, version FROM dim_business_services WHERE service_id IN ('bs-active', 'bs-maintenance')
    ORDER BY service_id`)).toEqual([
    { service_id: 'bs-active', lifecycle: 'live', version: 1 }, { service_id: 'bs-maintenance', lifecycle: 'planned', version: 1 },
  ]);
}, 30000);

it('aborts on a conflicting pre-existing column instead of accepting its type', async () => {
  await down();
  await exec('ALTER TABLE dim_business_services ADD COLUMN version text');
  await expect(up()).rejects.toThrow(/conflicting dim_business_services record columns/);
  await exec('ROLLBACK');
  expect(await exec(columns)).toEqual([{ attname: 'version', type: 'text', not_null: false, default_value: null }]);
}, 30000);

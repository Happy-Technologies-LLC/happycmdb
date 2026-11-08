// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1368 migration 049 and its manual rollback on PGlite, as the NOSUPERUSER owner role cmdb_user.
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const host = fork(join(__dirname, '../../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'), [],
  { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(new Error(error));
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
const ENTITY_ENUM = schema.match(/CREATE TYPE audit_entity_type AS ENUM \([^;]*\);/)![0];
const up = () => exec(`BEGIN;\n${readFileSync(join(migrations, '049_audit_entity_user.sql'), 'utf8')}\nCOMMIT;`);
const down = () => exec(readFileSync(join(migrations, 'rollback/049_audit_entity_user.down.sql'), 'utf8'));
const enumValues = 'SELECT enum_range(NULL::audit_entity_type)::text AS v';

beforeAll(async () => {
  const [{ db }] = await exec('SELECT current_database() AS db') as Array<{ db: string }>;
  await exec(`CREATE ROLE cmdb_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_user; GRANT CREATE ON SCHEMA public TO cmdb_user; SET ROLE cmdb_user;
    CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);`);
}, 30000);
afterAll(() => host.kill());

it('creates nothing on a schema without the audit enum', async () => {
  await up();
  expect(await exec(`SELECT to_regtype('public.audit_entity_type') AS e`)).toEqual([{ e: null }]);
}, 30000);

it('adds USER once (a re-run is a no-op); the manual rollback keeps it and removes only the migrator row', async () => {
  await exec(ENTITY_ENUM);
  await up();
  await up();
  expect(await exec(enumValues)).toEqual([{ v: '{CI,RELATIONSHIP,USER}' }]);

  await exec(`INSERT INTO cmdb.schema_migrations VALUES ('049_audit_entity_user.sql')`);
  await down();
  expect([await exec('SELECT migration_name FROM cmdb.schema_migrations'), await exec(enumValues)])
    .toEqual([[], [{ v: '{CI,RELATIONSHIP,USER}' }]]);
}, 30000);

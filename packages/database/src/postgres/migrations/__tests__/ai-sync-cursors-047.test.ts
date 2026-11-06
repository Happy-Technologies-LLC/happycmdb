// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1442 migration 047 (ai_sync_cursors) and its manual rollback on PGlite, run by the NOSUPERUSER owner role cmdb_user.
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
const file = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');
const up = () => exec(`BEGIN;\n${file('047_ai_sync_cursors.sql')}\nCOMMIT;`);
const T = '6a1d2c3b-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const privileges = `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(p =>
  `has_table_privilege('cmdb_app', 'public.ai_sync_cursors', '${p}') AS "${p}"`).join(', ')}`;

beforeAll(async () => {
  const [{ db }] = await exec('SELECT current_database() AS db') as Array<{ db: string }>;
  await exec(`CREATE ROLE cmdb_app LOGIN NOSUPERUSER; CREATE ROLE cmdb_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_user; GRANT CREATE ON SCHEMA public TO cmdb_user; SET ROLE cmdb_user;
    CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);`);
  expect(await exec('SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user'))
    .toEqual([{ name: 'cmdb_user', rolsuper: false }]);
}, 30000);
afterAll(() => host.kill());

it('is additive and idempotent, gives the app login SELECT, INSERT, UPDATE only, refuses an unknown stream, and rolls back', async () => {
  await up();
  await exec(`INSERT INTO ai_sync_cursors (organization_id, stream, cursor) VALUES ('${T}', 'c4_releases', 'c-1')`);
  await up(); // re-run keeps the row
  expect([await exec('SELECT organization_id, stream, cursor, last_error_code FROM ai_sync_cursors'), await exec(privileges)]).toEqual([
    [{ organization_id: T, stream: 'c4_releases', cursor: 'c-1', last_error_code: null }],
    [{ SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false }]]);
  await expect(exec(`INSERT INTO ai_sync_cursors (organization_id, stream) VALUES ('${T}', 'c4_releases')`)).rejects.toThrow(/duplicate key/);
  await expect(exec(`INSERT INTO ai_sync_cursors (organization_id, stream) VALUES ('${T}', 'other')`)).rejects.toThrow(/check constraint/);

  await exec(`INSERT INTO cmdb.schema_migrations VALUES ('047_ai_sync_cursors.sql')`);
  await exec(file('rollback/047_ai_sync_cursors.down.sql'));
  expect([await exec(`SELECT to_regclass('public.ai_sync_cursors') AS t`), await exec('SELECT migration_name FROM cmdb.schema_migrations')])
    .toEqual([[{ t: null }], []]);
  await exec(file('rollback/047_ai_sync_cursors.down.sql')); // idempotent
  await up();
  expect(await exec(privileges)).toEqual([{ SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false }]);
}, 30000);

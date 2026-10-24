// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-922 migration 040 on PGlite; the integration suite applies it to Timescale/PG15.
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
const ddl = readFileSync(join(__dirname, '../040_itil_change_implementation_fields.sql'), 'utf8');
const columns = `SELECT attname, format_type(atttypid, atttypmod) AS type FROM pg_attribute
  WHERE attrelid = to_regclass('public.itil_changes') AND attname IN ('implemented_by', 'actual_duration')
  ORDER BY attname`;
afterAll(() => host.kill());

it('creates nothing on a V2/V3 schema without ITIL tables', async () => {
  await exec(ddl);
  expect(await exec(`SELECT to_regclass('public.itil_changes') AS change`)).toEqual([{ change: null }]);
}, 30000);

it('adds nullable implementation fields to V1 changes, keeps rows, and reruns as a no-op', async () => {
  await exec(`CREATE TABLE itil_changes(id uuid PRIMARY KEY, change_number text UNIQUE);
    INSERT INTO itil_changes VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'CHG-legacy');`);
  await exec(ddl);
  expect(await exec(columns)).toEqual([
    { attname: 'actual_duration', type: 'integer' }, { attname: 'implemented_by', type: 'character varying(255)' },
  ]);
  await exec(`UPDATE itil_changes SET implemented_by = 'alice', actual_duration = 45`);
  await exec(ddl);
  expect(await exec('SELECT change_number, implemented_by, actual_duration FROM itil_changes')).toEqual([
    { change_number: 'CHG-legacy', implemented_by: 'alice', actual_duration: 45 },
  ]);
  await expect(exec('UPDATE itil_changes SET actual_duration = 0')).rejects.toMatchObject({ code: '23514' });
  await exec('DROP TABLE itil_changes');
}, 30000);

it('aborts on a conflicting pre-existing column instead of accepting its type', async () => {
  await exec('CREATE TABLE itil_changes(id uuid PRIMARY KEY, actual_duration text)');
  await expect(exec(ddl)).rejects.toThrow(/conflicting itil_changes implementation columns/);
  expect(await exec(columns)).toEqual([{ attname: 'actual_duration', type: 'text' }]);
}, 30000);

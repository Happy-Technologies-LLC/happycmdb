// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// PGlite exercises the real SQL without Docker. CI's Timescale/PG15 acceptance
// remains separate; the migrator ledger is not needed for this standalone file.
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
function exec(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op: /^\s*SELECT/i.test(sql) ? 'query' : 'exec', sql, params });
  return promise;
}
const ddl = readFileSync(join(__dirname, '../035_itil_record_ownership.sql'), 'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
afterAll(() => host.kill());

it('records V2/V3 missing tables as absent without creating partial ITIL objects', async () => {
  await exec(ddl);
  expect(await exec(`SELECT to_regclass('public.itil_incidents') AS incident,
    to_regclass('public.itil_changes') AS change, to_regclass('public.itil_baselines') AS baseline`)).toEqual([
    { incident: null, change: null, baseline: null },
  ]);
}, 30000);

it('refuses a partial V1 schema without installing incident or change tables', async () => {
  await exec('CREATE TABLE itil_baselines(id uuid PRIMARY KEY)');
  await expect(exec(ddl)).rejects.toThrow(/incomplete ITIL schema/);
  expect(await exec(`SELECT to_regclass('public.itil_incidents') AS incident,
    to_regclass('public.itil_changes') AS change`)).toEqual([{ incident: null, change: null }]);
  await exec('DROP TABLE itil_baselines');
}, 30000);

it('adds V1 ownership guards and org-local names without attributing legacy rows', async () => {
  await exec(`CREATE TABLE itil_baselines(id uuid PRIMARY KEY, organization_id uuid,
    name text NOT NULL, created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX idx_itil_baselines_org_name ON itil_baselines(organization_id, name)
      WHERE organization_id IS NOT NULL;
    CREATE TABLE itil_incidents(id uuid PRIMARY KEY, incident_number text UNIQUE,
      reported_at timestamptz DEFAULT now(), affected_ci_id text);
    CREATE TABLE itil_changes(id uuid PRIMARY KEY, change_number text UNIQUE,
      created_at timestamptz DEFAULT now());
    INSERT INTO itil_baselines(id, name) VALUES ('${id(1)}', 'legacy');
    INSERT INTO itil_incidents(id, incident_number) VALUES ('${id(2)}', 'INC-legacy');
    INSERT INTO itil_changes(id, change_number) VALUES ('${id(3)}', 'CHG-legacy');`);
  await exec(ddl);
  expect(await exec(`SELECT organization_id FROM itil_incidents WHERE id = '${id(2)}'`))
    .toEqual([{ organization_id: null }]);
  await expect(exec(`INSERT INTO itil_incidents(id, incident_number) VALUES ('${id(4)}', 'INC-no-org')`))
    .rejects.toMatchObject({ code: '23514' });
  await expect(exec(`UPDATE itil_changes SET change_number = 'CHG-new' WHERE id = '${id(3)}'`))
    .rejects.toMatchObject({ code: '23514' });
  await expect(exec(`INSERT INTO itil_changes(id, change_number)
    VALUES ('${id(11)}', 'CHG-no-org')`)).rejects.toMatchObject({ code: '23514' });
  await expect(exec(`INSERT INTO itil_baselines(id, name)
    VALUES ('${id(12)}', 'baseline-no-org')`)).rejects.toMatchObject({ code: '23514' });
  await exec(`INSERT INTO itil_baselines(id, name, organization_id) VALUES
    ('${id(5)}', 'shared', '${A}'), ('${id(6)}', 'shared', '${B}'),
    ('${id(7)}', 'legacy', '${A}')`);
  await expect(exec(`INSERT INTO itil_baselines(id, name, organization_id)
    VALUES ('${id(8)}', 'shared', '${A}')`)).rejects.toMatchObject({ code: '23505' });
  await exec(`INSERT INTO itil_incidents(id, incident_number, organization_id)
    VALUES ('${id(9)}', 'INC-owned', '${A}')`);
  await expect(exec(`INSERT INTO itil_incidents(id, incident_number, organization_id)
    VALUES ('${id(10)}', 'INC-owned', '${B}')`)).rejects.toMatchObject({ code: '23505' });
}, 30000);

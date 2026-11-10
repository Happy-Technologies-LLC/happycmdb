// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-503: the manual rollback/012 and rollback/013 scripts, run over the real
 * 001 itil_baselines DDL and the real 012/013/035 files in in-memory PostgreSQL.
 * Tests run in order and share one database: each leaves it in the state the next
 * expects (documented per test).
 */
import { fork } from 'child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(Object.assign(new Error(error), { code }));
  else reply.resolve(rows);
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise;
}
const exec = (sql: string) => send('exec', sql);
const rows = <T>(sql: string, params: unknown[] = []) => send('query', sql, params) as Promise<T[]>;

// The migrator calls query() (no params: simple protocol, several statements allowed)
// and transaction(); pglite has one session so the transaction is BEGIN/COMMIT on it.
const migratorClient = {
  query: async (sql: string, params?: unknown[]) =>
    ({ rows: await send(params?.length ? 'query' : 'exec', sql, params ?? []) }),
  transaction: async (work: (client: unknown) => Promise<unknown>) => {
    await exec('BEGIN');
    try {
      const result = await work(migratorClient);
      await exec('COMMIT');
      return result;
    } catch (error) {
      await exec('ROLLBACK');
      throw error;
    }
  },
};

import { runMigrations } from '../../../../../database/src/postgres/migrator';
import type { PostgresClient } from '../../../../../database/src/postgres/client';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const UP_012 = '012_itil_baseline_organization_scope.sql';
const UP_013 = '013_itil_baseline_org_name_unique.sql';
const DOWN_012 = readFileSync(join(MIGRATIONS, 'rollback/012_itil_baseline_organization_scope.down.sql'), 'utf8');
const DOWN_013 = readFileSync(join(MIGRATIONS, 'rollback/013_itil_baseline_org_name_unique.down.sql'), 'utf8');
const UP_035 = readFileSync(join(MIGRATIONS, '035_itil_record_ownership.sql'), 'utf8');
const DOWN_035 = readFileSync(join(MIGRATIONS, 'rollback/035_itil_record_ownership.down.sql'), 'utf8');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const insert = (n: number, name: string, org: string | null) => exec(
  `INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by, organization_id)
   VALUES ('${id(n)}', '${name}', 'configuration', '{}', 'test', ${org ? `'${org}'` : 'NULL'})`);

/** The scratch dir the migrator reads: only 012 and 013, so the ledger holds exactly those two. */
const scratch = mkdtempSync(join(tmpdir(), 'itil-baseline-rollback-'));
for (const file of [UP_012, UP_013]) copyFileSync(join(MIGRATIONS, file), join(scratch, file));
const migrate = () => runMigrations(migratorClient as unknown as PostgresClient, scratch);

const schema = async () => ({
  columns: await rows<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'itil_baselines' ORDER BY ordinal_position`),
  indexes: await rows<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'itil_baselines' ORDER BY indexname`),
});
const ledger = async () => (await rows<{ migration_name: string }>(
  `SELECT migration_name FROM cmdb.schema_migrations ORDER BY migration_name`)).map(row => row.migration_name);

/**
 * The script must refuse and never reach its COMMIT: the transaction is left open and aborted
 * (25P02 on the next statement, as psql ON_ERROR_STOP would end the session), and the rollback
 * must leave schema and ledger exactly as before.
 */
async function expectRefusal(down: string, message: RegExp): Promise<Error> {
  const before = { schema: await schema(), ledger: await ledger() };
  const refusal = await exec(down).then(() => undefined, (error: Error) => error);
  expect(refusal?.message).toMatch(message);
  await expect(exec('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
  await exec('ROLLBACK');
  expect({ schema: await schema(), ledger: await ledger() }).toEqual(before);
  return refusal!;
}

let pre012: Awaited<ReturnType<typeof schema>>;
let afterForward: Awaited<ReturnType<typeof schema>>;

beforeAll(async () => {
  const original = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const table = original.match(/CREATE TABLE IF NOT EXISTS itil_baselines \([\s\S]*?\n\);/);
  const indexes = original.match(/CREATE (?:UNIQUE )?INDEX idx_itil_baselines_\w+ ON itil_baselines[^;]*;/g);
  if (!table || !indexes) throw new Error('001 itil_baselines schema missing');
  await exec(`${table[0]}\n${indexes.join('\n')}`);
  pre012 = await schema();
  await migrate();
  afterForward = await schema();
});
afterAll(() => {
  host.kill();
  rmSync(scratch, { recursive: true, force: true });
});

it('pre-012 schema has the global unique name index and no organization_id; 012 and 013 change both', () => {
  expect(pre012.columns.map(c => c.column_name)).not.toContain('organization_id');
  expect(pre012.indexes.map(i => i.indexname)).toContain('idx_itil_baselines_unique_name');
  expect(afterForward.columns.map(c => c.column_name)).toContain('organization_id');
  expect(afterForward.indexes.map(i => i.indexname)).not.toContain('idx_itil_baselines_unique_name');
  expect(afterForward.indexes.map(i => i.indexname)).toEqual(expect.arrayContaining([
    'idx_itil_baselines_org_name', 'idx_itil_baselines_organization_created',
  ]));
});

it('(c) both downs refuse while 035 objects exist, then the 035 down unblocks them', async () => {
  await exec(`CREATE TABLE itil_incidents(id uuid PRIMARY KEY, incident_number text UNIQUE,
      reported_at timestamptz DEFAULT now(), affected_ci_id text);
    CREATE TABLE itil_changes(id uuid PRIMARY KEY, change_number text UNIQUE, created_at timestamptz DEFAULT now());`);
  await exec(`BEGIN;\n${UP_035}\nCOMMIT;`);
  expect((await schema()).indexes.map(i => i.indexname)).toContain('idx_itil_baselines_legacy_name');

  await expectRefusal(DOWN_013, /035 objects still exist.*rollback\/035/);
  await expectRefusal(DOWN_012, /035 objects still exist.*rollback\/035/);

  // Only the constraint remains: still refused (each 035 object is checked on its own).
  await exec('DROP INDEX idx_itil_baselines_legacy_name');
  await expectRefusal(DOWN_013, /035 objects still exist/);
  await expectRefusal(DOWN_012, /035 objects still exist/);
  await exec('CREATE UNIQUE INDEX idx_itil_baselines_legacy_name ON itil_baselines(name) WHERE organization_id IS NULL');

  // Only the index remains: still refused. Without this, a down that checked only the
  // constraint would pass here and DROP COLUMN would silently drop the 035 index.
  await exec('ALTER TABLE itil_baselines DROP CONSTRAINT itil_baselines_organization_write_guard');
  await expectRefusal(DOWN_013, /035 objects still exist.*rollback\/035/);
  await expectRefusal(DOWN_012, /035 objects still exist.*rollback\/035/);
  await exec('ALTER TABLE itil_baselines ADD CONSTRAINT itil_baselines_organization_write_guard CHECK (organization_id IS NOT NULL) NOT VALID');

  await exec(DOWN_035); // no owned ITIL rows yet
  const names = (await schema()).indexes.map(i => i.indexname);
  expect(names).not.toContain('idx_itil_baselines_legacy_name');
  expect(await rows(`SELECT 1 FROM pg_constraint WHERE conname = 'itil_baselines_organization_write_guard'`)).toEqual([]);
  expect(await schema()).toEqual(afterForward);
}, 30000);

it('(c) the 012 down refuses while the 013 org-name index exists', async () => {
  const refusal = await expectRefusal(DOWN_012, /idx_itil_baselines_org_name \(013\) still exists.*rollback\/013/);
  expect(refusal.message).not.toMatch(/035/);
  expect(await ledger()).toEqual([UP_012, UP_013]);
});

it('(b) the 013 down refuses duplicate names across organizations or NULL owners and reports only a count', async () => {
  await insert(1, 'secret-shared-name', A);
  await insert(2, 'unique-name', B);

  await insert(3, 'secret-shared-name', B); // two organizations share a name
  const one = await expectRefusal(DOWN_013, /^013 down refused: 1 baseline name\(s\)/);
  expect(one.message).toMatch(/Resolve the duplicates by hand/);

  await insert(4, 'secret-legacy-name', null); // a NULL-owner legacy row shares a name with an owned row
  await insert(5, 'secret-legacy-name', A);
  const two = await expectRefusal(DOWN_013, /^013 down refused: 2 baseline name\(s\)/);
  for (const refusal of [one, two]) {
    expect(refusal.message).not.toContain('secret-');
    expect(refusal.message).not.toContain(A);
    expect(refusal.message).not.toContain(B);
  }
  // Nothing was deduplicated or deleted.
  expect((await rows<{ n: string }>('SELECT count(*) AS n FROM itil_baselines'))[0]?.n).toBe(5);
  expect((await schema()).indexes.map(i => i.indexname)).not.toContain('idx_itil_baselines_unique_name');
}, 30000);

it('(a) after the operator resolves the duplicates, 013 down then 012 down restore the pre-012 schema', async () => {
  await exec(`DELETE FROM itil_baselines WHERE id IN ('${id(3)}', '${id(4)}')`);

  await exec(DOWN_013);
  const afterDown013 = await schema();
  expect(afterDown013.indexes.map(i => i.indexname)).toContain('idx_itil_baselines_unique_name');
  expect(afterDown013.indexes.map(i => i.indexname)).not.toContain('idx_itil_baselines_org_name');
  expect(afterDown013.columns.map(c => c.column_name)).toContain('organization_id'); // 012 still applied
  expect(await ledger()).toEqual([UP_012]);
  // The global uniqueness is enforced again, across organizations.
  await expect(insert(6, 'unique-name', A)).rejects.toMatchObject({ code: '23505' });

  await exec(DOWN_012);
  expect(await schema()).toEqual(pre012);
  expect(await ledger()).toEqual([]);
  // Surviving rows keep their data; only the org assignment is gone.
  expect((await rows<{ n: string }>('SELECT count(*) AS n FROM itil_baselines'))[0]?.n).toBe(3);
}, 30000);

it('(d) the migrator re-applies 012 then 013 after the downs', async () => {
  await migrate();
  expect(await ledger()).toEqual([UP_012, UP_013]);
  expect(await schema()).toEqual(afterForward);
  // Re-applied over surviving rows: every baseline is back with a NULL (unowned) organization.
  expect(await rows(`SELECT DISTINCT organization_id FROM itil_baselines`)).toEqual([{ organization_id: null }]);
  // The per-organization name rule is live again.
  await insert(7, 'unique-name', A);
  await insert(8, 'unique-name', B);
  await expect(insert(9, 'unique-name', A)).rejects.toMatchObject({ code: '23505' });
}, 30000);

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1925 (BW7) migration 056 (estate_kpi_snapshots) and its manual rollback on PGlite, run by the NOSUPERUSER table owner
// cmdb_owner with the app logins cmdb_user and cmdb_app (NOBYPASSRLS, so the row level security policy applies to them as in
// production). Tests of this table use per-run organization ids and never TRUNCATE it: the trigger refuses that for the owner too.
import { fork } from 'child_process';
import { randomUUID } from 'crypto';
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
function exec(sql: string): Promise<any[]> {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op: /^\s*SELECT/i.test(sql) ? 'query' : 'exec', sql, params: [] });
  return promise as Promise<any[]>;
}
const file = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');
const up = () => exec(`BEGIN;\n${file('056_estate_kpi_snapshots.sql')}\nCOMMIT;`);
const down = () => exec(file('rollback/056_estate_kpi_snapshots.down.sql'));
const TABLE = 'public.estate_kpi_snapshots';
const orgA = randomUUID();
const orgB = randomUUID();

const insert = (org: string, date: string, metric: string, value: string | number) =>
  `INSERT INTO ${TABLE} (organization_id, snapshot_date, metric, value) VALUES ('${org}', '${date}', '${metric}', ${value})`;
const privileges = (role: string) => `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(p =>
  `has_table_privilege('${role}', '${TABLE}', '${p}') AS "${p}"`).join(', ')}`;
/** Runs `work` with the session setting that the policy keys on (the API sets it transaction-locally), then clears it. */
const inOrg = async <T>(org: string, work: () => Promise<T>): Promise<T> => {
  await exec(`SELECT set_config('cmdb.organization_id', '${org}', false)`);
  try { return await work(); } finally { await exec(`SELECT set_config('cmdb.organization_id', '', false)`); }
};
const asRole = async <T>(role: string, work: () => Promise<T>): Promise<T> => {
  await exec(`SET ROLE ${role}`);
  try { return await work(); } finally { await exec('SET ROLE cmdb_owner'); }
};
const countFor = (org: string) => `SELECT count(*)::int AS n FROM ${TABLE} WHERE organization_id = '${org}'`;

beforeAll(async () => {
  const [{ db }] = await exec('SELECT current_database() AS db');
  await exec(`CREATE ROLE cmdb_app LOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE cmdb_user LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE cmdb_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_owner; GRANT CREATE ON SCHEMA public TO cmdb_owner; SET ROLE cmdb_owner;
    CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);`);
  expect(await exec('SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user'))
    .toEqual([{ name: 'cmdb_owner', rolsuper: false }]);
}, 30000);
afterAll(() => host.kill());

it('applies, is idempotent, keeps the first value of a day and refuses each invalid value', async () => {
  await up();
  await up();
  await inOrg(orgA, async () => {
    await exec(insert(orgA, '2026-11-01', 'health_score', 87.5));
    await expect(exec(insert(orgA, '2026-11-01', 'health_score', 12))).rejects.toThrow(/estate_kpi_snapshots_pkey/);
    await exec(`${insert(orgA, '2026-11-01', 'health_score', 12)} ON CONFLICT (organization_id, snapshot_date, metric) DO NOTHING`);
    expect(await exec(`SELECT value::float8 AS value FROM ${TABLE} WHERE organization_id = '${orgA}'`)).toEqual([{ value: 87.5 }]);
    await exec(insert(orgA, '2026-11-01', 'total_cis', 0)); // zero is a real value
    await exec(insert(orgA, '2026-11-02', 'health_score', 90)); // another day and another metric are distinct rows
    const refused: Array<[string, string, string | number]> = [
      ['estate_kpi_snapshots_metric', 'open_ci_count', 1],
      ['estate_kpi_snapshots_metric', 'HEALTH_SCORE', 1],
      ['estate_kpi_snapshots_value', 'open_drift_count', -1],
      ['estate_kpi_snapshots_value', 'open_drift_count', "'NaN'"],
      ['value', 'open_drift_count', 'NULL'],
    ];
    for (const [constraint, metric, value] of refused) {
      await expect(exec(insert(orgA, '2026-11-03', metric, value))).rejects.toThrow(new RegExp(constraint));
    }
    await expect(exec(`INSERT INTO ${TABLE} (organization_id, snapshot_date, metric, value) VALUES ('${orgA}', NULL, 'total_cis', 1)`))
      .rejects.toThrow(/snapshot_date/);
    expect(await exec(countFor(orgA))).toEqual([{ n: 3 }]);
  });
}, 30000);

it('gives both app logins SELECT and INSERT only; an UPDATE, DELETE or TRUNCATE as a login is a permission error', async () => {
  for (const role of ['cmdb_user', 'cmdb_app']) {
    expect(await exec(privileges(role))).toEqual([{ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false }]);
    await asRole(role, () => inOrg(orgA, async () => {
      await exec(insert(orgA, `2026-12-${role === 'cmdb_user' ? '01' : '02'}`, 'total_cis', 5));
      for (const statement of [`UPDATE ${TABLE} SET value = 1`, `DELETE FROM ${TABLE}`, `TRUNCATE ${TABLE}`]) {
        await expect(exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
    }));
  }
  expect(await exec(`SELECT has_table_privilege('public', '${TABLE}', 'SELECT') AS via_public`)).toEqual([{ via_public: false }]);
}, 30000);

it('refuses UPDATE, DELETE and TRUNCATE for the table owner too (55000) and keeps every row', async () => {
  await inOrg(orgA, async () => {
    const before = await exec(countFor(orgA));
    for (const statement of [`UPDATE ${TABLE} SET value = 1`, `DELETE FROM ${TABLE}`, `TRUNCATE ${TABLE}`]) {
      await expect(exec(statement)).rejects.toMatchObject({ code: '55000' });
    }
    expect(await exec(countFor(orgA))).toEqual(before);
  });
}, 30000);

it('confines each organization to its own rows for a NOBYPASSRLS login, and fails closed without the setting', async () => {
  expect(await exec(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${TABLE}'::regclass`))
    .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  await asRole('cmdb_app', async () => {
    await inOrg(orgB, async () => { await exec(insert(orgB, '2026-11-01', 'health_score', 55)); });
    // Org A's transaction, with the organization predicate REMOVED, still cannot see org B's row.
    await inOrg(orgA, async () => {
      expect(await exec(`SELECT DISTINCT organization_id FROM ${TABLE}`)).toEqual([{ organization_id: orgA }]);
      // And cannot write one for org B.
      await expect(exec(insert(orgB, '2026-11-09', 'health_score', 1))).rejects.toMatchObject({ code: '42501' });
    });
    await inOrg(orgB, async () => {
      expect(await exec(`SELECT value::float8 AS value FROM ${TABLE}`)).toEqual([{ value: 55 }]);
    });
    // An empty setting and an unrelated organization see nothing.
    expect(await exec(`SELECT count(*)::int AS n FROM ${TABLE}`)).toEqual([{ n: 0 }]);
    await inOrg(randomUUID(), async () => { expect(await exec(`SELECT count(*)::int AS n FROM ${TABLE}`)).toEqual([{ n: 0 }]); });
    // An INSERT without the setting is refused by WITH CHECK, not silently accepted.
    await expect(exec(insert(orgA, '2026-11-10', 'health_score', 1))).rejects.toMatchObject({ code: '42501' });
  });
  // FORCE: the owner is confined as well.
  expect(await exec(`SELECT count(*)::int AS n FROM ${TABLE}`)).toEqual([{ n: 0 }]);
}, 30000);

it('refuses the rollback while the table holds a row, intact, and drops cleanly when empty', async () => {
  await exec(`INSERT INTO cmdb.schema_migrations VALUES ('056_estate_kpi_snapshots.sql'), ('055_other.sql')`);
  await expect(down()).rejects.toThrow(/056 rollback refused/);
  await exec('ROLLBACK');
  // Refused: the table, its rows, the ledger and the RLS flags are all untouched (the ALTERs rolled back with it).
  expect(await exec(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${TABLE}'::regclass`))
    .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  expect((await inOrg(orgA, () => exec(countFor(orgA))))[0].n).toBeGreaterThan(0);
  expect(await exec('SELECT count(*)::int AS n FROM cmdb.schema_migrations')).toEqual([{ n: 2 }]);

  // Empty (a freshly created table): drops table and function and un-records only 056.
  await exec(`DROP TABLE ${TABLE}`);
  await up();
  await down();
  expect([
    await exec(`SELECT to_regclass('${TABLE}') AS t`),
    await exec(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'estate_kpi_snapshots_append_only'`),
    await exec('SELECT migration_name FROM cmdb.schema_migrations')]).toEqual([
    [{ t: null }], [{ n: 0 }], [{ migration_name: '055_other.sql' }]]);
  await down(); // idempotent
  await up();
  expect(await exec(privileges('cmdb_app'))).toEqual([{ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false }]);
}, 30000);

it('aborts when the name is taken by a non-table', async () => {
  await down();
  await exec(`CREATE VIEW ${TABLE} AS SELECT 1 AS x`);
  await expect(up()).rejects.toThrow(/HAP-1925 wrong object: estate_kpi_snapshots/);
  await exec('ROLLBACK');
  await exec(`DROP VIEW ${TABLE}`);
}, 30000);

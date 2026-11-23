// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-2029 migration 054 (relationship_evidence_receipts) and its manual rollback on PGlite, run by the NOSUPERUSER table
// owner cmdb_owner with the app logins cmdb_user and cmdb_app. Tests of this table use per-run organization ids and never
// TRUNCATE it: the trigger refuses that for the owner too.
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
function exec(sql: string): Promise<unknown[]> {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op: /^\s*SELECT/i.test(sql) ? 'query' : 'exec', sql, params: [] });
  return promise;
}
const file = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');
const up = () => exec(`BEGIN;\n${file('054_relationship_evidence_receipts.sql')}\nCOMMIT;`);
const down = () => exec(file('rollback/054_relationship_evidence_receipts.down.sql'));
const TABLE = 'public.relationship_evidence_receipts';
const org = randomUUID();
const incarnation = randomUUID();

/** A valid row; `override` replaces columns (a value of NULL is written as SQL NULL). */
function insert(override: Record<string, string | null> = {}) {
  const row: Record<string, string | null> = {
    organization_id: org, from_ci_id: 'ci-a', to_ci_id: 'ci-b', from_incarnation_id: incarnation, to_incarnation_id: incarnation,
    relationship_type: 'DEPENDS_ON', evidence_class: 'declared', polarity: 'supports', source_name: 'api', method: 'api',
    observed_at: new Date().toISOString(), observer: 'actor-a', observer_type: 'user', correlation_id: randomUUID(), ...override };
  const columns = Object.keys(row);
  return `INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${columns.map(c => (row[c] === null ? 'NULL' : `'${row[c]}'`)).join(', ')})`;
}
const privileges = (role: string) => `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(p =>
  `has_table_privilege('${role}', '${TABLE}', '${p}') AS "${p}"`).join(', ')}`;
const asRole = async <T>(role: string, work: () => Promise<T>): Promise<T> => {
  await exec(`SET ROLE ${role}`);
  try { return await work(); } finally { await exec('SET ROLE cmdb_owner'); }
};

beforeAll(async () => {
  const [{ db }] = await exec('SELECT current_database() AS db') as Array<{ db: string }>;
  await exec(`CREATE ROLE cmdb_app LOGIN NOSUPERUSER; CREATE ROLE cmdb_user LOGIN NOSUPERUSER;
    CREATE ROLE cmdb_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_owner; GRANT CREATE ON SCHEMA public TO cmdb_owner; SET ROLE cmdb_owner;
    CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);`);
  expect(await exec('SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user'))
    .toEqual([{ name: 'cmdb_owner', rolsuper: false }]);
}, 30000);
afterAll(() => host.kill());

it('applies, is idempotent, and refuses each invalid value with its own constraint', async () => {
  await up();
  await up();
  await exec(insert());
  const refused: Array<[string, Record<string, string | null>]> = [
    ['relationship_evidence_receipts_class', { evidence_class: 'guessed' }],
    ['relationship_evidence_receipts_polarity', { polarity: 'neutral' }],
    ['relationship_evidence_receipts_type_token', { relationship_type: 'depends_on' }],
    ['relationship_evidence_receipts_type_token', { relationship_type: 'DEPENDS-ON' }],
    ['relationship_evidence_receipts_source', { source_name: '  ' }],
    ['relationship_evidence_receipts_source', { source_id: ' ' }],
    ['relationship_evidence_receipts_source', { source_version: '' }],
    ['relationship_evidence_receipts_method_token', { method: 'Free Text' }],
    ['relationship_evidence_receipts_method_token', { rationale_code: 'because we said so' }],
    ['relationship_evidence_receipts_observer', { observer: ' ' }],
    ['relationship_evidence_receipts_observer', { observer_type: 'robot' }],
    ['organization_id', { organization_id: null }],
    ['from_incarnation_id', { from_incarnation_id: null }],
    ['to_incarnation_id', { to_incarnation_id: null }],
    ['observed_at', { observed_at: null }],
  ];
  for (const [constraint, override] of refused) {
    await expect(exec(insert(override))).rejects.toThrow(new RegExp(constraint));
  }
  const key = randomUUID();
  await exec(insert({ correlation_id: key }));
  await expect(exec(insert({ correlation_id: key }))).rejects.toThrow(/relationship_evidence_receipts_correlation_key/);
  await exec(insert({ correlation_id: key, to_ci_id: 'ci-c' })); // another edge of the same write is a distinct row
  await exec(insert({ source_id: 'import-1', source_version: '1.2', rationale_code: 'manifest_link', evidence_class: 'runtime_observed',
    polarity: 'contradicts' }));
  expect(await exec(`SELECT count(*)::int AS n FROM ${TABLE} WHERE organization_id = '${org}'`)).toEqual([{ n: 4 }]);
}, 30000);

it('gives both app logins SELECT and INSERT only; an UPDATE, DELETE or TRUNCATE as a login is a permission error', async () => {
  for (const role of ['cmdb_user', 'cmdb_app']) {
    expect(await exec(privileges(role))).toEqual([{ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false }]);
    await asRole(role, async () => {
      await exec(insert());
      expect(await exec(`SELECT count(*)::int AS n FROM ${TABLE} WHERE organization_id = '${org}'`)).toEqual([{ n: expect.any(Number) }]);
      for (const statement of [`UPDATE ${TABLE} SET observer = 'x'`, `DELETE FROM ${TABLE}`, `TRUNCATE ${TABLE}`]) {
        await expect(exec(statement)).rejects.toMatchObject({ code: '42501' });
      }
    });
  }
  expect(await exec(`SELECT has_table_privilege('public', '${TABLE}', 'SELECT') AS via_public`)).toEqual([{ via_public: false }]);
}, 30000);

it('refuses UPDATE, DELETE and TRUNCATE for the table owner too (55000) and keeps every row', async () => {
  const before = await exec(`SELECT count(*)::int AS n FROM ${TABLE}`);
  for (const statement of [`UPDATE ${TABLE} SET observer = 'x'`, `DELETE FROM ${TABLE}`, `TRUNCATE ${TABLE}`]) {
    await expect(exec(statement)).rejects.toMatchObject({ code: '55000' });
  }
  await exec(insert());
  expect(await exec(`SELECT count(*)::int AS n FROM ${TABLE}`)).toEqual([{ n: (before[0] as { n: number }).n + 1 }]);
}, 30000);

it('rolls back (table, function, ledger row), is idempotent, and re-applying works', async () => {
  await exec(`INSERT INTO cmdb.schema_migrations VALUES ('054_relationship_evidence_receipts.sql'), ('053_other.sql')`);
  await down();
  expect([
    await exec(`SELECT to_regclass('${TABLE}') AS t`),
    await exec(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'relationship_evidence_receipts_append_only'`),
    await exec('SELECT migration_name FROM cmdb.schema_migrations')]).toEqual([
    [{ t: null }], [{ n: 0 }], [{ migration_name: '053_other.sql' }]]);
  await down();
  await up();
  expect(await exec(`SELECT count(*)::int AS n FROM ${TABLE}`)).toEqual([{ n: 0 }]);
  expect(await exec(privileges('cmdb_app'))).toEqual([{ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false }]);
}, 30000);

it('aborts when the name is taken by a non-table', async () => {
  await down();
  await exec(`CREATE VIEW ${TABLE} AS SELECT 1 AS x`);
  await expect(up()).rejects.toThrow(/HAP-2029 wrong object: relationship_evidence_receipts/);
  await exec('ROLLBACK');
  await exec(`DROP VIEW ${TABLE}`);
}, 30000);

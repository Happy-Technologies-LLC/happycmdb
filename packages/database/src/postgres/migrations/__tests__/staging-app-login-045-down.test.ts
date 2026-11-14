// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1575: the manual 045 rollback on PGlite. After it the staging API login cmdb_app is NOLOGIN with no privilege of its
// own (PUBLIC's stay), 045-048 are un-recorded, other roles and ledger rows are untouched, and re-running is a no-op. The
// forward direction (app-login re-asserting LOGIN, the migrator re-granting) needs psql and a real server:
// deploy/test-staging-migrations.sh.
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
const down = () => exec(readFileSync(join(__dirname, '../rollback/045_staging_app_login_acl.down.sql'), 'utf8'));
const role = (name: string) => exec(`SELECT rolcanlogin FROM pg_roles WHERE rolname = '${name}'`);
const ledger = () => exec('SELECT migration_name FROM cmdb.schema_migrations ORDER BY migration_name');
/** Table, sequence and schema privileges cmdb_app holds itself (aclexplode skips PUBLIC's grantee 0 entries). */
const appGrants = () => exec(`
  SELECT 'rel ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type AS grant FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
    WHERE a.grantee = 'cmdb_app'::regrole AND n.nspname IN ('public', 'cmdb')
  UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a
    WHERE a.grantee = 'cmdb_app'::regrole
  ORDER BY 1`);

beforeAll(async () => {
  await exec(`CREATE SCHEMA cmdb;
    CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);
    INSERT INTO cmdb.schema_migrations VALUES ('044_business_service_journal_read_acl.sql'), ('045_staging_app_login_acl.sql'),
      ('046_service_offerings.sql'), ('047_ai_sync_cursors.sql'), ('048_portfolio_import.sql'), ('049_audit_entity_user.sql');
    CREATE TABLE public.audit_log (id serial PRIMARY KEY, note text);
    CREATE TABLE cmdb.dim_ci (id int PRIMARY KEY);
    CREATE ROLE cmdb_user LOGIN;
    CREATE ROLE cmdb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public, cmdb TO cmdb_app;
    GRANT SELECT, INSERT ON public.audit_log TO cmdb_app;
    GRANT USAGE ON SEQUENCE public.audit_log_id_seq TO cmdb_app;
    GRANT SELECT ON cmdb.dim_ci TO cmdb_app, PUBLIC;`);
  expect(await appGrants()).toHaveLength(6);
}, 30000);
afterAll(() => host.kill());

it('sets cmdb_app NOLOGIN, revokes its grants but not PUBLIC\'s, un-records 045-048 only, and is re-runnable', async () => {
  await down();
  expect([await role('cmdb_app'), await appGrants(), await ledger(), await role('cmdb_user')]).toEqual([
    [{ rolcanlogin: false }],
    [],
    [{ migration_name: '044_business_service_journal_read_acl.sql' }, { migration_name: '049_audit_entity_user.sql' }],
    [{ rolcanlogin: true }]]);
  expect(await exec(`SELECT has_table_privilege('cmdb_app', 'cmdb.dim_ci', 'SELECT') AS via_public`)).toEqual([{ via_public: true }]);
  await down(); // second run: still NOLOGIN, still no grants
  expect([await role('cmdb_app'), await appGrants()]).toEqual([[{ rolcanlogin: false }], []]);
}, 30000);

it('is a no-op when cmdb_app does not exist (dev, CI, owner-is-app deployments)', async () => {
  await exec(`DROP OWNED BY cmdb_app; DROP ROLE cmdb_app`);
  await down();
  expect(await role('cmdb_app')).toEqual([]);
}, 30000);

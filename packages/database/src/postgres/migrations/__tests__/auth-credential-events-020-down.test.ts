// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1382 S-2: the manual 020 rollback on PGlite, as the NOSUPERUSER owner role cmdb_user. A self-service password
// change (HAP-1285) advances :User.credentialEpoch in Neo4j and writes no auth_credential_events row, so the guard
// also needs the operator's attestation of the Neo4j generations and refuses on the HAP-1368 success audit row.
// The forward/lock/reapply path on a real server stays in tests/integration/postgres/auth-credential-events-migration.
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
const file = (name: string) => readFileSync(join(migrations, name), 'utf8');
const schema = file('001_complete_schema.sql');
const statement = (start: string) => schema.slice(schema.indexOf(start), schema.indexOf(');', schema.indexOf(start)) + 2);
const up = () => exec(`BEGIN;\n${file('020_auth_credential_events.sql')}\nCOMMIT;`);
const down = () => exec(file('rollback/020_auth_credential_events.down.sql'));
const attest = (epoch: string | null) => exec(epoch === null
  ? 'RESET cmdb.rollback_020_max_credential_epoch'
  : `SET cmdb.rollback_020_max_credential_epoch = '${epoch}'`);
/** One HAP-1368 password-change audit row (AuthService.auditPasswordChange) of user-1. */
const audited = (outcome: 'success' | 'wrong_password') => exec(`INSERT INTO audit_log (entity_type, entity_id, action, actor,
  actor_type, metadata) VALUES ('USER', 'user-1', 'UPDATE', 'user-1', 'user',
  '{"operation":"password_change","outcome":"${outcome}","organization_id":"00000000-0000-0000-0000-000000000000"}')`);
/** What the rollback removes: the epoch column, the audit table and the ledger row. */
const applied = async () => [
  await exec(`SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys' AND column_name = 'credential_epoch'`),
  await exec(`SELECT to_regclass('public.auth_credential_events')::text AS t`),
  await exec('SELECT migration_name FROM cmdb.schema_migrations'),
];
const APPLIED = [[{ column_name: 'credential_epoch' }], [{ t: 'auth_credential_events' }],
  [{ migration_name: '020_auth_credential_events.sql' }]];
async function refused(message: string): Promise<void> {
  await expect(down()).rejects.toThrow(message);
  await exec('ROLLBACK');
  expect(await applied()).toEqual(APPLIED);
}

beforeAll(async () => {
  const [{ db }] = await exec('SELECT current_database() AS db') as Array<{ db: string }>;
  await exec(`CREATE ROLE cmdb_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_user; GRANT CREATE ON SCHEMA public TO cmdb_user; SET ROLE cmdb_user;
    CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);`);
  await exec([statement('CREATE TYPE audit_action AS ENUM ('), statement('CREATE TYPE audit_entity_type AS ENUM ('),
    statement('CREATE TYPE audit_actor_type AS ENUM ('), statement('CREATE TABLE IF NOT EXISTS audit_log ('),
    statement('CREATE TABLE IF NOT EXISTS api_keys (')].join('\n'));
  await exec(`BEGIN;\n${file('049_audit_entity_user.sql')}\nCOMMIT;`);
  await up();
  await exec(`INSERT INTO cmdb.schema_migrations VALUES ('020_auth_credential_events.sql');
    INSERT INTO api_keys (user_id, key_hash, name, role) VALUES ('user-1', repeat('a', 64), 'pre-change key', 'viewer')`);
}, 30000);
afterAll(() => host.kill());

it('refuses, changing nothing, until the operator attests every Neo4j credential generation is 0', async () => {
  // A self-service change left user-1 at generation 1 in Neo4j and its pre-change key at 0: no PostgreSQL trace.
  expect(await applied()).toEqual(APPLIED);
  await attest(null);
  await refused('020 down refused: cmdb.rollback_020_max_credential_epoch is not attested as 0');
  await attest('1');
  await refused('020 down refused: cmdb.rollback_020_max_credential_epoch is not attested as 0');
}, 30000);

it('refuses despite an attestation once a successful self-service password change is in audit_log', async () => {
  await audited('success');
  await attest('0');
  await refused('020 down refused: a self-service password change advanced a credential generation');
  await exec(`DELETE FROM audit_log WHERE metadata->>'outcome' = 'success'`);
}, 30000);

it('with the attestation and no lifecycle trace (a wrong current password advances nothing) it rolls 020 back', async () => {
  await audited('wrong_password');
  await attest('0');
  await down();
  expect(await applied()).toEqual([[], [{ t: null }], []]);
  expect(await exec('SELECT name FROM api_keys')).toEqual([{ name: 'pre-change key' }]);
}, 30000);

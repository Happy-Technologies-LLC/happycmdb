// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-2039: migration 055 widens auth_credential_events_event_check by the two portfolio_import_scope_* events, and its
// manual rollback narrows it again only while no such row exists. PGlite as the NOSUPERUSER owner role cmdb_user, on top
// of the real 020. The forward path on a real server stays in tests/integration/postgres/auth-credential-events-migration.
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
const file = (name: string) => readFileSync(join(migrations, name), 'utf8');
const UP = '055_auth_credential_events_scope_events.sql';
const schema = file('001_complete_schema.sql');
const statement = (start: string) => schema.slice(schema.indexOf(start), schema.indexOf(');', schema.indexOf(start)) + 2);
// 020, then a SELECT/INSERT grant to a probe role standing for cmdb_app (045): a grant change by 055 must show for it.
const up020 = async () => {
  await exec(`BEGIN;\n${file('020_auth_credential_events.sql')}\nCOMMIT;`);
  await exec('GRANT SELECT, INSERT ON auth_credential_events TO cmdb_app_probe');
};
const up = () => exec(`BEGIN;\n${file(UP)}\nCOMMIT;`);
const down = () => exec(file('rollback/055_auth_credential_events_scope_events.down.sql'));
/** The table as 020 leaves it: no rows, no 055. */
const reset = async () => {
  await exec('DROP TABLE auth_credential_events');
  await up020();
  await exec('DELETE FROM cmdb.schema_migrations');
};
const record = () => exec(`INSERT INTO cmdb.schema_migrations VALUES ('${UP}')`);
const insert = (event: string, targetEpoch?: number) => exec(
  `INSERT INTO auth_credential_events (user_id, event, actor${targetEpoch === undefined ? '' : ', target_epoch'})
   VALUES ('u', '${event}', 'window-script:t'${targetEpoch === undefined ? '' : `, ${targetEpoch}`})`);
const ledger = () => exec('SELECT migration_name FROM cmdb.schema_migrations');
/** Every constraint and trigger except the one 055 changes. */
const rest = async () => [
  await exec(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'auth_credential_events'::regclass AND conname <> 'auth_credential_events_event_check' ORDER BY conname`),
  await exec(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'auth_credential_events'::regclass AND NOT tgisinternal ORDER BY tgname`),
];
/** Every privilege on the table for every role (PUBLIC included), the owner's implicit ones too. */
const grants = () => exec(`SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
    a.privilege_type, a.is_grantable
  FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = 'auth_credential_events'::regclass ORDER BY 1, 2, 3`);
const APPEND_ONLY_TRIGGERS = ['auth_credential_events_no_truncate', 'auth_credential_events_no_update_delete'];
/** The two append-only triggers exist and are enabled for every session role ('O' is ENABLE; 'D' disabled, 'R' replica-only, 'A' always). */
const expectAppendOnlyEnabled = async () =>
  expect(await exec(`SELECT tgname, tgenabled FROM pg_trigger
    WHERE tgrelid = 'auth_credential_events'::regclass AND NOT tgisinternal ORDER BY tgname`))
    .toEqual(APPEND_ONLY_TRIGGERS.map(tgname => ({ tgname, tgenabled: 'O' })));
const SCOPE_EVENTS = ['portfolio_import_scope_granted', 'portfolio_import_scope_revoked'];
const EXISTING_EVENTS = ['default_marker_set_scan', 'default_marker_set_login',
  'password_rotation_intent', 'password_rotated_operator', 'password_rotation_not_applied'];
const comment = async () => ((await exec(`SELECT obj_description('auth_credential_events'::regclass, 'pg_class') AS c`)) as Array<{ c: string }>)[0]!.c;
const REFUSED = '055 down refused: auth_credential_events holds portfolio_import_scope_* rows';
const rejectedByEventCheck = (event: string) => expect(insert(event)).rejects.toMatchObject({
  code: '23514', message: expect.stringContaining('auth_credential_events_event_check') });

let before: unknown[];
let grantsBefore: unknown[];
let commentBefore: string;

beforeAll(async () => {
  const [{ db }] = await exec('SELECT current_database() AS db') as Array<{ db: string }>;
  await exec(`CREATE ROLE cmdb_app_probe NOLOGIN NOSUPERUSER; CREATE ROLE cmdb_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_user; GRANT CREATE ON SCHEMA public TO cmdb_user; SET ROLE cmdb_user;
    CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text PRIMARY KEY);`);
  await exec(statement('CREATE TABLE IF NOT EXISTS api_keys ('));
  await up020();
  await exec(`INSERT INTO auth_credential_events (user_id, event, actor) VALUES ('legacy', 'default_marker_set_scan', 'window-script:old')`);
  before = await rest();
  grantsBefore = await grants();
  commentBefore = await comment();
}, 30000);
afterAll(() => host.kill());

it('applies over 020: the new events are rejected before it and accepted after, the existing row survives, nothing else changes', async () => {
  for (const event of SCOPE_EVENTS) await rejectedByEventCheck(event);
  const [{ id }] = await exec('SELECT id FROM auth_credential_events') as Array<{ id: string }>;

  await up(); // an ALTER does not fire the append-only row triggers

  expect(await exec('SELECT id, user_id, event, actor FROM auth_credential_events'))
    .toEqual([{ id, user_id: 'legacy', event: 'default_marker_set_scan', actor: 'window-script:old' }]);
  expect(await rest()).toEqual(before);
  expect(await grants()).toEqual(grantsBefore); // 055 changed no grant, for any role
  await expectAppendOnlyEnabled();
  // The comment now names every event kind the table holds, including the scope events; 020's wording is gone.
  const described = await comment();
  for (const event of [...EXISTING_EVENTS, ...SCOPE_EVENTS]) expect(described).toContain(event);
  expect(described).not.toBe(commentBefore);
  for (const event of SCOPE_EVENTS) await insert(event);
  expect(await exec(`SELECT event FROM auth_credential_events WHERE event LIKE 'portfolio_import_scope_%' ORDER BY event`))
    .toEqual(SCOPE_EVENTS.map(event => ({ event })));
}, 30000);

it('is idempotent and accepts only the two new values beyond the five existing events, each with its original shape', async () => {
  await up();

  await rejectedByEventCheck('portfolio_import_scope_deleted');
  await rejectedByEventCheck('portfolio_import_scope_');
  await insert('default_marker_set_scan');
  await insert('default_marker_set_login');
  await insert('password_rotation_intent', 1);
  await insert('password_rotation_intent', 2);
  const intents = await exec(`SELECT id FROM auth_credential_events WHERE event = 'password_rotation_intent' ORDER BY target_epoch`) as Array<{ id: string }>;
  await exec(`INSERT INTO auth_credential_events (user_id, event, actor, ref_event_id, revoked_api_keys)
    VALUES ('u', 'password_rotated_operator', 'window-script:t', '${intents[0]!.id}', 0)`);
  await exec(`INSERT INTO auth_credential_events (user_id, event, actor, ref_event_id, reason)
    VALUES ('u', 'password_rotation_not_applied', 'window-script:t', '${intents[1]!.id}', 'guard_failed')`);
  // The other 020 equivalences still bind the new events: a scope event with an outcome reference is refused.
  await expect(exec(`INSERT INTO auth_credential_events (user_id, event, actor, ref_event_id)
    VALUES ('u', '${SCOPE_EVENTS[0]}', 'window-script:t', '${intents[0]!.id}')`)).rejects.toMatchObject({ code: '23514' });
}, 30000);

it('the rollback refuses, changing nothing, while a portfolio_import_scope_* row exists', async () => {
  await record();
  const rows = await exec('SELECT count(*)::int AS n FROM auth_credential_events');

  await expect(down()).rejects.toThrow(REFUSED);
  await exec('ROLLBACK');

  expect(await exec('SELECT count(*)::int AS n FROM auth_credential_events')).toEqual(rows);
  expect(await ledger()).toEqual([{ migration_name: UP }]);
  await insert(SCOPE_EVENTS[1]!); // the wide CHECK is still in force
}, 30000);

it('with no scope row the rollback restores the narrow CHECK, keeps other rows, removes the ledger row, and reruns after re-applying 055', async () => {
  await reset();
  await insert('default_marker_set_scan');
  await up();
  await record();

  await down();

  expect(await ledger()).toEqual([]);
  expect(await exec('SELECT event FROM auth_credential_events')).toEqual([{ event: 'default_marker_set_scan' }]);
  for (const event of SCOPE_EVENTS) await rejectedByEventCheck(event);
  await insert('default_marker_set_login');
  expect(await rest()).toEqual(before);
  expect(await grants()).toEqual(grantsBefore);
  await expectAppendOnlyEnabled();
  expect(await comment()).toBe(commentBefore);

  await up();
  await record();
  await insert(SCOPE_EVENTS[0]!);
  await expect(down()).rejects.toThrow(REFUSED);
  await exec('ROLLBACK');
  await reset();
  await up();
  await record();
  await down();
  expect(await ledger()).toEqual([]);
  await rejectedByEventCheck(SCOPE_EVENTS[0]!);
}, 30000);

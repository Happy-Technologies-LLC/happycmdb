// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@cmdb/common', () => ({ logger }));

import { fork } from 'child_process';
import { join } from 'path';
import { checkDbRole, probeDbRole, requireNonSuperuser, type DbRolePool } from '../db-role-guard';

const SENTINEL = 'sentinel-password-p4ss';

function fakePool(outcome: { row?: Record<string, unknown>; rows?: unknown[]; error?: Error & { code?: string } }) {
  const statements: string[] = [];
  const release = jest.fn();
  const client = {
    query: jest.fn(async (text: string) => {
      statements.push(text);
      if (text.startsWith('SELECT')) {
        if (outcome.error) throw outcome.error;
        return { rows: outcome.rows ?? (outcome.row ? [outcome.row] : []) };
      }
      return { rows: [] };
    }),
    release,
  };
  const pool: DbRolePool = { connect: jest.fn(async () => client as never) };
  return { pool, statements, release };
}

const role = (rolsuper: boolean, rolbypassrls: boolean, extra: Record<string, unknown> = {}) =>
  ({ row: {
    current_user: 'cmdb_x', session_user: 'cmdb_x', rolsuper, rolbypassrls,
    session_user_privileged: false, can_set_privileged_role: false, ...extra,
  } });
const FLAGS = { current_user: 'cmdb_x', session_user: 'cmdb_x', rolsuper: false, rolbypassrls: false,
  session_user_privileged: false, can_set_privileged_role: false };
const logged = () => JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
const OFF = {} as NodeJS.ProcessEnv;
const ON = { REQUIRE_NON_SUPERUSER_DB: 'true' } as NodeJS.ProcessEnv;

beforeEach(() => jest.clearAllMocks());

describe('checkDbRole', () => {
  test('NOSUPERUSER and NOBYPASSRLS without membership: one info line with the roles and every flag, no error', async () => {
    await expect(checkDbRole(fakePool(role(false, false)).pool, ON)).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][1]).toEqual(FLAGS);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each([[true, true], [true, false], [false, true]])(
    'rolsuper=%s rolbypassrls=%s with enforcement off: error line naming role and flags, startup continues',
    async (rolsuper, rolbypassrls) => {
      await expect(checkDbRole(fakePool(role(rolsuper, rolbypassrls)).pool, OFF)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][1]).toEqual({ ...FLAGS, rolsuper, rolbypassrls });
      expect(logger.info).not.toHaveBeenCalled();
    });

  test('BYPASSRLS is described as ignoring RLS policies only; only a superuser ignores grants too', async () => {
    await checkDbRole(fakePool(role(false, true)).pool, OFF);
    const message = logger.error.mock.calls[0][0] as string;
    expect(message).toMatch(/BYPASSRLS role \(ignores row level security policies\)/);
    expect(message).toMatch(/superuser \(ignores row level security and grants\)/);
  });

  test.each([[true, true], [true, false], [false, true]])(
    'rolsuper=%s rolbypassrls=%s with REQUIRE_NON_SUPERUSER_DB=true: refuses, naming the role and flags',
    async (rolsuper, rolbypassrls) => {
      await expect(checkDbRole(fakePool(role(rolsuper, rolbypassrls)).pool, ON))
        .rejects.toThrow(`"cmdb_x" (session login "cmdb_x"; rolsuper=${rolsuper}, rolbypassrls=${rolbypassrls}, ` +
          'session_user_privileged=false, can_set_privileged_role=false)');
      expect(logger.info).not.toHaveBeenCalled();
    });

  const escalations: Array<[string, Record<string, unknown>]> = [
    ['a NOSUPERUSER NOBYPASSRLS login that can SET ROLE to a privileged role', { can_set_privileged_role: true }],
    ['a plain current_user under a privileged session_user', { session_user: 'cmdb_login', session_user_privileged: true }],
  ];

  test.each(escalations)('%s: logs error with enforcement off, refuses with it on, naming roles and flags', async (_name, extra) => {
    const flags = { ...FLAGS, ...extra };
    await expect(checkDbRole(fakePool(role(false, false, extra)).pool, OFF)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toEqual(flags);
    expect(logger.info).not.toHaveBeenCalled();

    const refusal = await checkDbRole(fakePool(role(false, false, extra)).pool, ON).then(() => undefined, (e: Error) => e);
    expect(refusal?.message).toContain(`"cmdb_x" (session login "${flags.session_user}"; rolsuper=false, rolbypassrls=false, ` +
      `session_user_privileged=${flags.session_user_privileged}, can_set_privileged_role=${flags.can_set_privileged_role})`);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logged() + refusal?.message).not.toContain(SENTINEL);
  });

  test('a flag that is not an explicit false (null) counts as a violation', async () => {
    await expect(checkDbRole(fakePool(role(false, false, { can_set_privileged_role: null })).pool, ON)).rejects.toThrow(/refusing to start/);
  });

  test('probe failure with enforcement off: warn with the SQLSTATE only, continues; the message never reaches a log', async () => {
    const error = Object.assign(new Error(`password authentication failed ${SENTINEL}`), { code: '28P01' });
    await expect(checkDbRole(fakePool({ error }).pool, OFF)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toEqual({ reason: '28P01' });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logged()).not.toContain(SENTINEL);
  });

  test('probe failure with enforcement on: refuses, and the thrown error does not carry the probe message', async () => {
    const error = Object.assign(new Error(`password authentication failed ${SENTINEL}`), { code: '28P01' });
    const refusal = await checkDbRole(fakePool({ error }).pool, ON).then(() => undefined, (e: Error) => e);
    expect(refusal?.message).toMatch(/probe failed \(28P01\)/);
    expect(refusal?.message).not.toContain(SENTINEL);
    expect(logged()).not.toContain(SENTINEL);
  });

  test('a failed connect is a probe failure too', async () => {
    const pool: DbRolePool = { connect: async () => { throw Object.assign(new Error(SENTINEL), { code: 'ECONNREFUSED' }); } };
    await expect(checkDbRole(pool, OFF)).resolves.toBeUndefined();
    expect(logger.warn.mock.calls[0][1]).toEqual({ reason: 'ECONNREFUSED' });
    await expect(checkDbRole(pool, ON)).rejects.toThrow(/ECONNREFUSED/);
  });

  test('a missing role row is a probe failure, not a pass', async () => {
    await expect(checkDbRole(fakePool({ rows: [] }).pool, OFF)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    await expect(checkDbRole(fakePool({ rows: [] }).pool, ON)).rejects.toThrow(/probe failed/);
  });

  test('the probe runs BEGIN READ ONLY, a statement_timeout, one SELECT, ROLLBACK, then releases the client', async () => {
    const { pool, statements, release } = fakePool(role(false, false));
    await checkDbRole(pool, OFF);
    expect(statements).toEqual([
      'BEGIN READ ONLY',
      expect.stringMatching(/^SET LOCAL statement_timeout = [1-9]\d*$/),
      expect.stringMatching(/^SELECT current_user::text AS current_user, session_user::text AS session_user, .+ AS can_set_privileged_role FROM pg_roles WHERE rolname IN \(current_user, session_user\) HAVING bool_or\(rolname = current_user\)$/),
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  test('the transaction is rolled back and the client released even when the SELECT fails; a failed ROLLBACK destroys the client', async () => {
    const { pool, statements, release } = fakePool({ error: new Error('boom') });
    await checkDbRole(pool, OFF);
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);

    const rollbackError = new Error('rollback failed');
    const client = {
      query: jest.fn(async (text: string) => {
        if (text === 'ROLLBACK') throw rollbackError;
        return { rows: [role(false, false).row] };
      }),
      release: jest.fn(),
    };
    await checkDbRole({ connect: async () => client as never }, OFF);
    expect(client.release).toHaveBeenCalledWith(rollbackError);
  });
});

describe('requireNonSuperuser', () => {
  test.each([['true', true], ['TRUE', true], [' true ', true], ['1', false], ['yes', false], ['', false], ['false', false]])(
    'REQUIRE_NON_SUPERUSER_DB=%j enables enforcement: %s', (value, expected) => {
      expect(requireNonSuperuser({ REQUIRE_NON_SUPERUSER_DB: value } as NodeJS.ProcessEnv)).toBe(expected);
    });

  test('unset is off', () => {
    expect(requireNonSuperuser({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

// The SQL itself, run through probeDbRole on real PostgreSQL (PGlite, hosted in a forked child; see pglite-host.cjs).
describe('probeDbRole against PostgreSQL', () => {
  const host = fork(join(__dirname, '../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
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
  const poolFor = (sessionRole: string, setRole?: string): DbRolePool => ({
    connect: async () => {
      await exec('RESET SESSION AUTHORIZATION; RESET ROLE');
      await exec(`SET SESSION AUTHORIZATION ${sessionRole}`);
      if (setRole) await exec(`SET ROLE ${setRole}`);
      return { query: (async (text: string) => ({ rows: await exec(text) })) as never, release: () => undefined };
    },
  });

  beforeAll(async () => {
    await exec(`
      CREATE ROLE g_super LOGIN SUPERUSER;
      CREATE ROLE g_bypass LOGIN NOSUPERUSER BYPASSRLS;
      CREATE ROLE g_plain LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE g_plain_parent NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE g_priv_parent NOLOGIN NOSUPERUSER BYPASSRLS;
      CREATE ROLE g_super_parent NOLOGIN SUPERUSER;
      CREATE ROLE g_member_plain LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE g_plain_parent;
      CREATE ROLE g_member_bypass LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE g_priv_parent;
      CREATE ROLE g_member_noinherit LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT IN ROLE g_super_parent;
      CREATE ROLE g_dual LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE g_plain_parent, g_super_parent;
      CREATE ROLE g_grandchild LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE g_member_bypass;`);
  }, 30000);
  afterAll(() => host.kill());

  const probe = (sessionRole: string, setRole?: string) => probeDbRole(poolFor(sessionRole, setRole));
  const pick = (r: Awaited<ReturnType<typeof probeDbRole>>) =>
    [r.current_user, r.session_user, r.rolsuper, r.rolbypassrls, r.session_user_privileged, r.can_set_privileged_role];

  test.each([
    // A superuser is a member of every role, so it also reports can_set_privileged_role (already flagged by rolsuper).
    ['superuser', 'g_super', undefined, ['g_super', 'g_super', true, false, true, true]],
    ['BYPASSRLS', 'g_bypass', undefined, ['g_bypass', 'g_bypass', false, true, true, false]],
    ['plain', 'g_plain', undefined, ['g_plain', 'g_plain', false, false, false, false]],
    ['plain member of a plain role', 'g_member_plain', undefined, ['g_member_plain', 'g_member_plain', false, false, false, false]],
    ['plain member of a BYPASSRLS role', 'g_member_bypass', undefined, ['g_member_bypass', 'g_member_bypass', false, false, false, true]],
    ['NOINHERIT member of a superuser role', 'g_member_noinherit', undefined, ['g_member_noinherit', 'g_member_noinherit', false, false, false, true]],
    ['indirect member of a BYPASSRLS role', 'g_grandchild', undefined, ['g_grandchild', 'g_grandchild', false, false, false, true]],
    ['plain current_user under a superuser session login', 'g_super', 'g_plain', ['g_plain', 'g_super', false, false, true, true]],
    ['plain current_user under a plain session login that is a member of a superuser role', 'g_dual', 'g_plain_parent',
      ['g_plain_parent', 'g_dual', false, false, false, true]],
  ])('%s', async (_name, sessionRole, setRole, expected) => {
    expect(pick(await probe(sessionRole, setRole))).toEqual(expected);
  });

  test('is a read-only probe: the transaction is rolled back and the session is usable afterwards', async () => {
    await probe('g_plain');
    expect(await exec('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });
});

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@cmdb/common', () => ({ logger }));

import { fork } from 'child_process';
import { join } from 'path';
import { bypassesRowSecurity, checkDbRole, probeDbRole, requireNonSuperuser, type DbRolePool } from '../db-role-guard';

const SENTINEL = 'sentinel-password-p4ss';

/**
 * `version` is the server_version_num the fake server reports. A fake PG15 or older rejects the bare `system_user`
 * token with 42703 (undefined column), as the real server does.
 */
function fakePool(outcome: { row?: Record<string, unknown>; rows?: unknown[]; error?: Error & { code?: string }; version?: string }) {
  const statements: string[] = [];
  const release = jest.fn();
  const client = {
    query: jest.fn(async (text: string) => {
      statements.push(text);
      if (text === 'SHOW server_version_num') return { rows: [{ server_version_num: outcome.version ?? '170000' }] };
      if (text.startsWith('SELECT')) {
        if (Number(outcome.version ?? '170000') < 160000 && /\bsystem_user\b/.test(text)) {
          throw Object.assign(new Error('column "system_user" does not exist'), { code: '42703' });
        }
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
    session_user_privileged: false, can_set_privileged_role: false, session_authorization_masked: false,
    dangerous_builtin_role_member: false, createrole_escalation: false, replication_escalation: false, ...extra,
  } });
const FLAGS = { current_user: 'cmdb_x', session_user: 'cmdb_x', rolsuper: false, rolbypassrls: false,
  session_user_privileged: false, can_set_privileged_role: false, session_authorization_masked: false,
  dangerous_builtin_role_member: false, createrole_escalation: false, replication_escalation: false };
const FLAG_NAMES = ['rolsuper', 'rolbypassrls', 'session_user_privileged', 'can_set_privileged_role',
  'session_authorization_masked', 'dangerous_builtin_role_member', 'createrole_escalation',
  'replication_escalation'] as const;
const detailOf = (flags: Record<string, unknown>) => FLAG_NAMES.map(name => `${name}=${flags[name]}`).join(', ');
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
        .rejects.toThrow(`"cmdb_x" (session login "cmdb_x"; ${detailOf({ ...FLAGS, rolsuper, rolbypassrls })})`);
      expect(logger.info).not.toHaveBeenCalled();
    });

  const escalations: Array<[string, Record<string, unknown>]> = [
    ['a NOSUPERUSER NOBYPASSRLS login that can SET ROLE to a privileged role', { can_set_privileged_role: true }],
    ['a plain current_user under a privileged session_user', { session_user: 'cmdb_login', session_user_privileged: true }],
    ['a session login masked by SET SESSION AUTHORIZATION', { session_authorization_masked: true }],
    ['a member of a dangerous built-in role', { dangerous_builtin_role_member: true }],
    ['a CREATEROLE login below PostgreSQL 16', { createrole_escalation: true }],
    ['a member of a REPLICATION role', { replication_escalation: true }],
  ];

  test.each(escalations)('%s: logs error with enforcement off, refuses with it on, naming roles and flags', async (_name, extra) => {
    const flags = { ...FLAGS, ...extra };
    await expect(checkDbRole(fakePool(role(false, false, extra)).pool, OFF)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toEqual(flags);
    expect(logger.info).not.toHaveBeenCalled();

    const refusal = await checkDbRole(fakePool(role(false, false, extra)).pool, ON).then(() => undefined, (e: Error) => e);
    expect(refusal?.message).toContain(`"cmdb_x" (session login "${flags.session_user}"; ${detailOf(flags)})`);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logged() + refusal?.message).not.toContain(SENTINEL);
  });

  test.each(FLAG_NAMES)('%s that is not an explicit false (null or missing) counts as a violation', async (name) => {
    await expect(checkDbRole(fakePool(role(false, false, { [name]: null })).pool, ON)).rejects.toThrow(/refusing to start/);
    const { [name]: _dropped, ...rest } = role(false, false).row;
    await expect(checkDbRole(fakePool({ row: rest }).pool, ON)).rejects.toThrow(/refusing to start/);
  });

  test('the refusal and the error line name each reason', async () => {
    const refusal = await checkDbRole(fakePool(role(false, false, { replication_escalation: true })).pool, ON)
      .then(() => undefined, (e: Error) => e);
    await checkDbRole(fakePool(role(false, false, { replication_escalation: true })).pool, OFF);
    for (const text of [refusal?.message, logger.error.mock.calls[0][0] as string]) {
      expect(text).toContain('session_authorization_masked');
      expect(text).toContain('dangerous_builtin_role_member');
      expect(text).toContain('createrole_escalation');
      expect(text).toContain('replication_escalation');
      expect(text).toContain('pg_execute_server_program');
      expect(text).toContain('pg_read_all_data');
    }
    expect(refusal?.message).toContain('replication_escalation=true');
  });

  test('a probe row whose session login has no pg_roles row (session_user_privileged = true, the SQL default) is a violation', async () => {
    const row = { ...role(false, false).row, session_user: 'vanished_login', session_user_privileged: true };
    await expect(checkDbRole(fakePool({ row }).pool, ON)).rejects.toThrow(/session login "vanished_login".*session_user_privileged=true/);
    await expect(checkDbRole(fakePool({ row }).pool, OFF)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
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

  test.each(['150000', '160000', '170000'])(
    'PG %s: the probe runs in a read-only transaction with a 5 s statement_timeout and a pinned search_path (before the version read and the probe), one probe SELECT, then ROLLBACK, and releases the client',
    async (version) => {
      const { pool, statements, release } = fakePool({ ...role(false, false), version });
      await checkDbRole(pool, OFF);
      expect(statements[0]).toBe('BEGIN READ ONLY');
      expect(statements[1]).toBe('SET LOCAL statement_timeout = 5000');
      expect(statements[2]).toBe('SET LOCAL search_path = pg_catalog, pg_temp');
      expect(statements[3]).toBe('SHOW server_version_num');
      expect(statements[4]).toMatch(/^SELECT\b/);
      expect(statements.at(-1)).toBe('ROLLBACK');
      const selects = statements.filter(text => /^SELECT\b/.test(text));
      expect(selects).toHaveLength(1);
      expect(selects[0]).not.toContain(';');
      expect(statements.filter(text => !/^SELECT\b/.test(text))).toEqual([
        'BEGIN READ ONLY', 'SET LOCAL statement_timeout = 5000', 'SET LOCAL search_path = pg_catalog, pg_temp',
        'SHOW server_version_num', 'ROLLBACK',
      ]);
      expect(release).toHaveBeenCalledWith(undefined);
    });

  // The unflagged predefined roles (pg_monitor and its parts, pg_signal_backend, pg_create_subscription, pg_maintain,
  // pg_checkpoint, pg_use_reserved_connections) are a settled decision: adding a name here is a deliberate change.
  test.each(['150000', '170000'])('PG %s: the probe flags exactly the five dangerous built-in roles by name', async (version) => {
    const { pool, statements } = fakePool({ ...role(false, false), version });
    await checkDbRole(pool, OFF);
    const list = /r\.rolname IN \(([^)]*)\)\s+AND \(pg_has_role/.exec(statements.find(text => /^SELECT\b/.test(text))!)?.[1];
    expect(list?.split(',').map(name => name.trim())).toEqual([
      "'pg_execute_server_program'", "'pg_write_server_files'", "'pg_read_server_files'", "'pg_read_all_data'", "'pg_write_all_data'",
    ]);
  });

  test.each(['', 'abc', '0', '-1', '16.0'])('an unreadable server_version_num (%j) is a probe failure, not a pass', async (version) => {
    await expect(checkDbRole(fakePool({ ...role(false, false), version }).pool, ON)).rejects.toThrow(/probe failed/);
    await expect(checkDbRole(fakePool({ ...role(false, false), version }).pool, OFF)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('PG15 and older never send system_user (undefined column there); PG16 and newer do not fail', async () => {
    await expect(checkDbRole(fakePool({ ...role(false, false), version: '150004' }).pool, ON)).resolves.toBeUndefined();
    await expect(checkDbRole(fakePool({ ...role(false, false), version: '160000' }).pool, ON)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
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
        if (text === 'SHOW server_version_num') return { rows: [{ server_version_num: '170000' }] };
        return { rows: [role(false, false).row] };
      }),
      release: jest.fn(),
    };
    await checkDbRole({ connect: async () => client as never }, OFF);
    expect(client.release).toHaveBeenCalledWith(rollbackError);
  });
});

describe('bypassesRowSecurity', () => {
  const combos = Array.from({ length: 2 ** FLAG_NAMES.length }, (_, mask) =>
    Object.fromEntries(FLAG_NAMES.map((name, bit) => [name, Boolean(mask & (1 << bit))])) as Record<(typeof FLAG_NAMES)[number], boolean>);

  test.each(combos.map(combo => [FLAG_NAMES.filter(name => combo[name]).join('+') || 'none', combo] as const))(
    'flags set: %s', (_name, combo) => {
      expect(bypassesRowSecurity(combo)).toBe(FLAG_NAMES.some(name => combo[name]));
    });

  test('a row that carries none of the eight flags is unflagged whatever else it says (no flag exists for the monitor-family roles)', () => {
    const clean = Object.fromEntries(FLAG_NAMES.map(name => [name, false])) as Record<(typeof FLAG_NAMES)[number], boolean>;
    const extra = { pg_monitor_member: true, pg_read_all_stats_member: true, pg_read_all_settings_member: true,
      pg_signal_backend_member: true, pg_create_subscription_member: true, pg_maintain_member: true,
      pg_checkpoint_member: true, pg_use_reserved_connections_member: true };
    expect(bypassesRowSecurity({ ...clean, ...extra })).toBe(false);
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
  /**
   * `version` overrides what SHOW server_version_num reports (PGlite is PG18), so the older-server statement runs
   * on a server that also accepts it. `systemUser` replaces the `system_user` token with a literal, standing in for
   * PG16+'s authenticated identity (PGlite's system_user is always NULL: no authentication step).
   */
  const poolFor = (sessionRole: string, setRole?: string,
    opts: { version?: string; systemUser?: string; sessionSql?: string } = {}): DbRolePool => ({
    connect: async () => {
      await exec('RESET SESSION AUTHORIZATION; RESET ROLE; RESET search_path');
      await exec(`SET SESSION AUTHORIZATION ${sessionRole}`);
      if (opts.sessionSql) await exec(opts.sessionSql);
      if (setRole) await exec(`SET ROLE ${setRole}`);
      const query = async (text: string) => {
        if (opts.version && text === 'SHOW server_version_num') return { rows: [{ server_version_num: opts.version }] };
        const sql = opts.systemUser === undefined ? text : text.replace(/\bsystem_user\b/g, `'${opts.systemUser}'::text`);
        return { rows: await exec(sql) };
      };
      return { query: query as never, release: () => undefined };
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
      CREATE ROLE g_grandchild LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE g_member_bypass;
      CREATE ROLE g_prog LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_execute_server_program;
      CREATE ROLE g_wfiles LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_write_server_files;
      CREATE ROLE g_rfiles LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_read_server_files;
      CREATE ROLE g_wall LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_write_all_data;
      CREATE ROLE g_rall LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_read_all_data;
      CREATE ROLE g_noinherit_prog LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT IN ROLE pg_execute_server_program;
      CREATE ROLE g_prog_parent NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_read_server_files;
      CREATE ROLE g_prog_child LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE g_prog_parent;
      CREATE ROLE g_createrole LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      CREATE ROLE g_cr_parent NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
      CREATE ROLE g_cr_member LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE IN ROLE g_cr_parent;
      CREATE ROLE g_cr_holder NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      CREATE ROLE g_cr_via_holder LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE IN ROLE g_cr_holder;
      CREATE ROLE g_cr_grandchild LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE IN ROLE g_cr_via_holder;
      CREATE ROLE g_repl LOGIN NOSUPERUSER NOBYPASSRLS REPLICATION;
      CREATE ROLE g_repl_parent NOLOGIN NOSUPERUSER NOBYPASSRLS REPLICATION;
      CREATE ROLE g_repl_member LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION IN ROLE g_repl_parent;
      CREATE ROLE g_repl_noinherit LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOINHERIT IN ROLE g_repl_parent;
      CREATE ROLE g_repl_grandchild LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION IN ROLE g_repl_member;
      CREATE ROLE g_sess_plain NOLOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION;
      CREATE ROLE g_sess_prog LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_execute_server_program, g_sess_plain;
      CREATE ROLE g_sess_repl LOGIN NOSUPERUSER NOBYPASSRLS REPLICATION IN ROLE g_sess_plain;
      CREATE ROLE g_opt_inherit_false LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE g_opt_set_false LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE g_opt_admin_both_false LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT pg_execute_server_program TO g_opt_inherit_false WITH INHERIT FALSE;
      GRANT pg_execute_server_program TO g_opt_set_false WITH SET FALSE;
      GRANT pg_execute_server_program TO g_opt_admin_both_false WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;
      CREATE ROLE g_unflagged LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE pg_monitor, pg_read_all_stats, pg_read_all_settings,
        pg_stat_scan_tables, pg_signal_backend, pg_create_subscription, pg_maintain, pg_checkpoint, pg_use_reserved_connections;
      CREATE ROLE g_shadow_parent NOLOGIN NOSUPERUSER NOBYPASSRLS REPLICATION;
      CREATE ROLE g_shadow LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE g_shadow_parent, pg_read_all_data;
      CREATE ROLE g_shadow_bypass LOGIN NOSUPERUSER BYPASSRLS;
      GRANT CREATE ON SCHEMA public TO g_shadow, g_shadow_bypass;`);
  }, 30000);
  afterAll(() => host.kill());

  const probe = (sessionRole: string, setRole?: string, opts?: { version?: string; systemUser?: string }) =>
    probeDbRole(poolFor(sessionRole, setRole, opts));
  const pick = (r: Awaited<ReturnType<typeof probeDbRole>>) =>
    [r.current_user, r.session_user, r.rolsuper, r.rolbypassrls, r.session_user_privileged, r.can_set_privileged_role];
  const escalation = (r: Awaited<ReturnType<typeof probeDbRole>>) =>
    [r.session_authorization_masked, r.dangerous_builtin_role_member, r.createrole_escalation, r.replication_escalation];

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
    ['member of a dangerous built-in role is not a privileged-role member', 'g_prog', undefined, ['g_prog', 'g_prog', false, false, false, false]],
  ])('%s', async (_name, sessionRole, setRole, expected) => {
    expect(pick(await probe(sessionRole, setRole))).toEqual(expected);
  });

  // Escalation flags: [session_authorization_masked, dangerous_builtin_role_member, createrole_escalation, replication_escalation].
  // A superuser is a member of every role, so it also reports every membership-based flag (already flagged by rolsuper).
  test.each([
    ['plain', 'g_plain', undefined, [false, false, false, false]],
    ['pg_execute_server_program member', 'g_prog', undefined, [false, true, false, false]],
    ['pg_write_server_files member', 'g_wfiles', undefined, [false, true, false, false]],
    ['pg_read_server_files member', 'g_rfiles', undefined, [false, true, false, false]],
    ['pg_write_all_data member', 'g_wall', undefined, [false, true, false, false]],
    ['pg_read_all_data member', 'g_rall', undefined, [false, true, false, false]],
    ['NOINHERIT member (SET ROLE still works)', 'g_noinherit_prog', undefined, [false, true, false, false]],
    ['indirect member through a plain parent', 'g_prog_child', undefined, [false, true, false, false]],
    ['member current_user under a superuser session login', 'g_super', 'g_prog', [false, true, false, true]],
    ['session_user is a member of a dangerous built-in role, current_user is a plain role it belongs to', 'g_sess_prog', 'g_sess_plain',
      [false, true, false, false]],
    ['CREATEROLE on the real (PG18) server: not flagged', 'g_createrole', undefined, [false, false, false, false]],
    ['REPLICATION login', 'g_repl', undefined, [false, false, false, true]],
    ['member of a NOLOGIN REPLICATION role', 'g_repl_member', undefined, [false, false, false, true]],
    ['NOINHERIT member of a REPLICATION role (SET ROLE still works)', 'g_repl_noinherit', undefined, [false, false, false, true]],
    ['indirect member of a REPLICATION role', 'g_repl_grandchild', undefined, [false, false, false, true]],
    ['REPLICATION current_user under a plain session login that is a member of the role',
      'g_repl_member', 'g_repl_parent', [false, false, false, true]],
    ['session_user has REPLICATION, current_user is a plain role it belongs to', 'g_sess_repl', 'g_sess_plain',
      [false, false, false, true]],
    ['GRANT ... WITH INHERIT FALSE', 'g_opt_inherit_false', undefined, [false, true, false, false]],
    ['GRANT ... WITH SET FALSE', 'g_opt_set_false', undefined, [false, true, false, false]],
    ['GRANT ... WITH ADMIN OPTION, INHERIT FALSE, SET FALSE', 'g_opt_admin_both_false', undefined, [false, true, false, false]],
  ])('%s', async (_name, sessionRole, setRole, expected) => {
    expect(escalation(await probe(sessionRole, setRole))).toEqual(expected);
  });

  test.each([
    ['CREATEROLE', 'g_createrole', true],
    ['plain', 'g_plain', false],
    ['superuser (a member of every role, so of every CREATEROLE role; also flagged by rolsuper)', 'g_super', true],
  ])('statement for a PG15 server, %s: system_user is not read', async (_name, sessionRole, expected) => {
    const row = await probe(sessionRole, undefined, { version: '150000' });
    expect([row.createrole_escalation, row.session_authorization_masked]).toEqual([expected, false]);
  });

  // Below PG16 CREATEROLE lets a role grant itself any role. The attribute is not inherited, but a member can SET ROLE to
  // the holder, and a CREATEROLE session login can RESET ROLE back after SET ROLE to a NOCREATEROLE parent.
  test.each([
    ['CREATEROLE session login, no SET ROLE', 'g_cr_member', undefined],
    ['CREATEROLE session login after SET ROLE to its NOCREATEROLE parent (RESET ROLE undoes it)', 'g_cr_member', 'g_cr_parent'],
    ['NOCREATEROLE login that is a member of a NOLOGIN CREATEROLE role', 'g_cr_via_holder', undefined],
    ['indirect member of a CREATEROLE role', 'g_cr_grandchild', undefined],
  ])('PG15 statement, %s: createrole_escalation is true', async (_name, sessionRole, setRole) => {
    expect((await probe(sessionRole, setRole, { version: '150000' })).createrole_escalation).toBe(true);
  });

  // PGlite has no authentication step, so system_user is replaced with a literal standing in for PG16+.
  test.each([
    ['session login equals the authenticated login', 'g_plain', undefined, 'scram-sha-256:g_plain', false],
    ['the method prefix is whatever precedes the first colon', 'g_plain', undefined, 'password:g_plain', false],
    ['SET SESSION AUTHORIZATION masks the authenticated login', 'g_plain', undefined, 'scram-sha-256:g_super', true],
    ['SET ROLE does not mask: session_user stays the login', 'g_super', 'g_plain', 'scram-sha-256:g_super', false],
    ['no authenticated identity (system_user NULL) cannot be compared', 'g_plain', undefined, undefined, false],
  ])('PG16+ statement: %s', async (_name, sessionRole, setRole, systemUser, expected) => {
    const row = systemUser === undefined
      ? await probe(sessionRole, setRole)
      : await probe(sessionRole, setRole, { systemUser });
    expect(row.session_authorization_masked).toBe(expected);
  });

  // 160000 is the first server_version_num that has system_user: a masked session is detected exactly there.
  test('a PG16.0 server (version 160000) detects a masked session login', async () => {
    const row = await probe('g_plain', undefined, { version: '160000', systemUser: 'scram-sha-256:g_super' });
    expect(row.session_authorization_masked).toBe(true);
  });

  test('is a read-only probe: the transaction is rolled back and the session is usable afterwards', async () => {
    await probe('g_plain');
    expect(await exec('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  // The deliberately unflagged predefined roles (settled decision; see dangerous_builtin_role_member): none sets a flag.
  test('a member of pg_monitor, pg_read_all_stats, pg_read_all_settings, pg_stat_scan_tables, pg_signal_backend, pg_create_subscription, pg_maintain, pg_checkpoint and pg_use_reserved_connections is not flagged', async () => {
    const row = await probe('g_unflagged');
    expect(pick(row)).toEqual(['g_unflagged', 'g_unflagged', false, false, false, false]);
    expect(escalation(row)).toEqual([false, false, false, false]);
  });

  // A role's own search_path (ALTER ROLE ... SET search_path) is applied when it logs in; PGlite has no login, so a
  // session SET stands in for it. The probe must read the real catalog whatever the session says.
  describe('names the probed role can shadow', () => {
    const COLUMNS = 'oid, rolname, false AS rolsuper, false AS rolbypassrls, false AS rolcreaterole, false AS rolreplication';

    test('public.pg_roles and public.pg_has_role created by a role with CREATE on public and its own search_path do not hide its memberships', async () => {
      await exec(`SET SESSION AUTHORIZATION g_shadow;
        CREATE VIEW public.pg_roles AS SELECT ${COLUMNS} FROM pg_catalog.pg_roles;
        GRANT SELECT ON public.pg_roles TO PUBLIC;
        CREATE FUNCTION public.pg_has_role(name, oid, text) RETURNS boolean LANGUAGE sql AS 'SELECT false';
        RESET SESSION AUTHORIZATION`);
      try {
        const pool = poolFor('g_shadow', undefined, { sessionSql: 'SET search_path = public, pg_catalog' });
        // Control: in that session the shadows answer for the probe's names.
        const client = await pool.connect();
        const parent = "(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'g_shadow_parent')";
        expect((await client.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolreplication')).rows).toEqual([{ n: 0 }]);
        expect((await client.query(`SELECT pg_has_role(current_user, ${parent}, 'MEMBER') AS member`)).rows).toEqual([{ member: false }]);
        expect((await client.query(`SELECT pg_catalog.pg_has_role(current_user, ${parent}, 'MEMBER') AS member`)).rows).toEqual([{ member: true }]);

        const row = await probeDbRole(pool);
        expect(escalation(row)).toEqual([false, true, false, true]);
      } finally {
        await exec('RESET SESSION AUTHORIZATION; RESET search_path; DROP VIEW public.pg_roles; DROP FUNCTION public.pg_has_role(name, oid, text)');
      }
    });

    // bool_or is resolved by name too. The shadow aggregate answers false whatever it is given. With it in the way the
    // probe's row filter (HAVING bool_or(rolname = current_user)) drops the row, so an unpinned probe rejects with
    // "role row missing" instead of reporting rolbypassrls and session_user_privileged: the pin is what keeps the real
    // aggregate.
    test('a public.bool_or(boolean) aggregate that always answers false does not hide rolbypassrls or session_user_privileged', async () => {
      try {
        await exec(`SET SESSION AUTHORIZATION g_shadow_bypass;
          CREATE FUNCTION public.shadow_bool_or_step(boolean, boolean) RETURNS boolean LANGUAGE sql AS 'SELECT false';
          CREATE AGGREGATE public.bool_or(boolean) (SFUNC = public.shadow_bool_or_step, STYPE = boolean, INITCOND = 'f');
          RESET SESSION AUTHORIZATION`);
        const pool = poolFor('g_shadow_bypass', undefined, { sessionSql: 'SET search_path = public, pg_catalog' });
        // Control: in that session the shadow answers for the probe's name, the catalog aggregate does not.
        const client = await pool.connect();
        const flag = "FROM pg_catalog.pg_roles WHERE rolname = 'g_shadow_bypass'";
        expect((await client.query(`SELECT bool_or(rolbypassrls) AS v ${flag}`)).rows).toEqual([{ v: false }]);
        expect((await client.query(`SELECT pg_catalog.bool_or(rolbypassrls) AS v ${flag}`)).rows).toEqual([{ v: true }]);

        const row = await probeDbRole(pool);
        expect(pick(row)).toEqual(['g_shadow_bypass', 'g_shadow_bypass', false, true, true, false]);
      } finally {
        await exec(`RESET SESSION AUTHORIZATION; RESET search_path;
          DROP AGGREGATE IF EXISTS public.bool_or(boolean); DROP FUNCTION IF EXISTS public.shadow_bool_or_step(boolean, boolean)`);
      }
    });

    // system_user exists from PostgreSQL 16 on; the probe only reads substr and strpos there. PGlite reports no
    // authenticated identity, so system_user is replaced with a literal (see poolFor).
    const systemUserAvailable = async (): Promise<boolean> => {
      const [{ server_version_num: version }] = await exec('SHOW server_version_num') as Array<{ server_version_num: string }>;
      if (Number(version) >= 160000) return true;
      console.warn(`skipped: server_version_num ${version} has no system_user, so the probe never reads substr or strpos`);
      return false;
    };

    test('a public.substr(text, int) that returns the session login does not hide a masked session login', async () => {
      if (!await systemUserAvailable()) return;
      try {
        await exec(`SET SESSION AUTHORIZATION g_shadow;
          CREATE FUNCTION public.substr(text, int) RETURNS text LANGUAGE sql AS 'SELECT session_user::text';
          RESET SESSION AUTHORIZATION`);
        // The authenticated login is g_super, the session login g_shadow: masked.
        const pool = poolFor('g_shadow', undefined,
          { sessionSql: 'SET search_path = public, pg_catalog', systemUser: 'scram-sha-256:g_super' });
        const client = await pool.connect();
        expect((await client.query("SELECT substr('scram-sha-256:g_super'::text, 15) AS v")).rows).toEqual([{ v: 'g_shadow' }]);
        expect((await client.query("SELECT pg_catalog.substr('scram-sha-256:g_super'::text, 15) AS v")).rows).toEqual([{ v: 'g_super' }]);

        expect((await probeDbRole(pool)).session_authorization_masked).toBe(true);
      } finally {
        await exec('RESET SESSION AUTHORIZATION; RESET search_path; DROP FUNCTION IF EXISTS public.substr(text, int)');
      }
    });

    // The authenticated identity 'a:b:g_shadow' (a method prefix and a colon inside the identity) is not the session login
    // g_shadow: masked. Cutting after the first colon leaves 'b:g_shadow'; a shadow strpos that points at the last colon
    // makes the remainder equal the session login.
    test('a public.strpos(text, text) that points past the identity prefix does not hide a masked session login', async () => {
      if (!await systemUserAvailable()) return;
      try {
        await exec(`SET SESSION AUTHORIZATION g_shadow;
          CREATE FUNCTION public.strpos(text, text) RETURNS int LANGUAGE sql AS 'SELECT length($1) - length(session_user::text)';
          RESET SESSION AUTHORIZATION`);
        const pool = poolFor('g_shadow', undefined,
          { sessionSql: 'SET search_path = public, pg_catalog', systemUser: 'a:b:g_shadow' });
        const client = await pool.connect();
        expect((await client.query("SELECT strpos('a:b:g_shadow'::text, ':') AS v")).rows).toEqual([{ v: 4 }]);
        expect((await client.query("SELECT pg_catalog.strpos('a:b:g_shadow'::text, ':') AS v")).rows).toEqual([{ v: 2 }]);

        expect((await probeDbRole(pool)).session_authorization_masked).toBe(true);
      } finally {
        await exec('RESET SESSION AUTHORIZATION; RESET search_path; DROP FUNCTION IF EXISTS public.strpos(text, text)');
      }
    });

    // Without a search_path of its own a session still searches pg_temp before pg_catalog for relations, and TEMP on the
    // database is granted to PUBLIC by default, so no CREATE on any schema is needed to shadow pg_roles this way.
    // Functions are never resolved through pg_temp implicitly, so only the view can be shadowed.
    test('a temp view named pg_roles does not hide a REPLICATION membership (pg_temp is searched last)', async () => {
      await exec(`SET SESSION AUTHORIZATION g_repl_member;
        CREATE TEMP VIEW pg_roles AS SELECT ${COLUMNS} FROM pg_catalog.pg_roles;
        RESET SESSION AUTHORIZATION`);
      try {
        const pool = poolFor('g_repl_member');
        const client = await pool.connect();
        expect((await client.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolreplication')).rows).toEqual([{ n: 0 }]);

        expect(escalation(await probeDbRole(pool))).toEqual([false, false, false, true]);
      } finally {
        await exec('RESET SESSION AUTHORIZATION; DROP VIEW pg_temp.pg_roles');
      }
    });
  });
});

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@cmdb/common', () => ({ logger }));

import { checkDbRole, requireNonSuperuser, type DbRolePool } from '../db-role-guard';

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

const role = (rolsuper: boolean, rolbypassrls: boolean) =>
  ({ row: { current_user: 'cmdb_x', rolsuper, rolbypassrls } });
const logged = () => JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
const OFF = {} as NodeJS.ProcessEnv;
const ON = { REQUIRE_NON_SUPERUSER_DB: 'true' } as NodeJS.ProcessEnv;

beforeEach(() => jest.clearAllMocks());

describe('checkDbRole', () => {
  test('NOSUPERUSER and NOBYPASSRLS: one info line with the role and both flags, no error', async () => {
    await expect(checkDbRole(fakePool(role(false, false)).pool, ON)).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][1]).toEqual({ current_user: 'cmdb_x', rolsuper: false, rolbypassrls: false });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each([[true, true], [true, false], [false, true]])(
    'rolsuper=%s rolbypassrls=%s with enforcement off: error line naming role and flags, startup continues',
    async (rolsuper, rolbypassrls) => {
      await expect(checkDbRole(fakePool(role(rolsuper, rolbypassrls)).pool, OFF)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toMatch(/ignores row level security and grants/);
      expect(logger.error.mock.calls[0][1]).toEqual({ current_user: 'cmdb_x', rolsuper, rolbypassrls });
      expect(logger.info).not.toHaveBeenCalled();
    });

  test.each([[true, true], [true, false], [false, true]])(
    'rolsuper=%s rolbypassrls=%s with REQUIRE_NON_SUPERUSER_DB=true: refuses, naming the role and flags',
    async (rolsuper, rolbypassrls) => {
      await expect(checkDbRole(fakePool(role(rolsuper, rolbypassrls)).pool, ON))
        .rejects.toThrow(`"cmdb_x" (rolsuper=${rolsuper}, rolbypassrls=${rolbypassrls})`);
      expect(logger.info).not.toHaveBeenCalled();
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
      expect.stringMatching(/^SELECT current_user::text AS current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user$/),
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
        return { rows: [{ current_user: 'a', rolsuper: false, rolbypassrls: false }] };
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

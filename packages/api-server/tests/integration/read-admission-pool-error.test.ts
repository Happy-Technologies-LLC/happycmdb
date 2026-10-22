// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-851, real PG/Neo4j: a terminated isolated read-admission backend (idle, or checked out while a pessimistic read is held
// across Neo4j) never crashes the process (jest-circus fails the running test on an uncaught pg 'error') nor yields a stale read.
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { logger } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { CIListUnavailableError, readCIList } from '../../src/read-admission';

const [A, B] = [randomUUID(), randomUUID()];
const IDLE: unknown = 'Read admission idle PostgreSQL client error'; // unknown: winston's warn overloads type call[0] as object
const rows = async (text: string, params: unknown[] = []) => (await getPostgresClient().query(text, params)).rows;
// Real-time poll (5 s max): backend exit and the pool's socket error are only observable from outside, not awaitable.
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let wait = 0; wait < 100 && !(await check()); wait++) await sleep(50);
};
const TAGGED = `FROM pg_stat_activity WHERE application_name = 'cmdb-read-admission' AND datname = current_database()`;
const terminateTagged = async () => {
  expect((await rows(`SELECT pg_terminate_backend(pid) ${TAGGED}`)).length).toBeGreaterThan(0);
  await until(async () => (await rows(`SELECT pid ${TAGGED}`)).length === 0);
  expect(await rows(`SELECT pid ${TAGGED}`)).toEqual([]);
};
const forced = (org: string, held = async () => {}) => { // X-29 pattern: an epoch bump in read 1 holds read 2 in the isolated pool
  let calls = 0;
  return readCIList(org, async () => {
    if (++calls === 1) await rows(`INSERT INTO ci_reconciliation_epochs (organization_id, epoch) VALUES ($1, 1)
      ON CONFLICT (organization_id) DO UPDATE SET epoch = ci_reconciliation_epochs.epoch + 1`, [org]);
    else { await held(); const session = getNeo4jClient().getSession(); await session.run('RETURN 1').finally(() => session.close()); }
    return calls;
  });
};
afterAll(() => rows('DELETE FROM ci_reconciliation_epochs WHERE organization_id = ANY($1::uuid[])', [[A, B]]));

it('idle tagged backend loss is logged by SQLSTATE only; the next forced A read succeeds', async () => {
  const warn = jest.spyOn(logger, 'warn');
  await expect(forced(A)).resolves.toBe(2);
  await terminateTagged();
  await until(() => warn.mock.calls.some(call => call[0] === IDLE));
  const logged = warn.mock.calls.filter(call => call[0] === IDLE);
  expect(logged).toStrictEqual([...Array(Math.max(1, logged.length))].map(() => [IDLE, { code: '57P01' }]));
  await expect(forced(A)).resolves.toBe(2);
});

it('checked-out loss across Neo4j is a 503 class, never a stale success; B and the next A read succeed', async () => {
  let other: Promise<number> | undefined;
  await expect(forced(A, async () => { await terminateTagged(); other = forced(B); await other; })).rejects.toBeInstanceOf(CIListUnavailableError);
  await expect(other).resolves.toBe(2);
  await expect(forced(A)).resolves.toBe(2);
});

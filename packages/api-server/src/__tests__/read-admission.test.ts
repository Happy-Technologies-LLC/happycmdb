// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const query = jest.fn();
const admissionQuery = jest.fn();
const release = jest.fn();
const connect = jest.fn(() => Promise.resolve({ query: admissionQuery, release }));
jest.mock('pg', () => ({ Pool: class { connect() { return connect(); } } }));
jest.mock('@cmdb/database', () => ({ getPostgresClient: () => ({ query, pool: { options: {} } }) }));

import { readCIList, CIListUnavailableError } from '../read-admission';
beforeEach(() => {
  connect.mockImplementation(() => Promise.resolve({ query: admissionQuery, release }));
  release.mockClear();
});

test('an epoch change discards optimistic page and reruns with pending ids under a share lock', async () => {
  query.mockReset();
  admissionQuery.mockReset();
  query.mockResolvedValueOnce({ rows: [{ epoch: '0', pending: [] }] })
    .mockResolvedValueOnce({ rows: [{ epoch: '1', pending: ['ci-new'] }] });
  admissionQuery.mockImplementation(async (sql: string) => sql.includes('SELECT ci_id')
    ? { rows: [{ ci_id: 'ci-new' }] } : { rows: [] });
  const read = jest.fn(async (pending: string[]) => pending.length
    ? { total: 0, page: [] } : { total: 1, page: ['ci-new'] });
  expect(await readCIList('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', read)).toEqual({ total: 0, page: [] });
  expect(read.mock.calls.map(([pending]) => pending)).toEqual([[], ['ci-new']]);
  expect(admissionQuery.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
  expect(release).toHaveBeenCalledTimes(1);
});

test('per-org cap refuses a third pessimistic request without queueing it', async () => {
  query.mockReset();
  admissionQuery.mockReset();
  query.mockImplementation(async () => ({ rows: [{ epoch: String(query.mock.calls.length), pending: [] }] }));
  const { promise: blocked, resolve: unblock } = Promise.withResolvers<void>();
  admissionQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT ci_id')) await blocked;
    return { rows: [] };
  });
  const org = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const first = readCIList(org, async () => ({ total: 0, page: [] }));
  const second = readCIList(org, async () => ({ total: 0, page: [] }));
  await (await import('timers/promises')).setImmediate();
  await expect(readCIList(org, async () => ({ total: 0, page: [] }))).rejects.toBeInstanceOf(CIListUnavailableError);
  unblock();
  await Promise.all([first, second]);
});

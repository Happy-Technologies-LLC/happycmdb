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

test('out-of-order fallback completion preserves the cap and releases both slots', async () => {
  query.mockReset();
  admissionQuery.mockReset();
  query.mockImplementation(async () => ({ rows: [{ epoch: String(query.mock.calls.length), pending: [] }] }));
  admissionQuery.mockResolvedValue({ rows: [] });
  const gates = Array.from({ length: 7 }, () => Promise.withResolvers<void>());
  const org = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const start = (index: number) => {
    let optimistic = true;
    return readCIList(org, async () => {
      if (optimistic) {
        optimistic = false;
        return index;
      }
      await gates[index]!.promise;
      return index;
    });
  };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const requests = [start(0), start(1)];
  try {
    await flush();
    gates[1]!.resolve();
    expect(await requests[1]).toBe(1);
    requests.push(start(2));
    await flush();
    gates[0]!.resolve();
    expect(await requests[0]).toBe(0);
    requests.push(start(3));
    await flush();
    gates[4]!.resolve();
    const overflow = start(4);
    requests.push(overflow);
    await expect(overflow).rejects.toBeInstanceOf(CIListUnavailableError);
    gates[3]!.resolve();
    gates[2]!.resolve();
    expect(await Promise.all([requests[2], requests[3]])).toEqual([2, 3]);
    requests.push(start(5), start(6));
    await flush();
    gates[5]!.resolve();
    gates[6]!.resolve();
    expect(await Promise.all([requests[5], requests[6]])).toEqual([5, 6]);
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(requests);
  }
});

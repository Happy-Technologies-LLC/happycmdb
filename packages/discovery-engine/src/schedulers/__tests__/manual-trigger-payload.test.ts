// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-774 S8 follow-up: scheduler job builders queue a credential-free config and refuse unsafe
// stored config before enqueue. Only the queue manager and the DB pool are mocked.
const SENTINEL = ['V', 'S8', 'FU', String(new Date(0).getUTCFullYear())].join('-');
const FORBIDDEN = /credential|password|passphrase|privatekey|secret/i;
const keysDeep = (value: unknown): string[] => (value && typeof value === 'object'
  ? Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]) : []);
const mockAdded: Array<[string, string, Record<string, unknown>, unknown]> = [];
let mockRow: Record<string, unknown>;
jest.mock('@cmdb/common', () => {
  const { getDiscoveryQueueNames, QUEUE_NAMES } = jest.requireActual('@cmdb/common/queues/queue-config');
  return {
    ...jest.requireActual('@cmdb/common/utils/discovery-scan-config'),
    getDiscoveryQueueNames, QUEUE_NAMES,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    getQueueManager: () => ({
      addJob: async (queue: string, name: string, data: Record<string, unknown>, opts: unknown) => {
        mockAdded.push([queue, name, data, opts]);
        return { id: 'job-1' };
      },
      addRepeatableJob: async (queue: string, name: string, data: Record<string, unknown>, opts: unknown) => {
        mockAdded.push([queue, name, data, opts]);
      },
      getQueue: () => ({ getRepeatableJobs: async () => [{ name: 'discovery-definition-d1', key: 'k1' }] }),
    }),
  };
});
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: { query: async () => ({ rows: [mockRow] }) } }),
  getScheduleConfigStore: () => ({}),
}));

import { DiscoveryScheduler } from '../discovery-scheduler';

beforeEach(() => { mockAdded.length = 0; });
afterEach(() => {
  expect(keysDeep(mockAdded).filter((key) => FORBIDDEN.test(key))).toEqual([]);
  expect(JSON.stringify(mockAdded)).not.toContain(SENTINEL);
});

it('triggerDiscovery strips credentials and credentialsId from the queued _config', async () => {
  const input = { targets: ['192.0.2.20'], credentials: { password: SENTINEL }, credentialsId: SENTINEL };
  await expect(new DiscoveryScheduler(undefined, false).triggerDiscovery('nmap', input, 'u', 'org')).resolves.toBe('job-1');
  expect(mockAdded).toHaveLength(1);
  expect(mockAdded[0][2]._config).toStrictEqual({ targets: ['192.0.2.20'] });
});

it.each([
  ['valid', 1, { targets: ['192.0.2.21'] }],
  ['inline credentials', 0, { targets: ['192.0.2.21'], credentials: { password: SENTINEL } }],
])('scheduleDefinition with %s stored config queues %d credential-free jobs', async (_shape, queued, config) => {
  mockRow = { id: 'd1', provider: 'nmap', config, schedule: '0 3 * * *', is_active: true };
  const scheduling = new DiscoveryScheduler(undefined, false).scheduleDefinition('d1', 'org');
  await (queued ? expect(scheduling).resolves.toBeUndefined() : expect(scheduling).rejects.toThrow(/Unsafe legacy/));
  expect(mockAdded.map(([, , data]) => data.config)).toStrictEqual(queued ? [config] : []);
});

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-774 S4 (C-9): a fresh scheduler reconciles against the repeatables actually in the queues.
const MARKER = 'SENSITIVE-S4-MARKER';
const mockRepeatables = new Map<string, Map<string, string>>(); // queue -> repeatable key -> name
const mockRemoved: string[] = [];
const mockTouched: string[] = []; // job data reads and any queue API beyond the repeatable list/remove
const mockLogs: unknown[] = [];
const mockJobs = (queue: string) => mockRepeatables.get(queue) ?? mockRepeatables.set(queue, new Map()).get(queue)!;
const mockQueue = (queue: string) => new Proxy<Record<string, unknown>>({
  getRepeatableJobs: async () => Array.from(mockJobs(queue), ([key, name]) => ({
    key, name, get data() { mockTouched.push('job.data'); return { password: MARKER }; },
  })),
  removeRepeatableByKey: async (key: string) => { mockRemoved.push(`${queue} ${key}`); return mockJobs(queue).delete(key); },
}, { get: (api, prop: string) => (prop in api ? api[prop] : (mockTouched.push(`queue.${prop}`), undefined)) });
const mockRows = [
  { id: 'valid', organization_id: 'org-a', provider: 'nmap', config: { targets: ['192.0.2.1'] }, schedule: '0 3 * * *', is_active: true },
  { id: 'quarantined', organization_id: 'org-a', provider: 'nmap', config: { targets: ['192.0.2.2'], password: MARKER }, schedule: '0 4 * * *', is_active: true },
  { id: 'disabled', organization_id: 'org-a', provider: 'nmap', config: { targets: ['192.0.2.3'] }, schedule: '0 6 * * *', is_active: false },
];

jest.mock('@cmdb/common', () => {
  const record = (...args: unknown[]) => { mockLogs.push(args); };
  const { getDiscoveryQueueNames, QUEUE_NAMES } = jest.requireActual('@cmdb/common/queues/queue-config');
  return {
    ...jest.requireActual('@cmdb/common/utils/discovery-scan-config'),
    getDiscoveryQueueNames, QUEUE_NAMES,
    logger: { info: record, warn: record, error: record, debug: record },
    getQueueManager: () => ({ getQueue: mockQueue, addRepeatableJob: async (queue: string, name: string, _data: unknown, opts: { pattern: string }) =>
      mockJobs(queue).set(`${name}:${opts.pattern}`, name) }),
  };
});
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: { query: async (sql: string, params?: string[]) => ({ rows: mockRows.filter((row) =>
    (params ? row.id === params[0] : true) && (row.is_active || !sql.includes('is_active = true'))) }) } }),
  getScheduleConfigStore: () => ({ seedIfAbsent: async (_kind: string, _provider: string, seed: unknown) => seed }),
}));

import { DiscoveryScheduler } from '../discovery-scheduler';

it.each(['syncSchedules', 'start'] as const)('%s removes deleted, quarantined, disabled and provider-level repeatables, keeps valid ones, reads keys only', async (entry) => {
  mockRepeatables.clear();
  mockRemoved.length = mockTouched.length = mockLogs.length = 0;
  const nmap = mockJobs('discovery-nmap');
  ['valid:0 3 * * *', 'quarantined:0 4 * * *', 'deleted:0 5 * * *', 'disabled:0 6 * * *'].forEach((k) => nmap.set(`discovery-definition-${k}`, `discovery-definition-${k.split(':')[0]}`));
  nmap.set('discovery-nmap::::0 2 * * *', 'discovery-nmap');

  const scheduler = new DiscoveryScheduler(undefined, true);
  await scheduler[entry]();
  expect(mockRemoved).toEqual(expect.arrayContaining([
    'discovery-nmap discovery-definition-quarantined:0 4 * * *',
    'discovery-nmap discovery-definition-deleted:0 5 * * *',
    'discovery-nmap discovery-definition-disabled:0 6 * * *',
    'discovery-nmap discovery-nmap::::0 2 * * *',
  ]));
  expect(Array.from(nmap.keys())).toEqual(['discovery-definition-valid:0 3 * * *']);

  mockRemoved.length = 0;
  await scheduler.syncSchedules();
  expect(mockRemoved).toEqual([]);
  expect(mockTouched).toEqual([]);
  expect(JSON.stringify(mockLogs)).not.toContain(MARKER);
  expect(scheduler.getSchedules().map((schedule) => schedule._config)).toEqual([{}, {}]); // C-10: no `_targets` default
});

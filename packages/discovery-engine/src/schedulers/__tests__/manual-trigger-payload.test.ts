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
let mockQueryRows: Array<Record<string, unknown>> | undefined;
const mockLogged: Array<[string, Record<string, any> | undefined]> = [];
jest.mock('@cmdb/common', () => {
  const { getDiscoveryQueueNames, QUEUE_NAMES } = jest.requireActual('@cmdb/common/queues/queue-config');
  return {
    ...jest.requireActual('@cmdb/common/utils/discovery-scan-config'),
    getDiscoveryQueueNames, QUEUE_NAMES,
    logger: {
      info: (...args: any[]) => { mockLogged.push(['info', args[1]]); },
      warn: (...args: any[]) => { mockLogged.push(['warn', args[1]]); },
      error: (...args: any[]) => { mockLogged.push(['error', args[1]]); },
      debug: () => undefined,
    },
    getQueueManager: () => ({
      addJob: async (queue: string, name: string, data: Record<string, unknown>, opts: unknown) => {
        mockAdded.push([queue, name, data, opts]);
        return { id: 'job-1' };
      },
      addRepeatableJob: async (queue: string, name: string, data: Record<string, unknown>, opts: unknown) => {
        mockAdded.push([queue, name, data, opts]);
      },
      getQueue: () => ({ getRepeatableJobs: async () => [{ name: 'discovery-definition-d1', key: 'k1' }], removeRepeatableByKey: async () => undefined }),
    }),
  };
});
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: { query: async () => ({ rows: mockQueryRows ?? [mockRow] }) } }),
  getScheduleConfigStore: () => ({ seedIfAbsent: async (_kind: string, _provider: string, seed: unknown) => seed }),
}));

import { DiscoveryScheduler } from '../discovery-scheduler';

beforeEach(() => { mockAdded.length = 0; mockLogged.length = 0; });
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

const providerSchedule = (provider: 'nmap' | 'ssh', config: unknown) =>
  ({ _provider: provider, _queueName: `discovery-${provider}`, _cronPattern: '0 2 * * *', _enabled: true, _config: config });

it('start() schedules the provider repeatable with a credential-free _config', async () => {
  const config = { targets: ['192.0.2.22'], credentials: { password: SENTINEL }, credentialsId: SENTINEL, password: SENTINEL };
  await expect(new DiscoveryScheduler([providerSchedule('nmap', config)], false).start()).resolves.toBeUndefined();
  expect(mockAdded).toHaveLength(1);
  expect(mockAdded[0].slice(0, 2)).toEqual(['discovery-nmap', 'discovery-nmap']);
  expect(mockAdded[0][2]._config).toStrictEqual({ targets: ['192.0.2.22'] });
});

it('ssh provider schedules are refused before any addRepeatableJob', async () => {
  const ssh = providerSchedule('ssh', { targets: ['192.0.2.23'] });
  const scheduler = new DiscoveryScheduler([ssh], false);
  await expect(scheduler.start()).resolves.toBeUndefined();
  // Every public caller pre-filters ssh, so the builder's own refusal is reached directly.
  await expect(scheduler['scheduleDiscoveryJob'](ssh))
    .rejects.toThrow(/^Credential-backed discovery execution is unavailable$/);
  expect(mockAdded).toEqual([]);
});

describe('HAP-1737: non-JSON stored definition config fails closed', () => {
  const corrupt = `{"targets": ["192.0.2.30"], "note": "${SENTINEL}"`;

  it('scheduleDefinition refuses with the unsafe-legacy error, not a raw SyntaxError, and queues nothing', async () => {
    mockRow = { id: 'd1', provider: 'nmap', config: corrupt, schedule: '0 3 * * *', is_active: true };
    const failure = await new DiscoveryScheduler(undefined, false).scheduleDefinition('d1', 'org').then(
      () => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('Error');
    expect((failure as Error).message).toBe('Unsafe legacy discovery configuration requires migration');
    expect(mockAdded).toEqual([]);
  });

  it('syncSchedules skips the corrupt row, schedules the valid one, and logs no config text', async () => {
    const rows = [
      { id: 'bad', provider: 'nmap', config: corrupt, schedule: '0 3 * * *', is_active: true, organization_id: 'org' },
      { id: 'good', provider: 'nmap', config: JSON.stringify({ targets: ['192.0.2.31'] }), schedule: '0 4 * * *', is_active: true, organization_id: 'org' },
    ];
    mockQueryRows = rows;
    const scheduler = new DiscoveryScheduler(undefined, true);
    const scheduled: string[] = [];
    jest.spyOn(scheduler, 'scheduleDefinition').mockImplementation(async (id: string) => { scheduled.push(id); });
    try {
      await scheduler.syncSchedules();
    } finally {
      mockQueryRows = undefined;
    }
    expect(scheduled).toEqual(['good']);
    expect(mockLogged.filter(([, meta]) => meta && 'definitionId' in meta).map(([, meta]) => meta.definitionId)).toEqual(['bad']);
    expect(JSON.stringify(mockLogged)).not.toContain(SENTINEL);
    expect(JSON.stringify(mockLogged)).not.toMatch(/JSON|position|token/i);
  });
});

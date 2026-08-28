// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Scheduler - Shared Redis-Backed Persistence Tests
 *
 * Verifies that provider-level schedule config (cron/enabled/config) is shared truth across
 * independent DiscoveryScheduler instances - simulating separate processes (e.g. the API server
 * and a worker) - via the Redis-backed ScheduleConfigStore in @cmdb/database, instead of living
 * only in each instance's private in-memory map.
 *
 * @cmdb/database is intentionally left unmocked so the real ScheduleConfigStore/RedisClient code
 * runs; only the underlying `ioredis` transport and @cmdb/common's BullMQ queue manager are
 * faked, each backed by a single in-memory store shared by every scheduler instance in this file
 * - mirroring how every real process shares the same physical Redis.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// --- Fake Redis (backs @cmdb/database's RedisClient -> ScheduleConfigStore) ---
const redisStore = new Map<string, string>();

class FakeRedis {
  on(): void {
    // no-op: RedisClient wires 'error'/'connect' listeners we don't need to simulate
  }
  async get(key: string): Promise<string | null> {
    return redisStore.has(key) ? redisStore.get(key)! : null;
  }
  async set(key: string, value: string, mode?: string): Promise<string | null> {
    if (mode === 'NX') {
      if (redisStore.has(key)) {
        return null;
      }
      redisStore.set(key, value);
      return 'OK';
    }
    redisStore.set(key, value);
    return 'OK';
  }
  async setex(key: string, _seconds: number, value: string): Promise<void> {
    redisStore.set(key, value);
  }
  async del(...keys: string[]): Promise<void> {
    keys.forEach((key) => redisStore.delete(key));
  }
  async keys(): Promise<string[]> {
    return Array.from(redisStore.keys());
  }
  async quit(): Promise<void> {
    // no-op
  }
  duplicate(): FakeRedis {
    return this;
  }
  async publish(): Promise<number> {
    return 0;
  }
}

jest.mock('ioredis', () => jest.fn().mockImplementation(() => new FakeRedis()));

// --- Fake BullMQ queue manager (backs @cmdb/common's getQueueManager) ---
interface FakeRepeatableJob {
  name: string;
  key: string;
}
const repeatablesByQueue = new Map<string, Map<string, FakeRepeatableJob>>();

function fakeQueue(queueName: string) {
  if (!repeatablesByQueue.has(queueName)) {
    repeatablesByQueue.set(queueName, new Map());
  }
  const jobs = repeatablesByQueue.get(queueName)!;
  return {
    async getRepeatableJobs(): Promise<FakeRepeatableJob[]> {
      return Array.from(jobs.values());
    },
    async removeRepeatableByKey(key: string): Promise<void> {
      jobs.delete(key);
    },
  };
}

const fakeQueueManager = {
  getQueue: jest.fn((queueName: string) => fakeQueue(queueName)),
  async addRepeatableJob(
    queueName: string,
    jobName: string,
    _data: unknown,
    opts: { pattern?: string }
  ): Promise<{ id: string }> {
    if (!repeatablesByQueue.has(queueName)) {
      repeatablesByQueue.set(queueName, new Map());
    }
    const jobs = repeatablesByQueue.get(queueName)!;
    const key = `${jobName}:${opts.pattern}`;
    jobs.set(key, { name: jobName, key });
    return { id: key };
  },
};

jest.mock('@cmdb/common', () => ({
  getQueueManager: jest.fn(() => fakeQueueManager),
  QUEUE_NAMES: {
    _DISCOVERY_SSH: 'discovery-ssh',
    _DISCOVERY_NMAP: 'discovery-nmap',
  },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { DiscoveryScheduler } from '../../src/schedulers/discovery-scheduler';

function hasRepeatable(queueName: string, jobName: string): boolean {
  const jobs = repeatablesByQueue.get(queueName);
  if (!jobs) {
    return false;
  }
  return Array.from(jobs.values()).some((job) => job.name === jobName);
}

// Every test constructs its DiscoveryScheduler instances with explicit, freshly-allocated
// schedule objects rather than relying on the module's DEFAULT_SCHEDULES fallback - the default
// path shares object references across instances constructed in the same process, which would
// make cross-instance visibility trivially true regardless of whether the Redis-backed store
// actually works. Passing distinct objects forces every assertion below to be proven only
// through the shared store.
function freshDiscoverySchedules() {
  return [
    {
      _provider: 'ssh' as const,
      _queueName: 'discovery-ssh',
      _cronPattern: '0 * * * *',
      _enabled: true,
      _config: { _targets: [] as string[] },
    },
    {
      _provider: 'nmap' as const,
      _queueName: 'discovery-nmap',
      _cronPattern: '0 2 * * *',
      _enabled: true,
      _config: { _targets: [] as string[] },
    },
  ];
}

describe('DiscoveryScheduler - shared Redis-backed schedule persistence', () => {
  beforeEach(() => {
    redisStore.clear();
    repeatablesByQueue.clear();
    jest.clearAllMocks();
  });

  it('a second instance observes a mutation made by the first (cross-instance read-after-write)', async () => {
    const processA = new DiscoveryScheduler(freshDiscoverySchedules(), false);
    const processB = new DiscoveryScheduler(freshDiscoverySchedules(), false);

    await processA.disableSchedule('nmap');
    await processA.updateSchedule('nmap', '*/10 * * * *');

    // processB never saw processA's mutations directly - only via the shared store.
    const view = await processB.getScheduleView('nmap');
    expect(view?._cronPattern).toBe('*/10 * * * *');
    expect(view?._enabled).toBe(false);
  });

  it('a disabled schedule stores the new cron but never creates a repeatable job', async () => {
    const scheduler = new DiscoveryScheduler(freshDiscoverySchedules(), false);

    await scheduler.disableSchedule('nmap');
    await scheduler.updateSchedule('nmap', '*/7 * * * *');

    expect(hasRepeatable('discovery-nmap', 'discovery-nmap')).toBe(false);

    const view = await scheduler.getScheduleView('nmap');
    expect(view?._cronPattern).toBe('*/7 * * * *');
    expect(view?._enabled).toBe(false);
  });

  it('enabling later adds a repeatable using the stored cron', async () => {
    const scheduler = new DiscoveryScheduler(freshDiscoverySchedules(), false);

    await scheduler.disableSchedule('nmap');
    await scheduler.updateSchedule('nmap', '*/7 * * * *');
    await scheduler.enableSchedule('nmap');

    expect(hasRepeatable('discovery-nmap', 'discovery-nmap')).toBe(true);
    const view = await scheduler.getScheduleView('nmap');
    expect(view?._enabled).toBe(true);
    expect(view?._cronPattern).toBe('*/7 * * * *');
  });

  it('a cron edit on an enabled schedule replaces the repeatable instead of stacking a second one', async () => {
    const scheduler = new DiscoveryScheduler(freshDiscoverySchedules(), false);
    await scheduler.getScheduleView('nmap'); // seeds the store from in-memory defaults (enabled)

    await scheduler.updateSchedule('nmap', '0 3 * * *');
    const jobsAfterFirst = Array.from((repeatablesByQueue.get('discovery-nmap') ?? new Map()).values());
    expect(jobsAfterFirst).toHaveLength(1);
    expect(jobsAfterFirst[0]?.key).toBe('discovery-nmap:0 3 * * *');

    await scheduler.updateSchedule('nmap', '0 4 * * *');
    const jobsAfterSecond = Array.from((repeatablesByQueue.get('discovery-nmap') ?? new Map()).values());
    expect(jobsAfterSecond).toHaveLength(1);
    expect(jobsAfterSecond[0]?.key).toBe('discovery-nmap:0 4 * * *');
  });

  it('restart (a fresh instance calling start()) preserves persisted state and reconciles actual repeatables', async () => {
    const processA = new DiscoveryScheduler(freshDiscoverySchedules(), false);
    await processA.enableSchedule('ssh');
    await processA.updateSchedule('ssh', '*/3 * * * *');
    await processA.disableSchedule('nmap');

    // Simulate a restart: a brand-new instance with fresh, un-mutated in-memory defaults.
    const processB = new DiscoveryScheduler(freshDiscoverySchedules(), false);
    await processB.start();

    expect(hasRepeatable('discovery-ssh', 'discovery-ssh')).toBe(true);
    expect(hasRepeatable('discovery-nmap', 'discovery-nmap')).toBe(false);

    const sshView = await processB.getScheduleView('ssh');
    expect(sshView?._cronPattern).toBe('*/3 * * * *');
    expect(sshView?._enabled).toBe(true);
  });

  it('GET response enabled reflects actual BullMQ repeatable presence, not just the cached flag', async () => {
    const scheduler = new DiscoveryScheduler(freshDiscoverySchedules(), false);
    await scheduler.enableSchedule('nmap');

    // Simulate the repeatable disappearing outside of disableSchedule() (e.g. manual Redis
    // intervention) - the persisted "enabled" flag still says true.
    repeatablesByQueue.get('discovery-nmap')?.clear();

    const view = await scheduler.getScheduleView('nmap');
    expect(view?._enabled).toBe(false);
  });
});

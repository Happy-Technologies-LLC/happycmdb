// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ETL Scheduler - Shared Redis-Backed Persistence Tests
 *
 * Verifies that ETL schedule config (cron/enabled/config) is shared truth across independent
 * ETLScheduler instances - simulating separate processes (e.g. the API server and a worker) -
 * via the Redis-backed ScheduleConfigStore in @cmdb/database, instead of living only in each
 * instance's private in-memory map.
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
    _ETL_SYNC: 'etl-sync',
    _ETL_FULL_REFRESH: 'etl-full-refresh',
  },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { ETLScheduler } from '../../src/schedulers/etl-scheduler';

function hasRepeatable(queueName: string, jobName: string): boolean {
  const jobs = repeatablesByQueue.get(queueName);
  if (!jobs) {
    return false;
  }
  return Array.from(jobs.values()).some((job) => job.name === jobName);
}

// Every test constructs its ETLScheduler instances with explicit, freshly-allocated schedule
// objects rather than relying on the module's DEFAULT_SCHEDULES fallback - the default path
// shares object references across instances constructed in the same process, which would make
// cross-instance visibility trivially true regardless of whether the Redis-backed store actually
// works. Passing distinct objects forces every assertion below to be proven only through the
// shared store.
function freshETLSchedules() {
  return [
    {
      _type: 'sync' as const,
      _queueName: 'etl-sync',
      _cronPattern: '*/5 * * * *',
      _enabled: true,
      _config: { _source: 'neo4j', _target: 'postgres', _batchSize: 1000 },
    },
    {
      _type: 'full-refresh' as const,
      _queueName: 'etl-full-refresh',
      _cronPattern: '0 2 * * *',
      _enabled: true,
      _config: { _source: 'neo4j', _target: 'postgres', _batchSize: 5000 },
    },
  ];
}

describe('ETLScheduler - shared Redis-backed schedule persistence', () => {
  beforeEach(() => {
    redisStore.clear();
    repeatablesByQueue.clear();
    jest.clearAllMocks();
  });

  it('a second instance observes a mutation made by the first (cross-instance read-after-write)', async () => {
    const processA = new ETLScheduler(freshETLSchedules());
    const processB = new ETLScheduler(freshETLSchedules());

    await processA.disableSchedule('sync');
    await processA.updateSchedule('sync', '*/15 * * * *');

    // processB never saw processA's mutations directly - only via the shared store.
    const view = await processB.getScheduleView('sync');
    expect(view?._cronPattern).toBe('*/15 * * * *');
    expect(view?._enabled).toBe(false);
  });

  it('a disabled schedule stores the new cron but never creates a repeatable job', async () => {
    const scheduler = new ETLScheduler(freshETLSchedules());

    await scheduler.disableSchedule('sync');
    await scheduler.updateSchedule('sync', '*/20 * * * *');

    expect(hasRepeatable('etl-sync', 'etl-sync')).toBe(false);

    const view = await scheduler.getScheduleView('sync');
    expect(view?._cronPattern).toBe('*/20 * * * *');
    expect(view?._enabled).toBe(false);
  });

  it('enabling later adds a repeatable using the stored cron', async () => {
    const scheduler = new ETLScheduler(freshETLSchedules());

    await scheduler.disableSchedule('sync');
    await scheduler.updateSchedule('sync', '*/20 * * * *');
    await scheduler.enableSchedule('sync');

    expect(hasRepeatable('etl-sync', 'etl-sync')).toBe(true);
    const view = await scheduler.getScheduleView('sync');
    expect(view?._enabled).toBe(true);
    expect(view?._cronPattern).toBe('*/20 * * * *');
  });

  it('a cron edit on an enabled schedule replaces the repeatable instead of stacking a second one', async () => {
    const scheduler = new ETLScheduler(freshETLSchedules());
    await scheduler.getScheduleView('sync'); // seeds the store from in-memory defaults (enabled)

    await scheduler.updateSchedule('sync', '0 * * * *');
    const jobsAfterFirst = Array.from((repeatablesByQueue.get('etl-sync') ?? new Map()).values());
    expect(jobsAfterFirst).toHaveLength(1);
    expect(jobsAfterFirst[0]?.key).toBe('etl-sync:0 * * * *');

    await scheduler.updateSchedule('sync', '30 * * * *');
    const jobsAfterSecond = Array.from((repeatablesByQueue.get('etl-sync') ?? new Map()).values());
    expect(jobsAfterSecond).toHaveLength(1);
    expect(jobsAfterSecond[0]?.key).toBe('etl-sync:30 * * * *');
  });

  it('restart (a fresh instance calling start()) preserves persisted state and reconciles actual repeatables', async () => {
    const processA = new ETLScheduler(freshETLSchedules());
    await processA.updateSchedule('sync', '*/2 * * * *');
    await processA.disableSchedule('full-refresh');

    // Simulate a restart: a brand-new instance with fresh, un-mutated in-memory defaults.
    const processB = new ETLScheduler(freshETLSchedules());
    await processB.start();

    expect(hasRepeatable('etl-sync', 'etl-sync')).toBe(true);
    expect(hasRepeatable('etl-full-refresh', 'etl-full-refresh')).toBe(false);

    const syncView = await processB.getScheduleView('sync');
    expect(syncView?._cronPattern).toBe('*/2 * * * *');
    expect(syncView?._enabled).toBe(true);
  });

  it('GET response enabled reflects actual BullMQ repeatable presence, not just the cached flag', async () => {
    const scheduler = new ETLScheduler(freshETLSchedules());
    await scheduler.getScheduleView('sync'); // seeds enabled=true from defaults

    // Simulate the repeatable disappearing outside of disableSchedule() (e.g. manual Redis
    // intervention) - the persisted "enabled" flag still says true.
    repeatablesByQueue.get('etl-sync')?.clear();

    const view = await scheduler.getScheduleView('sync');
    expect(view?._enabled).toBe(false);
  });
});

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** v16 §15 N-18: runs production worker registrations against disposable Redis, PostgreSQL and Neo4j.
 * This suite must be run only by the founder on an approved disposable substrate.
 */
import { Queue, Job } from 'bullmq';
import { getDiscoveryQueueNames } from '@cmdb/common';
import {
  closeQueueManagerConnection, getNeo4jClient, getPostgresClient, getRedisClient, queueManager,
  QUEUE_NAMES,
} from '@cmdb/database';
import { DiscoveryOrchestrator } from '@cmdb/discovery-engine';
import { ETLWorkerManager } from '../../src';

const orgs = ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'];
const etlQueues = [QUEUE_NAMES._ETL_SYNC, QUEUE_NAMES._ETL_RECONCILIATION,
  QUEUE_NAMES._ETL_CHANGE_DETECTION, QUEUE_NAMES._ETL_FULL_REFRESH];
const marker = 'never-persist-private-n18';
const redis = getRedisClient();
const graph = getNeo4jClient();
const postgres = getPostgresClient();
const discovery = new DiscoveryOrchestrator();
const etl = new ETLWorkerManager();
const etlConnections = new Map<string, Queue>();
const submitted: Job[] = [];

async function settled(queue: Queue, job: Job, expected: 'completed' | 'failed'): Promise<Job> {
  const deadline = Date.now() + 370_000; // real BullMQ limiter: fake timers cannot advance Redis
  while (Date.now() < deadline) {
    const persisted = await Job.fromId(queue, job.id!);
    if (persisted && await persisted.getState() === expected) return persisted;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${job.queueName}: ${expected}`);
}

beforeAll(async () => {
  await discovery.start();
  await etl.start();
  for (const name of etlQueues) {
    etlConnections.set(name, new Queue(name, { connection: redis.getConnection() }));
  }
}, 60_000);

afterAll(async () => {
  await etl.stop();
  await queueManager.closeAll();
  for (const job of submitted) {
    if (await job.getState() !== 'unknown') await job.remove();
  }
  await Promise.all([...etlConnections.values()].map(queue => queue.close()));
  await discovery.stop();
  const session = graph.getSession();
  try { await session.run('MATCH (ci:CI) WHERE ci.id IN [91991, 91992] DETACH DELETE ci'); }
  finally { await session.close(); }
  await postgres.close();
  await graph.close();
  await redis.close();
  await closeQueueManagerConnection();
}, 60_000);

it('scrubs two organizations of pre-cutover discovery jobs in every §10.5 queue via production drain workers', async () => {
  for (const name of getDiscoveryQueueNames()) {
    const queue = queueManager.getQueue(name);
    for (const organizationId of orgs) {
      const job = await queue.add('legacy', { organizationId, target: marker, credentials: marker },
        { removeOnComplete: false, removeOnFail: false, attempts: 1 });
      submitted.push(job);
      const persisted = await settled(queue, job, 'completed');
      const logs = await queue.getJobLogs(job.id!);
      expect(persisted.data).toEqual({});
      expect(persisted.returnvalue).toEqual({ _refused: 1 });
      expect(persisted.failedReason).toBe('');
      expect(persisted.stacktrace).toEqual([]);
      expect(JSON.stringify({ result: persisted.returnvalue, logs: logs.logs,
        failure: persisted.failedReason, stack: persisted.stacktrace, data: persisted.data }))
        .not.toContain(marker);
      expect(persisted.data.__dlq).toBeUndefined();
    }
  }
}, 70_000);

it('classifies and scrubs injected updateData command faults in each registered discovery processor', async () => {
  for (const name of getDiscoveryQueueNames()) {
    const queue = queueManager.getQueue(name);
    await queue.pause();
    const failed = await queue.add('legacy-fault', { organizationId: orgs[1], target: marker, credentials: marker },
      { removeOnComplete: false, removeOnFail: false, attempts: 1 });
    submitted.push(failed);
    const updateData = Job.prototype.updateData;
    let injected = false;
    // Intercept only this test job's first real BullMQ updateData command. Redis
    // stays healthy so the actual registered drain can fail and its DLQ handler
    // can persist a scrubbed record. No production fault/poison branch exists.
    const fault = jest.spyOn(Job.prototype, 'updateData').mockImplementation(function (this: Job, data) {
      if (this.id === failed.id && !injected) {
        injected = true;
        return Promise.reject(new Error(marker));
      }
      return updateData.call(this, data);
    });
    try {
      await queue.resume();
      await settled(queue, failed, 'failed');
      let fresh = await Job.fromId(queue, failed.id!);
      const deadline = Date.now() + 10_000;
      while (!fresh?.data.__dlq && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        fresh = await Job.fromId(queue, failed.id!);
      }
      const logs = await queue.getJobLogs(failed.id!);
      expect(injected).toBe(true);
      expect(fresh?.returnvalue).toBeNull();
      expect(fresh?.failedReason).toBe('ERR_INTERNAL');
      expect(fresh?.stacktrace?.length).toBeGreaterThan(0);
      expect(logs.logs).toContain('DEAD_LETTER:ERR_INTERNAL');
      expect(fresh?.data).toEqual({ _legacy: true, __dlq: { _code: 'ERR_INTERNAL' } });
      expect(JSON.stringify({ result: fresh?.returnvalue, logs: logs.logs,
        failure: fresh?.failedReason, stack: fresh?.stacktrace, data: fresh?.data }))
        .not.toContain(marker);
    } finally {
      fault.mockRestore();
      await queue.resume();
    }
  }
}, 90_000);

it('persists coded success for A and B and sanitized forced failure through every production ETL worker', async () => {
  const safe = (name: string, organizationId: string): Record<string, unknown> => {
    if (name === QUEUE_NAMES._ETL_SYNC) return { organizationId, incrementalSince: '2099-01-01T00:00:00Z' };
    if (name === QUEUE_NAMES._ETL_RECONCILIATION) return { organizationId, ciIds: [] };
    if (name === QUEUE_NAMES._ETL_CHANGE_DETECTION) return { organizationId, ciIds: [], since: '2099-01-01T00:00:00Z' };
    return { organizationId, truncateTables: false, rebuildIndexes: false };
  };
  const unsafe = (name: string): Record<string, unknown> => {
    const common = { organizationId: orgs[1], privateMarker: marker };
    if (name === QUEUE_NAMES._ETL_SYNC) return { ...common, incrementalSince: 'not-an-iso-date' };
    if (name === QUEUE_NAMES._ETL_RECONCILIATION) return { ...common, ciIds: marker };
    if (name === QUEUE_NAMES._ETL_CHANGE_DETECTION) return { ...common, lookbackHours: 'invalid' };
    return { ...common, truncateTables: false, rebuildIndexes: false };
  };
  for (const name of etlQueues) {
    const queue = etlConnections.get(name)!;
    for (const organizationId of orgs) {
      const success = await queue.add('n18-normal', safe(name, organizationId),
        { removeOnComplete: false, removeOnFail: false, attempts: 1 });
      submitted.push(success);
      const completed = await settled(queue, success, 'completed');
      expect(completed.returnvalue).toEqual(expect.any(Object));
      expect(completed.returnvalue).not.toHaveProperty('organizationId');
      expect(completed.failedReason).toBe('');
      expect(completed.stacktrace).toEqual([]);
      expect(JSON.stringify({ result: completed.returnvalue,
        logs: (await queue.getJobLogs(success.id!)).logs })).not.toContain(marker);
      expect(JSON.stringify(completed.returnvalue)).not.toContain(orgs[1]);
    }

    if (name === QUEUE_NAMES._ETL_FULL_REFRESH) {
      // Bad numeric graph IDs force this registered processor's guard to fail
      // before any dimension write; the A and B jobs ran against clean stores.
      const session = graph.getSession();
      try {
        await session.run(`CREATE (:CI {id: 91991, name:'invalid-n18-a', organization_id:$a})
          CREATE (:CI {id: 91992, name:'invalid-n18-b', organization_id:$b})`,
        { a: orgs[0], b: orgs[1] });
      } finally { await session.close(); }
    }
    const failed = await queue.add('n18-foreign-failure', unsafe(name),
      { removeOnComplete: false, removeOnFail: false, attempts: 1 });
    submitted.push(failed);
    await settled(queue, failed, 'failed');
    // The failed event's asynchronous DLQ hook follows BullMQ's persisted state
    // transition; poll the real Redis record rather than mutating it in the test.
    let fresh = await Job.fromId(queue, failed.id!);
    const deadline = Date.now() + 10_000;
    while (!fresh?.data.__dlq && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      fresh = await Job.fromId(queue, failed.id!);
    }
    const logs = await queue.getJobLogs(failed.id!);
    expect(fresh?.returnvalue).toBeNull();
    expect(fresh?.failedReason).toBe('ERR_INTERNAL');
    expect(fresh?.stacktrace?.length).toBeGreaterThan(0);
    expect(fresh?.stacktrace?.every(line => !line.includes(marker))).toBe(true);
    expect(logs.logs).toContain('DEAD_LETTER:ERR_INTERNAL');
    expect(fresh?.data).toEqual({ _legacy: true, __dlq: { _code: 'ERR_INTERNAL' } });
    expect(JSON.stringify({ result: fresh?.returnvalue, logs: logs.logs,
      failure: fresh?.failedReason, stack: fresh?.stacktrace, data: fresh?.data }))
      .not.toContain(marker);
  }
}, 760_000);

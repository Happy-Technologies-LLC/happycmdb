// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** v16 §15 N-18: runs production worker registrations against disposable Redis, PostgreSQL and Neo4j.
 * Forced ETL failures inject scoped graph-read or worker-entry faults into the
 * registered processors. Settlement diagnostics contain only states and coded logs.
 * This suite must be run only by the founder on an approved disposable substrate.
 */
import { Queue, Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { createLogger } from 'winston';
import { appendFileSync } from 'fs';
import { getDiscoveryQueueNames } from '@cmdb/common';
import {
  closeQueueManagerConnection, getNeo4jClient, getPostgresClient, getRedisClient, queueManager,
  QUEUE_NAMES,
} from '@cmdb/database';
import { DiscoveryOrchestrator } from '@cmdb/discovery-engine';
import { ETLWorkerManager } from '../../src';
import { V3ETLWorkerManager } from '../../src/workers/v3-etl.worker';
import { CostSyncWorkerManager } from '../../../discovery-engine/src/workers/cost-sync.worker';
import { CostSyncService } from '../../../tbm-cost-engine/src/integrations/cost-sync.service';
import { installETLReadFault } from './n18-etl-read-fault';
import { installWorkerStartFault } from './n18-worker-start-fault';
import { fullRefreshFailureWaitMs, settled } from './n18-settlement';

const orgs = ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'];
const etlQueues = [QUEUE_NAMES._ETL_SYNC, QUEUE_NAMES._ETL_RECONCILIATION,
  QUEUE_NAMES._ETL_CHANGE_DETECTION, QUEUE_NAMES._ETL_FULL_REFRESH];
const costQueues = ['cost-sync-aws', 'cost-sync-azure', 'cost-sync-gcp', 'cost-sync'];
const v3Queues = ['etl-cis', 'etl-costs', 'etl-incidents'];
const marker = 'never-persist-private-n18';
const redis = getRedisClient();
const graph = getNeo4jClient();
const postgres = getPostgresClient();
const discovery = new DiscoveryOrchestrator();
const etl = new ETLWorkerManager();
let cloud: CostSyncWorkerManager;
let tbm: CostSyncService;
let createdLicenseTable = false;
let v3: V3ETLWorkerManager;
const etlConnections = new Map<string, Queue>();
const submitted: Job[] = [];


/** Job.fromJSON drops an empty Redis failedReason; only completed jobs use this assertion. */
function expectNoFailure(job: Job): void {
  expect([undefined, '']).toContain(job.failedReason);
  expect(job.stacktrace).toEqual([]);
}

/** Store only verified, Redis-reloaded fields; never include the submitted payload. */
function recordReceipt(queue: string, organizationId: string, phase: 'normal' | 'forced-failure',
  persisted: Job, logs: string[]): void {
  const fields = {
    returnvalue: persisted.returnvalue, logs,
    failedReason: persisted.failedReason, stacktrace: persisted.stacktrace,
    data: persisted.data,
  };
  const markerAbsent = !JSON.stringify(fields).includes(marker);
  expect(markerAbsent).toBe(true);
  const saved = {
    queue, organizationId, phase, state: phase === 'normal' ? 'completed' : 'failed',
    ...fields, markerAbsent,
  };
  if (process.env.N18_RECEIPT_PATH) {
    appendFileSync(process.env.N18_RECEIPT_PATH, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  }
}

beforeAll(async () => {
  await discovery.start();
  await etl.start();
  const licenseTable = await postgres.query("SELECT to_regclass('public.software_licenses') AS name");
  if (!licenseTable.rows[0].name) {
    await postgres.query(`CREATE TABLE public.software_licenses (
      license_id text PRIMARY KEY, software_name text, vendor text, license_type text,
      quantity integer, unit_cost numeric, currency text, renewal_date date,
      purchase_date date, expiry_date date, license_key text, support_included boolean, notes text
    )`);
    createdLicenseTable = true;
  }
  cloud = new CostSyncWorkerManager();
  tbm = new CostSyncService(createLogger({ silent: true }));
  v3 = new V3ETLWorkerManager();
  await v3.start();
  for (const name of [...etlQueues, ...costQueues, ...v3Queues]) {
    etlConnections.set(name, new Queue(name, { connection: redis.getConnection() }));
  }
}, 60_000);

afterAll(async () => {
  await etl.stop();
  await cloud?.closeAll();
  await tbm?.close();
  await v3?.stop();
  for (const job of submitted) {
    if (await job.getState() !== 'unknown') await job.remove();
  }
  await Promise.all([...etlConnections.values()].map(queue => queue.close()));
  await queueManager.closeAll();
  await discovery.stop();
  if (createdLicenseTable) await postgres.query('DROP TABLE public.software_licenses');
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
      expectNoFailure(persisted);
      expect(JSON.stringify({ result: persisted.returnvalue, logs: logs.logs,
        failure: persisted.failedReason, stack: persisted.stacktrace, data: persisted.data }))
        .not.toContain(marker);
      expect(persisted.data.__dlq).toBeUndefined();
      recordReceipt(name, organizationId, 'normal', persisted, logs.logs);
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
      recordReceipt(name, orgs[1], 'forced-failure', fresh!, logs.logs);
    } finally {
      fault.mockRestore();
      await queue.resume();
    }
  }
}, 90_000);

it('persists coded success for A and B and sanitized forced failure through every production ETL worker', async () => {
  const safe = (name: string, organizationId: string): Record<string, unknown> => {
    const common = { organizationId, privateMarker: marker };
    if (name === QUEUE_NAMES._ETL_SYNC) return { ...common, incrementalSince: '2099-01-01T00:00:00Z' };
    if (name === QUEUE_NAMES._ETL_RECONCILIATION) return { ...common, ciIds: [] };
    if (name === QUEUE_NAMES._ETL_CHANGE_DETECTION) return { ...common, ciIds: [], since: '2099-01-01T00:00:00Z' };
    return { ...common, truncateTables: false, rebuildIndexes: false };
  };
  const unsafe = (name: string): Record<string, unknown> => {
    const common = { organizationId: orgs[1], privateMarker: marker };
    // The scoped read fault below is independent of how many CIs the graph contains.
    if (name === QUEUE_NAMES._ETL_SYNC) return { ...common, incrementalSince: 'n18-read-fault' };
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
      expectNoFailure(completed);
      expect(completed.data).toEqual({});
      expect(JSON.stringify({ result: completed.returnvalue,
        logs: (await queue.getJobLogs(success.id!)).logs })).not.toContain(marker);
      expect(JSON.stringify(completed.returnvalue)).not.toContain(orgs[1]);
      recordReceipt(name, organizationId, 'normal', completed,
        (await queue.getJobLogs(success.id!)).logs);
    }
    const readFault = name === QUEUE_NAMES._ETL_SYNC || name === QUEUE_NAMES._ETL_FULL_REFRESH;
    if (readFault) await queue.pause();
    const failed = await queue.add('n18-foreign-failure', unsafe(name),
      { removeOnComplete: false, removeOnFail: false, attempts: 1 });
    submitted.push(failed);
    const fault = readFault ? installETLReadFault(graph, failed) : undefined;
    try {
      if (readFault) await queue.resume();
      const forced = await settled(queue, failed, 'failed',
        name === QUEUE_NAMES._ETL_FULL_REFRESH ? fullRefreshFailureWaitMs : readFault ? 20_000 : 370_000,
        fault?.injected);
      if (name === QUEUE_NAMES._ETL_FULL_REFRESH) {
        expect(forced.attemptsStarted).toBeGreaterThan(0);
        expect(forced.processedOn).toEqual(expect.any(Number));
      }
      if (fault) expect(fault.injected()).toBe(true);
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
      recordReceipt(name, orgs[1], 'forced-failure', fresh!, logs.logs);
    } finally {
      fault?.restore();
      if (readFault) await queue.resume();
    }
  }
}, 760_000);

it('persists coded outcomes and scrubs two-org inputs across four actual cloud/TBM cost workers', async () => {
  for (const name of costQueues) {
    const queue = etlConnections.get(name)!;
    for (const organizationId of orgs) {
      const data = name === 'cost-sync'
        ? { provider: 'license', organizationId, privateMarker: marker }
        : { organizationId, credentialId: randomUUID(), startDate: '2099-01-01',
          endDate: '2099-01-02', privateMarker: marker };
      const job = await queue.add('n18-cost-normal', data,
        { removeOnComplete: false, removeOnFail: false, attempts: 1 });
      submitted.push(job);
      const fresh = await settled(queue, job, 'completed');
      const result = fresh.returnvalue as Record<string, unknown>;
      expect(fresh.data).toEqual({});
      expect(result).toEqual(expect.objectContaining(name === 'cost-sync'
        ? { success: true, recordsProcessed: 0, errorCount: 0 }
        : { success: false, costsImported: 0, errorCount: 1 }));
      expectNoFailure(fresh);
      expect(JSON.stringify({ result, logs: (await queue.getJobLogs(job.id!)).logs,
        data: fresh.data, failure: fresh.failedReason, stack: fresh.stacktrace })).not.toContain(marker);
      recordReceipt(name, organizationId, 'normal', fresh,
        (await queue.getJobLogs(job.id!)).logs);
    }
    const data = name === 'cost-sync'
      ? { provider: 'invalid', organizationId: orgs[1], privateMarker: marker }
      : { organizationId: orgs[1], credentialId: randomUUID(),
        startDate: marker, endDate: '2099-01-02', privateMarker: marker };
    const job = await queue.add('n18-cost-fault', data,
      { removeOnComplete: false, removeOnFail: false, attempts: 1 });
    submitted.push(job);
    await settled(queue, job, 'failed');
    let fresh = await Job.fromId(queue, job.id!);
    const deadline = Date.now() + 10_000;
    while (!fresh?.data.__dlq && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      fresh = await Job.fromId(queue, job.id!);
    }
    const logs = await queue.getJobLogs(job.id!);
    expect(fresh?.returnvalue).toBeNull();
    expect(fresh?.failedReason).toBe('ERR_INTERNAL');
    expect(fresh?.stacktrace?.length).toBeGreaterThan(0);
    expect(logs.logs).toContain('DEAD_LETTER:ERR_INTERNAL');
    expect(fresh?.data).toEqual({ _legacy: true, __dlq: { _code: 'ERR_INTERNAL' } });
    expect(JSON.stringify({ result: fresh?.returnvalue, logs: logs.logs,
      data: fresh?.data, failure: fresh?.failedReason, stack: fresh?.stacktrace })).not.toContain(marker);
    recordReceipt(name, orgs[1], 'forced-failure', fresh!, logs.logs);
  }
}, 90_000);

it('persists scrubbed two-org results and coded DLQ failures through three registered v3 workers', async () => {
  for (const name of v3Queues) {
    const queue = etlConnections.get(name)!;
    for (const organizationId of orgs) {
      const data = name === 'etl-cis'
        ? { organizationId, incrementalSince: '2099-01-01T00:00:00Z', privateMarker: marker }
        : name === 'etl-costs'
          ? { organizationId, fiscalPeriod: '2099-01', validateAllocations: false, privateMarker: marker }
          : { organizationId, incrementalSince: '2099-01-01T00:00:00Z',
            includeChanges: false, privateMarker: marker };
      const job = await queue.add('n18-v3-normal', data,
        { removeOnComplete: false, removeOnFail: false, attempts: 1 });
      submitted.push(job);
      const fresh = await settled(queue, job, 'completed');
      expect(fresh.data).toEqual({});
      expect(fresh.returnvalue).toEqual(expect.objectContaining({
        success: expect.any(Boolean), errorCount: expect.any(Number), errorCodes: expect.any(Object),
      }));
      expectNoFailure(fresh);
      expect(JSON.stringify({ result: fresh.returnvalue,
        logs: (await queue.getJobLogs(job.id!)).logs, data: fresh.data })).not.toContain(marker);
      recordReceipt(name, organizationId, 'normal', fresh,
        (await queue.getJobLogs(job.id!)).logs);
    }
    await queue.pause();
    const faulted = await queue.add('n18-v3-fault', {
      organizationId: orgs[1], incrementalSince: '2099-01-01T00:00:00Z',
      fiscalPeriod: '2099-01', validateAllocations: false, includeChanges: false, privateMarker: marker,
    }, { removeOnComplete: false, removeOnFail: false, attempts: 1 });
    submitted.push(faulted);
    const fault = installWorkerStartFault(faulted);
    try {
      await queue.resume();
      await settled(queue, faulted, 'failed', 20_000, fault.injected);
      let fresh = await Job.fromId(queue, faulted.id!);
      const deadline = Date.now() + 10_000;
      while (!fresh?.data.__dlq && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        fresh = await Job.fromId(queue, faulted.id!);
      }
      const logs = await queue.getJobLogs(faulted.id!);
      expect(fault.injected()).toBe(true);
      expect(fresh?.returnvalue).toBeNull();
      expect(fresh?.failedReason).toBe('ERR_INTERNAL');
      expect(fresh?.stacktrace?.length).toBeGreaterThan(0);
      expect(logs.logs).toContain('DEAD_LETTER:ERR_INTERNAL');
      expect(fresh?.data).toEqual({ _legacy: true, __dlq: { _code: 'ERR_INTERNAL' } });
      expect(JSON.stringify({ result: fresh?.returnvalue, logs: logs.logs,
        data: fresh?.data, failure: fresh?.failedReason, stack: fresh?.stacktrace })).not.toContain(marker);
      recordReceipt(name, orgs[1], 'forced-failure', fresh!, logs.logs);
    } finally {
      fault.restore();
      await queue.resume();
    }
  }
}, 90_000);

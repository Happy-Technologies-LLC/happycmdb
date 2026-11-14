// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-546: GET /jobs/discovery must list queued and running jobs, which BullMQ keeps in the
 * `wait` and `active` Redis LISTS (a ZRANGE on them fails), and cancelling a job a worker holds
 * locked must answer 409, not 500. The fake queue mirrors BullMQ's key types: zrange refuses
 * anything but the sorted-set states, and the list states are only reachable through the Queue API.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const SECRET = 'stored-credential-marker';
const mockRemoveJob: AnyMock = jest.fn();
const mockGetJob: AnyMock = jest.fn();
const mockGetQueue: AnyMock = jest.fn();
const mockFromId: AnyMock = jest.fn();

jest.mock('bullmq', () => ({ Job: { fromId: (...args: any[]) => mockFromId(...args) } }));

jest.mock('@cmdb/common', () => ({
  getQueueManager: () => ({ getQueue: mockGetQueue, getJob: mockGetJob, removeJob: mockRemoveJob }),
  ScrubbedJobRetryError: class extends Error {},
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('@cmdb/discovery-engine', () => ({
  getDiscoveryScheduler: () => ({}),
  getDiscoveryJobScheduler: () => ({}),
}));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => ({}) }));
jest.mock('@cmdb/etl-processor', () => ({ getETLScheduler: () => ({}) }));

import { JobsController } from '../jobs.controller';

const SORTED_SET_STATES = new Set(['completed', 'failed', 'delayed']);

function fakeJob(id: string, state: string, timestamp: number) {
  return {
    id, timestamp, attemptsMade: 0, processedOn: undefined, finishedOn: undefined,
    data: { password: SECRET, sshKey: SECRET },
    getState: async () => state,
  };
}

function fakeQueue(jobs: { wait: any[]; active: any[] }) {
  return {
    client: Promise.resolve({
      zrange: async (key: string) => {
        const state = key.split(':').pop() as string;
        if (!SORTED_SET_STATES.has(state)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return [];
      },
    }),
    getWaiting: jest.fn(async () => jobs.wait),
    getActive: jest.fn(async () => jobs.active),
  };
}

function mockRes(): Response {
  return {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  } as Response;
}

describe('JobsController.listDiscoveryJobs queued and running jobs', () => {
  const waiting = fakeJob('nmap-wait-1', 'waiting', 100);
  const active = fakeJob('nmap-run-1', 'active', 200);
  let queue: ReturnType<typeof fakeQueue>;

  beforeEach(() => {
    jest.clearAllMocks();
    queue = fakeQueue({ wait: [waiting], active: [active] });
    mockGetQueue.mockImplementation(() => queue);
    mockFromId.mockImplementation(async (_q: unknown, id: unknown) =>
      [waiting, active].find((job) => job.id === id) ?? null);
  });

  it.each([
    ['pending', ['nmap-wait-1']],
    ['active', ['nmap-run-1']],
    [undefined, ['nmap-run-1', 'nmap-wait-1']],
  ])('returns the waiting and active jobs for status=%s without any job data', async (status, ids) => {
    const res = mockRes();
    await new JobsController().listDiscoveryJobs(
      { query: { provider: 'nmap', ...(status ? { status } : {}) } } as unknown as Request, res);

    const body = (res.json as unknown as AnyMock).mock.calls[0]![0];
    expect(body.success).toBe(true);
    expect(body.data.map((job: { id: string }) => job.id)).toEqual(ids);
    expect(body.pagination.total).toBe(ids.length);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.data.every((job: object) => !('data' in job))).toBe(true);
  });

  it('keeps the 0..99 bound per state', async () => {
    await new JobsController().listDiscoveryJobs({ query: { provider: 'nmap' } } as unknown as Request, mockRes());
    expect(queue.getWaiting).toHaveBeenCalledWith(0, 99);
    expect(queue.getActive).toHaveBeenCalledWith(0, 99);
  });
});

describe('cancelling a job locked by a worker', () => {
  // The text BullMQ's Job.remove() throws (node_modules/bullmq/dist/cjs/classes/job.js).
  const locked = new Error('Job 7 could not be removed because it is locked by another worker');

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetJob.mockResolvedValue({ id: '7' });
  });

  it('answers a fixed 409 with no error text', async () => {
    mockRemoveJob.mockRejectedValue(locked);
    const res = mockRes();
    await new JobsController().cancelJob({ params: { queueName: 'discovery-nmap', jobId: '7' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.json as unknown as AnyMock).mock.calls[0]![0];
    expect(body).toEqual({ success: false, error: 'Conflict', message: 'Job is running and cannot be cancelled' });
    expect(JSON.stringify(body)).not.toContain('worker');
  });

  it('still answers 500 for other removal failures', async () => {
    mockRemoveJob.mockRejectedValue(new Error('connection reset'));
    const res = mockRes();
    await new JobsController().cancelJob({ params: { queueName: 'discovery-nmap', jobId: '7' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

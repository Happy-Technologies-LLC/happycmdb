// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2017: the queue and failed-job lists report an explicit `hasMore` instead of the old
 * `truncated` flag. The controller reads one position past the page (limit + 1) to learn whether
 * a next page exists, returns at most `limit` jobs, and never reads more than limit + 1 positions.
 * The fake queue serves real BullMQ-style inclusive [start, end] windows over a fixed job list.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockGetQueue: AnyMock = jest.fn();
const mockGetFailedJobs: AnyMock = jest.fn();

jest.mock('bullmq', () => ({ Job: { fromId: jest.fn() } }));
jest.mock('@cmdb/common', () => ({
  getQueueManager: () => ({
    getQueue: (...args: any[]) => mockGetQueue(...args),
    getFailedJobs: (...args: any[]) => mockGetFailedJobs(...args),
  }),
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

function jobs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `job-${i}`, timestamp: i, attemptsMade: 0, opts: {}, data: {},
    getState: async () => 'waiting',
  }));
}

/** Serves inclusive [start, end] windows, like BullMQ's getJobs, and records every window asked for. */
function window(all: ReturnType<typeof jobs>, reads: Array<[number, number]>) {
  return async (start: number, end: number) => {
    reads.push([start, end]);
    return all.slice(start, end + 1);
  };
}

function res(): Response {
  return {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  } as Response;
}

function body(r: Response): any {
  return (r.json as jest.Mock).mock.calls[0][0];
}

type Route = {
  name: string;
  call: (c: JobsController, query: Record<string, string>, r: Response) => Promise<void>;
  install: (all: ReturnType<typeof jobs>, reads: Array<[number, number]>) => void;
  listOf: (b: any) => unknown[];
};

const routes: Route[] = [
  {
    name: 'listJobs',
    call: (c, query, r) =>
      c.listJobs({ params: { queueName: 'etl-sync' }, query } as unknown as Request, r),
    install: (all, reads) => {
      const read = window(all, reads);
      mockGetQueue.mockImplementation(() => ({
        getWaiting: read, getActive: read, getCompleted: read, getFailed: read, getDelayed: read,
      }));
    },
    listOf: (b) => b.data.jobs,
  },
  {
    name: 'getFailedJobs',
    call: (c, query, r) =>
      c.getFailedJobs({ params: { queueName: 'etl-sync' }, query } as unknown as Request, r),
    install: (all, reads) => {
      const read = window(all, reads);
      mockGetFailedJobs.mockImplementation((_q: string, start: number, end: number) => read(start, end));
    },
    listOf: (b) => b.data.failedJobs,
  },
];

describe.each(routes)('JobsController.$name hasMore', (route) => {
  let reads: Array<[number, number]>;
  let controller: JobsController;

  beforeEach(() => {
    reads = [];
    mockGetQueue.mockReset();
    mockGetFailedJobs.mockReset();
    controller = new JobsController();
  });

  it('returns limit jobs and hasMore: true when a job exists after the page', async () => {
    route.install(jobs(11), reads);
    const r = res();
    await route.call(controller, { limit: '10' }, r);

    expect(route.listOf(body(r))).toHaveLength(10);
    expect(body(r).data.count).toBe(10);
    expect(body(r).pagination).toEqual({ limit: 10, offset: 0, hasMore: true });
  });

  it('returns hasMore: false when the page is exactly full and nothing follows', async () => {
    route.install(jobs(10), reads);
    const r = res();
    await route.call(controller, { limit: '10' }, r);

    expect(route.listOf(body(r))).toHaveLength(10);
    expect(body(r).pagination).toEqual({ limit: 10, offset: 0, hasMore: false });
  });

  it('returns hasMore: false on a short page', async () => {
    route.install(jobs(4), reads);
    const r = res();
    await route.call(controller, { limit: '10' }, r);

    expect(route.listOf(body(r))).toHaveLength(4);
    expect(body(r).pagination.hasMore).toBe(false);
  });

  it('pages by offset: the second page of 25 jobs is last, the first is not', async () => {
    route.install(jobs(25), reads);
    const first = res();
    await route.call(controller, { start: '0', end: '19' }, first);
    const second = res();
    await route.call(controller, { start: '20', end: '39' }, second);

    expect(body(first).pagination).toEqual({ limit: 20, offset: 0, hasMore: true });
    expect(route.listOf(body(second))).toHaveLength(5);
    expect(body(second).pagination).toEqual({ limit: 20, offset: 20, hasMore: false });
  });

  it('never reads more than limit + 1 queue positions, even at the page-size cap', async () => {
    route.install(jobs(500), reads);
    const r = res();
    await route.call(controller, { start: '0', end: '9999', limit: '1000' }, r);

    expect(route.listOf(body(r))).toHaveLength(100);
    expect(body(r).pagination).toEqual({ limit: 100, offset: 0, hasMore: true });
    expect(reads).toEqual([[0, 100]]);
  });

  it('reads nothing for limit 0 and reports no next page', async () => {
    route.install(jobs(5), reads);
    const r = res();
    await route.call(controller, { limit: '0' }, r);

    expect(reads).toEqual([]);
    expect(mockGetQueue).not.toHaveBeenCalled();
    expect(route.listOf(body(r))).toEqual([]);
    expect(body(r).pagination).toEqual({ limit: 0, offset: 0, hasMore: false });
  });

  it('still refuses a start above 10000 with 400 before any queue read', async () => {
    route.install(jobs(5), reads);
    const r = res();
    await route.call(controller, { start: '10001' }, r);

    expect(r.status).toHaveBeenCalledWith(400);
    expect(body(r)).toEqual({ success: false, error: 'Deep job pages unavailable' });
    expect(reads).toEqual([]);
  });

  it('accepts start 10000 and reads at most limit + 1 positions from there', async () => {
    route.install(jobs(3), reads);
    const r = res();
    await route.call(controller, { start: '10000', end: '10004' }, r);

    expect(r.status).not.toHaveBeenCalled();
    expect(reads).toEqual([[10000, 10005]]);
    expect(body(r).pagination).toEqual({ limit: 5, offset: 10000, hasMore: false });
  });
});

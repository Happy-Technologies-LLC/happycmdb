// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getQueueManager } from '@cmdb/common';
import { getDiscoveryScheduler, getDiscoveryJobScheduler } from '@cmdb/discovery-engine';
import { getNeo4jClient } from '@cmdb/database';
import { getETLScheduler } from '@cmdb/etl-processor';
import { JobsController } from '../../src/rest/controllers/jobs.controller';

jest.mock('@cmdb/common', () => ({
  getQueueManager: jest.fn(),
  ScrubbedJobRetryError: class extends Error {},
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@cmdb/discovery-engine', () => ({
  getDiscoveryScheduler: jest.fn(),
  getDiscoveryJobScheduler: jest.fn(),
}));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
}));

jest.mock('@cmdb/etl-processor', () => ({
  getETLScheduler: jest.fn(),
}));

const INVALID_CLEAN_REQUEST = { success: false, error: 'Invalid clean request' };

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('JobsController.cleanQueue input validation', () => {
  let controller: JobsController;
  let cleanQueue: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    cleanQueue = jest.fn().mockResolvedValue(undefined);
    (getQueueManager as jest.Mock).mockReturnValue({ cleanQueue });
    (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: jest.fn() });
    (getDiscoveryScheduler as jest.Mock).mockReturnValue({});
    (getDiscoveryJobScheduler as jest.Mock).mockReturnValue({});
    (getETLScheduler as jest.Mock).mockReturnValue({});
    controller = new JobsController();
  });

  async function clean(body: unknown): Promise<Response> {
    const req = { params: { queueName: 'discovery-nmap' }, body } as unknown as Request;
    const res = mockResponse();
    await controller.cleanQueue(req, res);
    return res;
  }

  function expectRefused(res: Response): void {
    expect(cleanQueue).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(INVALID_CLEAN_REQUEST);
  }

  it.each<[string, unknown]>([
    ['wait', 'wait'],
    ['active', 'active'],
    ['paused', 'paused'],
    ['delayed', 'delayed'],
    ['waiting', 'waiting'],
    ['empty string', ''],
    ['trailing space', 'completed '],
    ['uppercase', 'COMPLETED'],
    ['number', 1],
    ['object', {}],
    ['null', null],
    ['array', ['completed']],
  ])('refuses type %s', async (_label, type) => {
    expectRefused(await clean({ type }));
  });

  it.each<[string, unknown]>([
    ['non-numeric string', 'abc'],
    ['NaN as string', 'NaN'],
    ['NaN number', NaN],
    ['negative', -1],
    ['float', 1.5],
    ['above one year', 31536000001],
    ['numeric string', '3600000'],
    ['Infinity', Infinity],
    ['null', null],
  ])('refuses grace %s', async (_label, grace) => {
    expectRefused(await clean({ grace }));
  });

  it.each<[string, unknown]>([
    ['zero', 0],
    ['negative', -5],
    ['above cap', 10001],
    ['float', 1.5],
    ['non-numeric string', 'x'],
    ['numeric string', '10'],
    ['null', null],
  ])('refuses limit %s', async (_label, limit) => {
    expectRefused(await clean({ limit }));
  });

  it('refuses a non-object body', async () => {
    expectRefused(await clean('completed'));
    expectRefused(await clean(null));
    expectRefused(await clean([]));
  });

  it('applies defaults for an empty body', async () => {
    const res = await clean({});

    expect(cleanQueue).toHaveBeenCalledWith('discovery-nmap', 3600000, 1000, 'completed');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        queueName: 'discovery-nmap',
        message: 'Cleaned completed jobs older than 3600000ms',
      },
    });
  });

  it('accepts a missing body as all defaults', async () => {
    await clean(undefined);

    expect(cleanQueue).toHaveBeenCalledWith('discovery-nmap', 3600000, 1000, 'completed');
  });

  it('passes the boundary values through exactly', async () => {
    const res = await clean({ type: 'failed', grace: 0, limit: 10000 });

    expect(cleanQueue).toHaveBeenCalledTimes(1);
    expect(cleanQueue).toHaveBeenCalledWith('discovery-nmap', 0, 10000, 'failed');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        queueName: 'discovery-nmap',
        message: 'Cleaned failed jobs older than 0ms',
      },
    });
  });

  it('accepts the upper grace bound and the lower limit bound', async () => {
    await clean({ grace: 31536000000, limit: 1 });

    expect(cleanQueue).toHaveBeenCalledWith('discovery-nmap', 31536000000, 1, 'completed');
  });

  it('never echoes a submitted value in the 400 body', async () => {
    const hostile = '<script>x</script>';
    for (const body of [{ type: hostile }, { grace: hostile }, { limit: hostile }]) {
      cleanQueue.mockClear();
      const res = await clean(body);
      expectRefused(res);
      expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain(hostile);
    }
  });

  it('still answers 500 Failed to clean queue when the manager throws', async () => {
    cleanQueue.mockRejectedValue(new Error('redis down'));

    const res = await clean({});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Failed to clean queue' });
  });
});

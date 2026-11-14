// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** HAP-546: DELETE of a discovery job a worker holds locked is a 409, not a 500. */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockRemove: AnyMock = jest.fn();
const mockGetState: AnyMock = jest.fn();

jest.mock('@cmdb/database', () => ({
  QUEUE_NAMES: { _DISCOVERY_NMAP: 'discovery-nmap', _DISCOVERY_SSH: 'discovery-ssh' },
  queueManager: {
    getQueue: (name: string) => ({
      getJob: async () => (name === 'discovery-nmap'
        ? { id: 'nmap-1', getState: mockGetState, remove: mockRemove } : null),
    }),
  },
}));
jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { DiscoveryController } from '../discovery.controller';

function mockRes(): Response {
  return {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  } as Response;
}
const cancel = (res: Response) =>
  new DiscoveryController().cancelJob({ params: { id: 'nmap-1' } } as unknown as Request, res);

describe('DiscoveryController.cancelJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetState.mockResolvedValue('active');
  });

  it('answers a fixed 409 when BullMQ refuses to remove a locked job', async () => {
    // Text thrown by BullMQ Job.remove() when a worker holds the lock.
    mockRemove.mockRejectedValue(new Error('Job nmap-1 could not be removed because it is locked by another worker'));
    const res = mockRes();
    await cancel(res);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.json as unknown as AnyMock).mock.calls[0]![0];
    expect(body).toEqual({ success: false, error: 'Conflict', message: 'Job is running and cannot be cancelled' });
  });

  it('answers 500 for other removal failures', async () => {
    mockRemove.mockRejectedValue(new Error('connection reset'));
    const res = mockRes();
    await cancel(res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('removes an unlocked job', async () => {
    mockRemove.mockResolvedValue(undefined);
    const res = mockRes();
    await cancel(res);
    expect(res.status).not.toHaveBeenCalled();
    expect((res.json as unknown as AnyMock).mock.calls[0]![0]).toMatchObject({ success: true });
  });
});

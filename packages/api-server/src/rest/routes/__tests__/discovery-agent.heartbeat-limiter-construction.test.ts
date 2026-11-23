// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The heartbeat limiter is built once, on the first heartbeat. When its store connection cannot be built, the real
 * discoveryAgentRoutes log that once and let every heartbeat through (fail open); they do not retry the construction
 * (and log again) on each call.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect } from '@jest/globals';

const calls = { getRedisClient: 0 };

// Plain functions (not jest.fn): the unit config resets mock implementations.
jest.mock('@cmdb/database', () => ({
  getRedisClient: () => {
    calls.getRedisClient += 1;
    throw new Error('redis host redis.internal:6379 refused');
  },
}));
jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    requireOrganization: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  }),
}));
jest.mock('../../controllers/discovery-agent.controller', () => ({
  DiscoveryAgentController: class {
    registerAgent = (_req: Request, res: Response) => { res.status(200).json({ ok: true }); };
    updateHeartbeat = (_req: Request, res: Response) => { res.status(200).json({ ok: true }); };
    findBestAgent = (_req: Request, res: Response) => { res.status(200).json({ ok: true }); };
    listAgents = (_req: Request, res: Response) => { res.status(200).json({ ok: true }); };
    getAgent = (_req: Request, res: Response) => { res.status(200).json({ ok: true }); };
    deleteAgent = (_req: Request, res: Response) => { res.status(200).json({ ok: true }); };
  },
}));
jest.mock('../../../services/discovery-agent.service', () => ({ AGENT_NOT_FOUND: 'Agent not found', DiscoveryAgentService: class {} }));

import { logger } from '@cmdb/common';
import { discoveryAgentRoutes } from '../discovery-agent.routes';

describe('heartbeat limiter whose store connection cannot be built', () => {
  it('logs once, never retries the construction, and lets every heartbeat through', async () => {
    const errors: unknown[][] = [];
    jest.spyOn(logger, 'error').mockImplementation(((...args: unknown[]) => { errors.push(args); }) as never);
    const app = express();
    app.use(express.json());
    app.use('/agents', discoveryAgentRoutes);

    for (let i = 0; i < 3; i++) {
      const response = await request(app).post('/agents/heartbeat').send({ agent_id: 'agent-1', status: 'active' });
      expect(response.status).toBe(200);
    }

    expect(calls.getRedisClient).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe('Heartbeat rate limiter unavailable - allowing requests');
    expect(JSON.stringify(errors)).not.toContain('redis.internal');
  });
});

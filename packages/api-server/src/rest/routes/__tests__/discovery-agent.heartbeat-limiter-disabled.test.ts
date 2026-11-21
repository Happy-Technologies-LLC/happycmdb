// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * RATE_LIMIT_AGENT_HEARTBEAT_MAX=0 mounts no heartbeat limiter: through the real discoveryAgentRoutes and the real
 * loadConfig, every heartbeat is admitted past any count, carries no X-RateLimit-* header, never touches the limiter
 * store, and logs no error (that is not the fail-open path).
 */

import { randomBytes } from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect } from '@jest/globals';

// Placeholder config so loadConfig() validates; no server is contacted. Set before the routes build their limiter.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
  RATE_LIMIT_MONITORING_ENABLED: 'false',
  RATE_LIMIT_AGENT_HEARTBEAT_MAX: '0',
});

const store = { touched: [] as string[] };

// Plain functions (not jest.fn): the unit config resets mock implementations. Any use of the connection is recorded.
jest.mock('@cmdb/database', () => ({
  getRedisClient: () => ({
    getConnection: () => new Proxy({}, {
      get: (_target, property) => {
        store.touched.push(String(property));
        return () => { throw new Error('the limiter store must not be used when max is 0'); };
      },
    }),
  }),
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

describe('heartbeat limiter with RATE_LIMIT_AGENT_HEARTBEAT_MAX=0', () => {
  it('admits every heartbeat without headers, without the store and without logging an error', async () => {
    const errors: unknown[][] = [];
    jest.spyOn(logger, 'error').mockImplementation(((...args: unknown[]) => { errors.push(args); }) as never);
    const app = express();
    app.use(express.json());
    app.use('/agents', discoveryAgentRoutes);

    // More than the 600 default budget, so a limiter that treated 0 as "default" or "exhausted" would show.
    for (let i = 0; i < 620; i++) {
      const response = await request(app).post('/agents/heartbeat').send({ agent_id: 'agent-1', status: 'active' });
      expect(response.status).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
      expect(response.headers['x-ratelimit-remaining']).toBeUndefined();
      expect(response.headers['x-ratelimit-reset']).toBeUndefined();
    }

    expect(store.touched).toEqual([]);
    expect(errors).toEqual([]);
  });
});

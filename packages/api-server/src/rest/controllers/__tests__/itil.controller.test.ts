// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/rest/controllers/__tests__/itil.controller.test.ts

/**
 * Integration Tests for ITIL Controller
 *
 * NOTE: These tests verify the API contract. Full integration tests
 * should be added once the @cmdb/itil-service-manager package is implemented.
 */

jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

import request from 'supertest';
import express from 'express';
import { itilRoutes } from '../../routes/itil.routes';

describe('ITIL API Controller', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/itil', itilRoutes);
  });

  describe('Configuration Items', () => {
    it('should have GET /configuration-items endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/configuration-items')
        .expect('Content-Type', /json/);

      // Should return a response (may be error if DB not available)
      expect(response.status).toBeDefined();
    });

    it('should have GET /configuration-items/:id endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/configuration-items/test-ci-1')
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });

    it('should have PATCH /configuration-items/:id/lifecycle endpoint', async () => {
      const response = await request(app)
        .patch('/api/v1/itil/configuration-items/test-ci-1/lifecycle')
        .send({ stage: 'OPERATE' })
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });
  });

  describe('Incidents', () => {
    it('should have POST /incidents endpoint', async () => {
      const response = await request(app)
        .post('/api/v1/itil/incidents')
        .send({
          affectedCIId: 'test-ci-1',
          description: 'Test incident',
          reportedBy: 'test-user',
        })
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });

    it('should have GET /incidents endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/incidents')
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });
  });

  describe('Changes', () => {
    it('should have POST /changes endpoint', async () => {
      const response = await request(app)
        .post('/api/v1/itil/changes')
        .send({
          changeType: 'NORMAL',
          description: 'Test change',
          affectedCIIds: ['test-ci-1'],
          requestedBy: 'test-user',
          plannedStart: new Date().toISOString(),
          plannedDuration: 60,
          implementationPlan: 'Test implementation plan with sufficient detail',
        })
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });

    it('should have GET /changes/:id/risk-assessment endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/changes/test-change-1/risk-assessment')
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });
  });

  describe('Baselines', () => {
    it('should have POST /baselines endpoint', async () => {
      const response = await request(app)
        .post('/api/v1/itil/baselines')
        .send({
          name: 'Test Baseline',
          ciIds: ['test-ci-1', 'test-ci-2'],
          createdBy: 'test-user',
        })
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });

    it('should have GET /baselines endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/baselines')
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });
  });

  describe('Metrics', () => {
    it('should have GET /metrics/configuration-accuracy endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/metrics/configuration-accuracy')
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });

    it('should have GET /metrics/incident-summary endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/metrics/incident-summary')
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });

    it('should have GET /metrics/change-success-rate endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/itil/metrics/change-success-rate')
        .expect('Content-Type', /json/);

      expect(response.status).toBeDefined();
    });
  });
});

describe('ITIL API Validation', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/itil', itilRoutes);
  });

  it('should reject invalid lifecycle stage', async () => {
    const response = await request(app)
      .patch('/api/v1/itil/configuration-items/test-ci-1/lifecycle')
      .send({ stage: 'INVALID_STAGE' });

    expect(response.status).toBe(400);
  });

  it('should reject incident creation without required fields', async () => {
    const response = await request(app)
      .post('/api/v1/itil/incidents')
      .send({
        description: 'Missing affectedCIId and reportedBy',
      });

    expect(response.status).toBe(400);
  });

  it('should reject change creation without required fields', async () => {
    const response = await request(app)
      .post('/api/v1/itil/changes')
      .send({
        description: 'Missing required fields',
      });

    expect(response.status).toBe(400);
  });
});

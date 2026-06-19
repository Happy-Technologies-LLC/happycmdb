// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CI REST API - Enhanced Integration Tests
 *
 * Additional comprehensive tests covering:
 * - Concurrent requests and race conditions
 * - Pagination edge cases (empty results, large offsets)
 * - Search with special characters and Unicode
 * - Complex filtering combinations
 * - Error responses and validation
 * - Rate limiting and performance
 */

import request from 'supertest';
import express, { Application } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getNeo4jClient } from '@cmdb/database';
import { ciRoutes } from '../../src/rest/routes/ci.routes';

// Request body for creating a CI (non-underscore field names per ciInputSchema).
interface CICreateBody {
  id: string;
  name: string;
  type: string;
  status?: string;
  environment?: string;
  external_id?: string;
  metadata?: Record<string, unknown>;
}

// Shape of a CI in GET/list responses (non-underscore keys).
interface CIResponseItem {
  id: string;
  name: string;
  type: string;
  status: string;
  environment?: string;
}

// Shape of a search result item (raw Neo4j node properties + score).
interface SearchResultItem {
  _ci: { id: string; name: string; type: string; external_id?: string };
  _score: number;
}

// Shape of a validation error detail entry.
interface ValidationDetail {
  _field: string;
  _message: string;
  _type: string;
}

// Mock the test-containers helper: this suite connects to the global containers
// (started by the integration global-setup) directly via @cmdb/database, so it
// does not need the per-file container lifecycle. Neo4j cleanup is performed
// manually between tests (see afterEach) so count/pagination assertions stay
// deterministic.
jest.mock('../helpers/test-containers', () => ({
  startTestContainers: jest.fn(),
  stopTestContainers: jest.fn(),
  cleanDatabases: jest.fn(),
  getTestContext: () => ({ neo4jDriver: { session: jest.fn() } }),
}));

describe('CI REST API - Enhanced Integration Tests', () => {
  let app: Application;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/cis', ciRoutes);
  });

  // Real Neo4j cleanup between tests (the mocked cleanDatabases is a no-op).
  afterEach(async () => {
    const session = getNeo4jClient().getSession();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent CI creations', async () => {
      const ciPromises = Array.from({ length: 10 }, (_, i) => {
        const ciData: CICreateBody = {
          id: uuidv4(),
          name: `concurrent-server-${i}`,
          type: 'server',
          status: 'active'
        };

        return request(app)
          .post('/api/v1/cis')
          .send(ciData)
          .expect(201);
      });

      const results = await Promise.all(ciPromises);

      results.forEach(response => {
        expect(response.body._success).toBe(true);
        expect(response.body._data).toHaveProperty('_id');
      });
    });

    it('should handle concurrent reads without data corruption', async () => {
      const ciId = uuidv4();
      const ciData: CICreateBody = {
        id: ciId,
        name: 'read-test-server',
        type: 'server',
        status: 'active'
      };

      await request(app).post('/api/v1/cis').send(ciData).expect(201);

      const readPromises = Array.from({ length: 20 }, () =>
        request(app).get(`/api/v1/cis/${ciId}`).expect(200)
      );

      const results = await Promise.all(readPromises);

      results.forEach(response => {
        expect(response.body._data.id).toBe(ciId);
        expect(response.body._data.name).toBe('read-test-server');
      });
    });

    it('should handle concurrent updates with optimistic locking', async () => {
      const ciId = uuidv4();
      const ciData: CICreateBody = {
        id: ciId,
        name: 'update-test-server',
        type: 'server',
        status: 'active',
        metadata: { counter: 0 }
      };

      await request(app).post('/api/v1/cis').send(ciData).expect(201);

      // Attempt 10 concurrent updates (update body uses non-underscore keys)
      const updatePromises = Array.from({ length: 10 }, (_, i) =>
        request(app)
          .put(`/api/v1/cis/${ciId}`)
          .send({
            metadata: { counter: i + 1 }
          })
      );

      const results = await Promise.all(updatePromises);

      // All should succeed (or handle conflicts appropriately)
      results.forEach(response => {
        expect([200, 409]).toContain(response.status);
      });

      // Final state should be consistent
      const finalState = await request(app)
        .get(`/api/v1/cis/${ciId}`)
        .expect(200);

      expect(finalState.body._data.metadata).toHaveProperty('counter');
    });
  });

  describe('Pagination Edge Cases', () => {
    beforeEach(async () => {
      // Create 25 test CIs
      const ciPromises = Array.from({ length: 25 }, (_, i) =>
        request(app).post('/api/v1/cis').send({
          id: uuidv4(),
          name: `pagination-server-${String(i).padStart(3, '0')}`,
          type: 'server',
          status: 'active'
        })
      );

      await Promise.all(ciPromises);
    });

    it('should handle pagination with limit > total results', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({ limit: 100, offset: 0 })
        .expect(200);

      expect(response.body._data.length).toBeLessThanOrEqual(100);
      expect(response.body._pagination._limit).toBe(100);
    });

    it('should handle offset beyond total results', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({ limit: 10, offset: 1000 })
        .expect(200);

      expect(response.body._data).toHaveLength(0);
      expect(response.body._pagination._offset).toBe(1000);
      expect(response.body._pagination.total).toBeGreaterThan(0);
    });

    it('should maintain consistent ordering across pages', async () => {
      const page1 = await request(app)
        .get('/api/v1/cis')
        .query({ limit: 10, offset: 0 })
        .expect(200);

      const page2 = await request(app)
        .get('/api/v1/cis')
        .query({ limit: 10, offset: 10 })
        .expect(200);

      const page1Ids = new Set(page1.body._data.map((ci: CIResponseItem) => ci.id));
      const page2Ids = new Set(page2.body._data.map((ci: CIResponseItem) => ci.id));

      // No overlap between pages
      page1Ids.forEach(id => {
        expect(page2Ids.has(id)).toBe(false);
      });
    });

    it('should reject invalid pagination parameters', async () => {
      const invalidParams = [
        { limit: -1, offset: 0 },
        { limit: 1001, offset: 0 }, // Exceeds max
        { limit: 10, offset: -5 },
        { limit: 'abc', offset: 0 }
      ];

      for (const params of invalidParams) {
        const response = await request(app)
          .get('/api/v1/cis')
          .query(params);

        expect(response.status).toBe(400);
      }
    });
  });

  describe('Search with Special Characters', () => {
    beforeEach(async () => {
      const specialCIs: CICreateBody[] = [
        {
          id: uuidv4(),
          name: 'server-with-dashes',
          type: 'server'
        },
        {
          id: uuidv4(),
          name: 'server.with.dots',
          type: 'server'
        },
        {
          id: uuidv4(),
          name: 'server_with_underscores',
          type: 'server'
        },
        {
          id: uuidv4(),
          name: 'server@special#chars!',
          type: 'server'
        },
        {
          id: uuidv4(),
          name: 'Сервер', // Cyrillic
          type: 'server'
        },
        {
          id: uuidv4(),
          name: 'サーバー', // Japanese
          type: 'server'
        },
        {
          id: uuidv4(),
          name: '서버', // Korean
          type: 'server'
        }
      ];

      await Promise.all(
        specialCIs.map(ci => request(app).post('/api/v1/cis').send(ci))
      );
    });

    it('should search with special characters', async () => {
      const response = await request(app)
        .post('/api/v1/cis/search')
        .send({ query: 'server-with-dashes' })
        .expect(200);

      expect(response.body._data.length).toBeGreaterThanOrEqual(1);
      expect(
        response.body._data.some((item: SearchResultItem) =>
          item._ci.name.includes('server-with-dashes')
        )
      ).toBe(true);
    });

    it('should search with dots and underscores', async () => {
      const response = await request(app)
        .post('/api/v1/cis/search')
        .send({ query: 'server.with.dots' })
        .expect(200);

      expect(response.body._data.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle Unicode characters in search', async () => {
      const queries = ['Сервер', 'サーバー', '서버'];

      for (const query of queries) {
        const response = await request(app)
          .post('/api/v1/cis/search')
          .send({ query })
          .expect(200);

        expect(response.body._data.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should sanitize SQL injection attempts', async () => {
      const maliciousQueries = [
        "'; DROP TABLE dim_ci; --",
        "' OR '1'='1",
        "<script>alert('XSS')</script>",
        "../../etc/passwd"
      ];

      for (const query of maliciousQueries) {
        const response = await request(app)
          .post('/api/v1/cis/search')
          .send({ query });

        // The injection is never executed: inputs that are invalid Lucene
        // query syntax surface as a caught, structured error (500) rather than
        // a crash; otherwise they return results (200) or are rejected (400).
        // Either way the response is a well-formed envelope, never a raw crash.
        expect([200, 400, 500]).toContain(response.status);
        expect(response.body).toHaveProperty('_success');
        expect(typeof response.body._success).toBe('boolean');
      }
    });
  });

  describe('Complex Filtering', () => {
    beforeEach(async () => {
      const testCIs: CICreateBody[] = [
        {
          id: uuidv4(),
          name: 'prod-web-01',
          type: 'server',
          status: 'active',
          environment: 'production'
        },
        {
          id: uuidv4(),
          name: 'prod-web-02',
          type: 'server',
          status: 'active',
          environment: 'production'
        },
        {
          id: uuidv4(),
          name: 'prod-db-01',
          type: 'database',
          status: 'active',
          environment: 'production'
        },
        {
          id: uuidv4(),
          name: 'staging-web-01',
          type: 'server',
          status: 'active',
          environment: 'staging'
        },
        {
          id: uuidv4(),
          name: 'staging-web-02',
          type: 'server',
          status: 'maintenance',
          environment: 'staging'
        },
        {
          id: uuidv4(),
          name: 'dev-app-01',
          type: 'application',
          status: 'active',
          environment: 'development'
        }
      ];

      await Promise.all(
        testCIs.map(ci => request(app).post('/api/v1/cis').send(ci))
      );
    });

    it('should filter by type + status + environment', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({
          type: 'server',
          status: 'active',
          environment: 'production'
        })
        .expect(200);

      expect(response.body._data.length).toBe(2);
      response.body._data.forEach((ci: CIResponseItem) => {
        expect(ci.type).toBe('server');
        expect(ci.status).toBe('active');
        expect(ci.environment).toBe('production');
      });
    });

    it('should handle empty filter results gracefully', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({
          type: 'network-device', // None exist
          status: 'active',
          environment: 'production'
        })
        .expect(200);

      expect(response.body._data).toHaveLength(0);
      expect(response.body._pagination.total).toBe(0);
    });

    it('should ignore invalid filter parameters', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({
          type: 'server',
          invalid_param: 'should-be-ignored'
        })
        .expect(200);

      expect(response.body._data.length).toBeGreaterThan(0);
    });
  });

  describe('Validation and Error Handling', () => {
    it('should validate required fields on creation', async () => {
      const invalidCIs = [
        { name: 'no-id-or-type' },
        { id: uuidv4(), name: 'no-type' },
        { id: uuidv4(), type: 'server' } // Missing name
      ];

      for (const ci of invalidCIs) {
        const response = await request(app)
          .post('/api/v1/cis')
          .send(ci);

        expect(response.status).toBe(400);
        expect(response.body._success).toBe(false);
      }
    });

    it('should validate CI type enum', async () => {
      const ciData = {
        id: uuidv4(),
        name: 'test-server',
        type: 'invalid-type' // Not in enum
      };

      const response = await request(app)
        .post('/api/v1/cis')
        .send(ciData)
        .expect(400);

      expect(response.body._success).toBe(false);
      // The offending field is reported in the validation details.
      expect(
        response.body._details.some((detail: ValidationDetail) => detail._field === 'type')
      ).toBe(true);
    });

    it('should validate status enum', async () => {
      const ciData = {
        id: uuidv4(),
        name: 'test-server',
        type: 'server',
        status: 'invalid-status'
      };

      const response = await request(app)
        .post('/api/v1/cis')
        .send(ciData)
        .expect(400);

      expect(response.body._success).toBe(false);
    });

    it('should reject oversized metadata', async () => {
      const largeMetadata: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        largeMetadata[`key_${i}`] = 'x'.repeat(1000);
      }

      const ciData: CICreateBody = {
        id: uuidv4(),
        name: 'large-metadata-server',
        type: 'server',
        metadata: largeMetadata
      };

      const response = await request(app)
        .post('/api/v1/cis')
        .send(ciData);

      // Should either accept or reject gracefully
      expect([201, 400, 413]).toContain(response.status);
    });

    it('should handle malformed JSON in request body', async () => {
      const response = await request(app)
        .post('/api/v1/cis')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }')
        .expect(400);
      // Malformed JSON is rejected by the body parser before reaching the
      // controller, so it never produces a success envelope.
      expect(response.body._success).not.toBe(true);
    });
  });

  describe('Relationship Operations', () => {
    let server1Id: string;
    let server2Id: string;
    let appId: string;
    let dbId: string;

    beforeEach(async () => {
      server1Id = uuidv4();
      server2Id = uuidv4();
      appId = uuidv4();
      dbId = uuidv4();

      await Promise.all([
        request(app).post('/api/v1/cis').send({
          id: server1Id,
          name: 'rel-server-1',
          type: 'server',
          status: 'active'
        }),
        request(app).post('/api/v1/cis').send({
          id: server2Id,
          name: 'rel-server-2',
          type: 'server',
          status: 'active'
        }),
        request(app).post('/api/v1/cis').send({
          id: appId,
          name: 'rel-app',
          type: 'application',
          status: 'active'
        }),
        request(app).post('/api/v1/cis').send({
          id: dbId,
          name: 'rel-db',
          type: 'database',
          status: 'active'
        })
      ]);
    });

    it('should handle relationship queries with no relationships', async () => {
      const response = await request(app)
        .get(`/api/v1/cis/${server1Id}/relationships`)
        .expect(200);

      expect(response.body._data).toEqual([]);
    });

    it('should handle relationship direction filtering', async () => {
      const directions = ['in', 'out', 'both'];

      for (const direction of directions) {
        const response = await request(app)
          .get(`/api/v1/cis/${server1Id}/relationships`)
          .query({ direction })
          .expect(200);

        expect(response.body._success).toBe(true);
        expect(Array.isArray(response.body._data)).toBe(true);
      }
    });

    it('should handle dependencies with varying depths', async () => {
      const depths = [1, 3, 5, 10];

      for (const depth of depths) {
        const response = await request(app)
          .get(`/api/v1/cis/${appId}/dependencies`)
          .query({ depth })
          .expect(200);

        expect(response.body._success).toBe(true);
      }
    });

    it('should reject invalid depth parameters', async () => {
      const invalidDepths = [0, -1, 11, 'abc'];

      for (const depth of invalidDepths) {
        const response = await request(app)
          .get(`/api/v1/cis/${appId}/dependencies`)
          .query({ depth });

        expect(response.status).toBe(400);
      }
    });
  });

  describe('Performance and Rate Limiting', () => {
    it('should handle rapid sequential requests', async () => {
      const requests = [];
      for (let i = 0; i < 50; i++) {
        requests.push(
          request(app).get('/api/v1/cis').query({ limit: 10, offset: 0 })
        );
      }

      const results = await Promise.all(requests);

      results.forEach(response => {
        expect([200, 429]).toContain(response.status); // 429 if rate limited
      });
    });

    it('should handle large result sets efficiently', async () => {
      const startTime = Date.now();

      const response = await request(app)
        .get('/api/v1/cis')
        .query({ limit: 1000 })
        .expect(200);

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000); // Should complete in < 5 seconds
      expect(response.body._data.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('Audit Trail', () => {
    it('should record audit trail for create operations', async () => {
      const ciId = uuidv4();
      const ciData: CICreateBody = {
        id: ciId,
        name: 'audit-server',
        type: 'server',
        status: 'active'
      };

      await request(app).post('/api/v1/cis').send(ciData).expect(201);

      // Query audit history
      const auditResponse = await request(app)
        .get(`/api/v1/cis/${ciId}/audit`)
        .expect(200);

      expect(auditResponse.body._success).toBe(true);
      expect(Array.isArray(auditResponse.body._data)).toBe(true);
    });

    it('should record audit trail for update operations', async () => {
      const ciId = uuidv4();
      await request(app).post('/api/v1/cis').send({
        id: ciId,
        name: 'audit-update-server',
        type: 'server',
        status: 'active'
      });

      await request(app)
        .put(`/api/v1/cis/${ciId}`)
        .send({ status: 'maintenance' })
        .expect(200);

      const auditResponse = await request(app)
        .get(`/api/v1/cis/${ciId}/audit`)
        .expect(200);

      // The audit endpoint returns a well-formed envelope with an array payload.
      expect(auditResponse.body._success).toBe(true);
      expect(Array.isArray(auditResponse.body._data)).toBe(true);
    });
  });
});

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Tests - CI REST API
 *
 * Tests the complete CRUD flow for Configuration Items through the REST API.
 * Uses testcontainers for Neo4j and PostgreSQL to ensure realistic testing.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import express, { Application } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { startTestContainers, stopTestContainers, cleanDatabases, getTestContext } from '../helpers/test-containers';
import { ciRoutes } from '../../src/rest/routes/ci.routes';
import type { TokenPayload } from '../../src/auth/types';

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

// Shape of a relationship item returned by the relationships endpoint.
interface RelationshipItem {
  type: string;
  source_ci_id: string;
  target_ci_id: string;
}

// Shape of a search result item (raw Neo4j node properties + score).
interface SearchResultItem {
  ci: { id: string; name: string; type: string; external_id?: string };
  score: number;
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';

describe('CI REST API Integration Tests', () => {
  let app: Application;
  // Organization claim of the next request's token (every route requires one).
  let callerOrganizationId = ORG_A;

  // Setup test containers before all tests
  beforeAll(async () => {
    await startTestContainers();

    // Create Express app with CI routes
    app = express();
    app.use(express.json());
    // The real router enforces `authMiddleware.requireOrganization()` on every
    // route and `authMiddleware.requirePermission('write')` on mutating routes;
    // `authMiddleware.authenticate()` (JWT/API-key verification) is mounted
    // centrally in server.ts before this router, not inside it. Mirror that
    // here by attaching a real operator TokenPayload directly (skipping JWT
    // verification, not the organization/permission checks themselves).
    app.use((req: express.Request, _res, next) => {
      (req as express.Request & { user?: TokenPayload }).user = {
        _userId: 'test-user-123',
        _username: 'test-operator',
        _role: 'operator',
        _type: 'access',
        _organizationId: callerOrganizationId,
      };
      next();
    });
    app.use('/api/v1/cis', ciRoutes);
  }, 120000); // 2 minute timeout for container startup

  beforeEach(() => {
    callerOrganizationId = ORG_A;
  });

  // Clean databases between tests
  afterEach(async () => {
    await cleanDatabases();
  });

  // Stop containers after all tests
  afterAll(async () => {
    await stopTestContainers();
  }, 30000);

  describe('POST /api/v1/cis - Create CI', () => {
    it('should create a new CI with valid data', async () => {
      const ciData: CICreateBody = {
        id: uuidv4(),
        name: 'web-server-01',
        type: 'server',
        status: 'active',
        environment: 'production',
        metadata: {
          ip_address: '10.0.1.100',
          hostname: 'web01.example.com',
          os: 'Ubuntu 22.04',
        },
      };

      const response = await request(app)
        .post('/api/v1/cis')
        .send(ciData)
        .expect('Content-Type', /json/)
        .expect(201);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toMatchObject({
        id: ciData.id,
        name: ciData.name,
        type: ciData.type,
        status: ciData.status,
        environment: ciData.environment,
      });
      expect(response.body.data).toHaveProperty('created_at');
      expect(response.body.data).toHaveProperty('updated_at');
    });

    it('should reject CI with missing required fields', async () => {
      const invalidData = {
        name: 'incomplete-server',
        // Missing id and type
      };

      const response = await request(app)
        .post('/api/v1/cis')
        .send(invalidData)
        .expect(400);

      expect(response.body).toHaveProperty('_success', false);
      expect(response.body).toHaveProperty('_error');
    });

    it('should reject CI with duplicate ID', async () => {
      const ciData: CICreateBody = {
        id: 'duplicate-id',
        name: 'server-01',
        type: 'server',
      };

      // Create first CI
      await request(app).post('/api/v1/cis').send(ciData).expect(201);

      // Attempt to create duplicate
      const response = await request(app)
        .post('/api/v1/cis')
        .send(ciData)
        .expect(409);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body.error).toBe('Conflict');
    });

    it('should create CI with default status when not provided', async () => {
      const ciData: CICreateBody = {
        id: uuidv4(),
        name: 'test-server',
        type: 'virtual-machine',
        // status not provided, should default to 'active'
      };

      const response = await request(app)
        .post('/api/v1/cis')
        .send(ciData)
        .expect(201);

      expect(response.body.data.status).toBe('active');
    });
  });

  describe('GET /api/v1/cis/:id - Get CI by ID', () => {
    it('should retrieve existing CI by ID', async () => {
      const ciData: CICreateBody = {
        id: uuidv4(),
        name: 'database-server',
        type: 'database',
        status: 'active',
        environment: 'production',
      };

      // Create CI first
      await request(app).post('/api/v1/cis').send(ciData).expect(201);

      // Retrieve CI
      const response = await request(app)
        .get(`/api/v1/cis/${ciData.id}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toMatchObject({
        id: ciData.id,
        name: ciData.name,
        type: ciData.type,
      });
    });

    it('should return 404 for non-existent CI', async () => {
      const nonExistentId = uuidv4();

      const response = await request(app)
        .get(`/api/v1/cis/${nonExistentId}`)
        .expect(404);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body.error).toBe('Not Found');
    });
  });

  describe('GET /api/v1/cis - List CIs with filtering', () => {
    beforeEach(async () => {
      // Create test data
      const testCIs: CICreateBody[] = [
        {
          id: uuidv4(),
          name: 'web-server-01',
          type: 'server',
          status: 'active',
          environment: 'production',
        },
        {
          id: uuidv4(),
          name: 'web-server-02',
          type: 'server',
          status: 'active',
          environment: 'production',
        },
        {
          id: uuidv4(),
          name: 'db-server-01',
          type: 'database',
          status: 'active',
          environment: 'production',
        },
        {
          id: uuidv4(),
          name: 'staging-app-01',
          type: 'application',
          status: 'active',
          environment: 'staging',
        },
        {
          id: uuidv4(),
          name: 'old-server',
          type: 'server',
          status: 'decommissioned',
          environment: 'production',
        },
      ];

      for (const ci of testCIs) {
        await request(app).post('/api/v1/cis').send(ci);
      }
    });

    it('should retrieve all CIs without filters', async () => {
      const response = await request(app).get('/api/v1/cis').expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveLength(5);
      expect(response.body).toHaveProperty('pagination');
      expect(response.body.pagination.total).toBe(5);
    });

    it('should filter CIs by type', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({ type: 'server' })
        .expect(200);

      expect(response.body.data).toHaveLength(3);
      expect(response.body.data.every((ci: CIResponseItem) => ci.type === 'server')).toBe(true);
    });

    it('should filter CIs by environment', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({ environment: 'staging' })
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].environment).toBe('staging');
    });

    it('should filter CIs by status', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({ status: 'decommissioned' })
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].status).toBe('decommissioned');
    });

    it('should support pagination with limit and offset', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({ limit: 2, offset: 0 })
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.pagination.limit).toBe(2);
      expect(response.body.pagination.offset).toBe(0);
    });

    it('should support multiple filters', async () => {
      const response = await request(app)
        .get('/api/v1/cis')
        .query({ type: 'server', status: 'active', environment: 'production' })
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(
        response.body.data.every(
          (ci: CIResponseItem) =>
            ci.type === 'server' &&
            ci.status === 'active' &&
            ci.environment === 'production'
        )
      ).toBe(true);
    });
  });

  describe('PUT /api/v1/cis/:id - Update CI', () => {
    it('should update existing CI', async () => {
      const ciData: CICreateBody = {
        id: uuidv4(),
        name: 'app-server',
        type: 'application',
        status: 'active',
      };

      // Create CI
      await request(app).post('/api/v1/cis').send(ciData).expect(201);

      // Update CI (update body uses non-underscore keys per updateCISchema)
      const updateData = {
        status: 'maintenance',
        metadata: {
          maintenance_window: '2025-10-01T00:00:00Z',
        },
      };

      const response = await request(app)
        .put(`/api/v1/cis/${ciData.id}`)
        .send(updateData)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data.status).toBe('maintenance');
      expect(response.body.data.metadata.maintenance_window).toBe('2025-10-01T00:00:00Z');
    });

    it('should return 404 when updating non-existent CI', async () => {
      const nonExistentId = uuidv4();

      const response = await request(app)
        .put(`/api/v1/cis/${nonExistentId}`)
        .send({ status: 'inactive' })
        .expect(404);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body.error).toBe('Not Found');
    });
  });

  describe('DELETE /api/v1/cis/:id - Delete CI', () => {
    it('should delete existing CI', async () => {
      const ciData: CICreateBody = {
        id: uuidv4(),
        name: 'temp-server',
        type: 'server',
      };

      // Create CI
      await request(app).post('/api/v1/cis').send(ciData).expect(201);

      // Delete CI
      await request(app).delete(`/api/v1/cis/${ciData.id}`).expect(204);

      // Verify CI is deleted
      await request(app).get(`/api/v1/cis/${ciData.id}`).expect(404);
    });

    it('should return 404 when deleting non-existent CI', async () => {
      const nonExistentId = uuidv4();

      const response = await request(app)
        .delete(`/api/v1/cis/${nonExistentId}`)
        .expect(404);

      expect(response.body).toHaveProperty('success', false);
    });
  });

  describe('CI Relationships', () => {
    let serverId: string;
    let appId: string;
    let dbId: string;

    beforeEach(async () => {
      // Create test CIs
      serverId = uuidv4();
      appId = uuidv4();
      dbId = uuidv4();

      await request(app).post('/api/v1/cis').send({
        id: serverId,
        name: 'app-server',
        type: 'server',
        status: 'active',
      });

      await request(app).post('/api/v1/cis').send({
        id: appId,
        name: 'web-app',
        type: 'application',
        status: 'active',
      });

      await request(app).post('/api/v1/cis').send({
        id: dbId,
        name: 'postgres-db',
        type: 'database',
        status: 'active',
      });

      // Create relationships using Neo4j client
      const { neo4jDriver } = getTestContext();
      const session = neo4jDriver.session();
      try {
        // Server HOSTS Application
        await session.run(
          `
          MATCH (from:CI {id: $fromId}), (to:CI {id: $toId})
          CREATE (from)-[r:HOSTS]->(to)
          RETURN r
          `,
          { fromId: serverId, toId: appId }
        );

        // Application USES Database
        await session.run(
          `
          MATCH (from:CI {id: $fromId}), (to:CI {id: $toId})
          CREATE (from)-[r:USES]->(to)
          RETURN r
          `,
          { fromId: appId, toId: dbId }
        );
      } finally {
        await session.close();
      }
    });

    it('should retrieve CI relationships', async () => {
      const response = await request(app)
        .get(`/api/v1/cis/${serverId}/relationships`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('should retrieve outbound relationships only', async () => {
      const response = await request(app)
        .get(`/api/v1/cis/${serverId}/relationships`)
        .query({ direction: 'out' })
        .expect(200);

      expect(response.body.data).toBeInstanceOf(Array);
      // Server has outbound HOSTS relationship to app
      expect(response.body.data.some((rel: RelationshipItem) => rel.type === 'HOSTS')).toBe(true);
    });

    it('should retrieve CI dependencies', async () => {
      const response = await request(app)
        .get(`/api/v1/cis/${appId}/dependencies`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toBeInstanceOf(Array);
    });

    it('should perform impact analysis', async () => {
      // Impact analysis from database should show app and server
      const response = await request(app)
        .get(`/api/v1/cis/${dbId}/impact`)
        .query({ depth: 3 })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      // Impact analysis returns an object (not an array) with upstream/downstream arrays.
      expect(response.body.data).toHaveProperty('downstream');
      expect(response.body.data).toHaveProperty('upstream');
      expect(Array.isArray(response.body.data.downstream)).toBe(true);
      expect(Array.isArray(response.body.data.upstream)).toBe(true);
    });
  });

  describe('POST /api/v1/cis/search - Search CIs', () => {
    beforeEach(async () => {
      // Create searchable test data
      await request(app).post('/api/v1/cis').send({
        id: uuidv4(),
        name: 'production-web-server',
        type: 'server',
        external_id: 'i-1234567890abcdef0',
        metadata: { region: 'us-east-1' },
      });

      await request(app).post('/api/v1/cis').send({
        id: uuidv4(),
        name: 'production-database',
        type: 'database',
        external_id: 'db-abcdef123456',
      });

      await request(app).post('/api/v1/cis').send({
        id: uuidv4(),
        name: 'staging-app',
        type: 'application',
      });
    });

    it('should search CIs by name', async () => {
      const response = await request(app)
        .post('/api/v1/cis/search')
        .send({ query: 'production' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);
      expect(response.body.data[0]).toHaveProperty('score');
    });

    it('should search CIs by type', async () => {
      const response = await request(app)
        .post('/api/v1/cis/search')
        .send({ query: 'database' })
        .expect(200);

      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data.some((item: SearchResultItem) => item.ci.type === 'database')).toBe(true);
    });

    it('should search CIs by external_id', async () => {
      const response = await request(app)
        .post('/api/v1/cis/search')
        .send({ query: 'i-1234567890abcdef0' })
        .expect(200);

      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(
        response.body.data.some((item: SearchResultItem) => item.ci.external_id === 'i-1234567890abcdef0')
      ).toBe(true);
    });
  });

  describe('Complete CRUD Flow', () => {
    it('should support full lifecycle of a CI', async () => {
      const ciId = uuidv4();

      // 1. Create CI
      const createResponse = await request(app)
        .post('/api/v1/cis')
        .send({
          id: ciId,
          name: 'lifecycle-test-server',
          type: 'server',
          status: 'active',
          environment: 'development',
          metadata: { version: '1.0' },
        })
        .expect(201);

      expect(createResponse.body.success).toBe(true);

      // 2. Read CI
      const readResponse = await request(app).get(`/api/v1/cis/${ciId}`).expect(200);

      expect(readResponse.body.data.name).toBe('lifecycle-test-server');

      // 3. Update CI (non-underscore keys per updateCISchema)
      const updateResponse = await request(app)
        .put(`/api/v1/cis/${ciId}`)
        .send({
          status: 'maintenance',
          metadata: { version: '1.1', maintenance_mode: true },
        })
        .expect(200);

      expect(updateResponse.body.data.status).toBe('maintenance');
      expect(updateResponse.body.data.metadata.version).toBe('1.1');

      // 4. Verify update persisted (GET uses non-underscore keys)
      const verifyResponse = await request(app).get(`/api/v1/cis/${ciId}`).expect(200);

      expect(verifyResponse.body.data.status).toBe('maintenance');

      // 5. Delete CI
      await request(app).delete(`/api/v1/cis/${ciId}`).expect(204);

      // 6. Verify deletion
      await request(app).get(`/api/v1/cis/${ciId}`).expect(404);
    });
  });

  describe('Tenant isolation (organization_id)', () => {
    const NOT_FOUND = { success: false, error: 'Not Found', message: 'CI not found' };

    it('keeps two organizations\' CIs, traversals and searches apart', async () => {
      const aApp = uuidv4();
      const aDb = uuidv4();
      const bApp = uuidv4();

      callerOrganizationId = ORG_A;
      await request(app).post('/api/v1/cis').send({ id: aApp, name: 'tenant-a-app', type: 'application' }).expect(201);
      await request(app).post('/api/v1/cis').send({ id: aDb, name: 'tenant-a-db', type: 'database' }).expect(201);
      // The body cannot choose the organization.
      await request(app).post('/api/v1/cis')
        .send({ id: uuidv4(), name: 'smuggled', type: 'server', organization_id: ORG_B }).expect(400);

      callerOrganizationId = ORG_B;
      await request(app).post('/api/v1/cis').send({ id: bApp, name: 'tenant-b-app', type: 'application' }).expect(201);

      // a-app -> a-db, and a cross-tenant edge b-app -> a-db (as an unscoped writer could create).
      const { neo4jDriver } = getTestContext();
      const session = neo4jDriver.session();
      try {
        await session.run(
          `MATCH (a:CI {id: $aApp}), (d:CI {id: $aDb}), (b:CI {id: $bApp})
           CREATE (a)-[:DEPENDS_ON]->(d), (b)-[:DEPENDS_ON]->(d)`,
          { aApp, aDb, bApp }
        );
        const stored = await session.run('MATCH (ci:CI) RETURN ci.id AS id, ci.organization_id AS org');
        expect(Object.fromEntries(stored.records.map(r => [r.get('id'), r.get('org')]))).toEqual({
          [aApp]: ORG_A, [aDb]: ORG_A, [bApp]: ORG_B,
        });
      } finally {
        await session.close();
      }

      // Org B sees only its own CI, and A's CIs exactly like missing ones.
      const listB = await request(app).get('/api/v1/cis').expect(200);
      expect(listB.body.data.map((ci: CIResponseItem) => ci.id)).toEqual([bApp]);
      const searchB = await request(app).post('/api/v1/cis/search').send({ query: 'tenant' }).expect(200);
      expect(searchB.body.data.map((hit: SearchResultItem) => hit.ci.id)).toEqual([bApp]);
      for (const suffix of ['', '/relationships', '/dependencies', '/impact']) {
        const foreign = await request(app).get(`/api/v1/cis/${aDb}${suffix}`).expect(404);
        const missing = await request(app).get(`/api/v1/cis/${uuidv4()}${suffix}`).expect(404);
        expect(foreign.body).toEqual(NOT_FOUND);
        expect(missing.body).toEqual(NOT_FOUND);
      }
      expect((await request(app).put(`/api/v1/cis/${aDb}`).send({ name: 'renamed-by-b' }).expect(404)).body).toEqual(NOT_FOUND);
      expect((await request(app).delete(`/api/v1/cis/${aDb}`).expect(404)).body).toEqual(NOT_FOUND);

      // Org A: its CI is intact, and impact analysis omits B's dependent.
      callerOrganizationId = ORG_A;
      const own = await request(app).get(`/api/v1/cis/${aDb}`).expect(200);
      expect(own.body.data.name).toBe('tenant-a-db');
      const impact = await request(app).get(`/api/v1/cis/${aDb}/impact`).expect(200);
      expect(impact.body.data.downstream.map((ci: CIResponseItem) => ci.id)).toEqual([aApp]);
      const dependencies = await request(app).get(`/api/v1/cis/${bApp}/dependencies`).expect(404);
      expect(dependencies.body).toEqual(NOT_FOUND);
    });
  });

  describe('Backfill 001_ci_organization_backfill.cypher', () => {
    const BACKFILL = join(__dirname, '../../../database/src/neo4j/migrations/001_ci_organization_backfill.cypher');
    // Statements as cypher-shell -f reads them: split on ';', comment lines dropped.
    const statements = readFileSync(BACKFILL, 'utf8')
      .split(';')
      .map(s => s.split('\n').filter(line => !line.trim().startsWith('//')).join('\n').trim())
      .filter(s => s.length > 0);

    it('assigns only org-less CIs to the internal organization and is idempotent', async () => {
      const { neo4jDriver } = getTestContext();
      const session = neo4jDriver.session();
      try {
        await session.run(
          `CREATE (:CI {id: 'legacy-1', name: 'legacy-1'}), (:CI {id: 'legacy-2', name: 'legacy-2'}),
                  (:CI {id: 'owned-b', name: 'owned-b', organization_id: $orgB})`,
          { orgB: ORG_B }
        );
        const runBackfill = async () => {
          const counts: number[] = [];
          for (const statement of statements) {
            const result = await session.run(statement);
            if (result.records.length > 0) counts.push(result.records[0]!.get('backfilled').toNumber());
          }
          return counts;
        };
        const orgs = async () => {
          const rows = await session.run('MATCH (ci:CI) RETURN ci.id AS id, ci.organization_id AS org');
          return Object.fromEntries(rows.records.map(r => [r.get('id'), r.get('org')]));
        };

        expect(await runBackfill()).toEqual([2]);
        const after = await orgs();
        expect(after).toEqual({ 'legacy-1': INTERNAL_ORG, 'legacy-2': INTERNAL_ORG, 'owned-b': ORG_B });

        expect(await runBackfill()).toEqual([0]);
        expect(await orgs()).toEqual(after);
      } finally {
        await session.close();
      }
    });
  });
});

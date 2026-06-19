/**
 * Full CMDB E2E Test
 *
 * End-to-end test covering CI lifecycle, search, relationships, and impact
 * analysis through the real REST routes mounted in-process against
 * Testcontainers-backed Neo4j / PostgreSQL / Redis.
 *
 * Dropped describe blocks (nonexistent AWS worker / un-runnable ETL):
 *   - Discovery Workflow (schedules AWS discovery, waits for worker)
 *   - Data Consistency (needs ETL worker + data-mart sync)
 *   - Discovery Job Management (AWS worker endpoints)
 */

import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApiClient, ApiClient } from './utils/api-client';
import { createDatabaseHelpers, Neo4jTestHelper } from './utils/database-helpers';
import { generateCIHierarchy, wait } from './utils/test-data-generator';

// Routes are imported AFTER globalSetup has set the env vars (module-load
// happens in the worker process which inherits them).
import { ciRoutes } from '../../packages/api-server/src/rest/routes/ci.routes';
import { relationshipRoutes } from '../../packages/api-server/src/rest/routes/relationship.routes';

describe('Full CMDB E2E Test', () => {
  let apiClient: ApiClient;
  let neo4jHelper: Neo4jTestHelper;
  let server: Server;

  // Global test timeout: 5 minutes for full workflow
  jest.setTimeout(300000);

  beforeAll(async () => {
    // ---- Build in-process Express app mounting the real routes -------------
    const app = express();
    app.use(express.json());

    // Trivial health endpoint for the api-client health check
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    app.use('/api/v1/cis', ciRoutes);
    app.use('/api/v1/relationships', relationshipRoutes);

    const { promise: listening, resolve: onListening } =
      Promise.withResolvers<void>();
    server = app.listen(0, () => onListening());
    await listening;

    const port = (server.address() as AddressInfo).port;
    apiClient = createApiClient({
      baseURL: `http://127.0.0.1:${port}`,
      timeout: 30000,
    });

    // ---- Database helpers (read connection from env) -----------------------
    const helpers = createDatabaseHelpers();
    neo4jHelper = helpers.neo4j;

    // Sanity check
    const health = await apiClient.healthCheck();
    expect(health.status).toBe('ok');
  });

  afterAll(async () => {
    if (neo4jHelper) await neo4jHelper.close();
    if (server) {
      const { promise: closed, resolve: onClosed } =
        Promise.withResolvers<void>();
      server.close(() => onClosed());
      await closed;
    }
  });

  beforeEach(async () => {
    // Clear Neo4j data between tests (CI routes only touch Neo4j)
    await neo4jHelper.clearAllData();
  });

  // =========================================================================
  // CI Operations
  // =========================================================================

  describe('CI Operations', () => {
    test('should create and manage CI lifecycle', async () => {
      const ciInput = {
        id: 'test-ci-001',
        name: 'Test CI',
        type: 'application',
        status: 'active',
        environment: 'test',
        metadata: { test: true },
      };

      // Create — response is raw recordToCI shape (_id, _type, _status …)
      const createdCI = await apiClient.createCI(ciInput);
      expect(createdCI._id).toBe(ciInput.id);
      expect(createdCI.name).toBe(ciInput.name);

      // Retrieve — response is convertNeo4jTypes shape (id, type, status …)
      const retrievedCI = await apiClient.getCI(ciInput.id);
      expect(retrievedCI.id).toBe(ciInput.id);
      expect(retrievedCI.name).toBe(ciInput.name);

      // Update — send non-underscore body; response is recordToCI shape
      const updatedCI = await apiClient.updateCI(ciInput.id, {
        status: 'maintenance',
      });
      expect(updatedCI._status).toBe('maintenance');

      // Verify persisted state via direct Neo4j query
      const neo4jCI = await neo4jHelper.getCIById(ciInput.id);
      expect(neo4jCI).toBeDefined();
      expect(neo4jCI!.status).toBe('maintenance');

      // Delete (204 No Content)
      await apiClient.deleteCI(ciInput.id);

      // Verify deletion — GET returns 404, axios throws
      await expect(apiClient.getCI(ciInput.id)).rejects.toThrow();
    });

    test('should search CIs by query', async () => {
      await apiClient.createCI({
        id: 'search-test-001',
        name: 'Production Web Server',
        type: 'server',
        status: 'active',
        environment: 'production',
        metadata: {},
      });

      await apiClient.createCI({
        id: 'search-test-002',
        name: 'Production Database',
        type: 'database',
        status: 'active',
        environment: 'production',
        metadata: {},
      });

      // Brief wait for fulltext index to catch up
      await wait(1500);

      // Search returns array of { _ci, _score } items
      const searchResults = await apiClient.searchCIs('Production');
      expect(searchResults.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // Relationship Operations
  // =========================================================================

  describe('Relationship Operations', () => {
    test('should create and query relationships', async () => {
      const { cis, relationships } = generateCIHierarchy();

      // Create all CIs
      for (const ci of cis) {
        await apiClient.createCI(ci);
      }

      // Create all relationships
      for (const rel of relationships) {
        await apiClient.createRelationship(rel);
      }

      // Query relationships for the load balancer (first CI)
      const loadBalancerId = cis[0].id;
      const ciRelationships = await apiClient.getRelationships(loadBalancerId);
      expect(ciRelationships.length).toBeGreaterThan(0);

      // Verify count against direct Neo4j query (outgoing only)
      const neo4jRelationships = await neo4jHelper.getRelationships(loadBalancerId);
      // The API returns both directions; the Neo4j helper only queries outgoing.
      // For the load balancer (top of the tree) there are no incoming rels,
      // so both counts should match.
      expect(neo4jRelationships.length).toBe(ciRelationships.length);
    });
  });

  // =========================================================================
  // Impact Analysis
  // =========================================================================

  describe('Impact Analysis', () => {
    test('should perform impact analysis on CI hierarchy', async () => {
      const { cis, relationships } = generateCIHierarchy();

      // Create the full 3-tier hierarchy
      for (const ci of cis) {
        await apiClient.createCI(ci);
      }
      for (const rel of relationships) {
        await apiClient.createRelationship(rel);
      }

      await wait(500);

      // ---- Impact analysis on database (bottom of hierarchy) ----
      // appServer1 and appServer2 both DEPENDS_ON database, so the database's
      // "downstream" (CIs impacted by a change here) includes both app servers.
      const databaseId = cis[5].id; // last CI is database
      const dbImpact = await apiClient.getImpactAnalysis(databaseId, 3);

      expect(dbImpact).toBeDefined();
      expect((dbImpact.ci as Record<string, unknown>).id).toBe(databaseId);
      expect(dbImpact.downstream).toBeDefined();
      expect((dbImpact.downstream as unknown[]).length).toBeGreaterThan(0);

      // ---- Impact analysis on an app server (middle of hierarchy) ----
      // appServer1 DEPENDS_ON database → its "upstream" contains database.
      const appServer1Id = cis[3].id;
      const appImpact = await apiClient.getImpactAnalysis(appServer1Id, 3);
      expect(appImpact).toBeDefined();
      expect(appImpact.upstream).toBeDefined();
      expect((appImpact.upstream as unknown[]).length).toBeGreaterThan(0);
    });
  });
});

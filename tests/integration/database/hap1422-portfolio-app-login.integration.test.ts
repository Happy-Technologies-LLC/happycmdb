// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * HAP-1422 (PoR S1, brief §6 A1/N1) on real PostgreSQL: the business-service routes, as the LOGIN role `cmdb_user`.
 *
 * Isolated hosted real-PG acceptance: it creates a cluster role, so it has its own job (HAP1422_ACCEPTANCE=1). The
 * scratch database is built by the real migrator as the container superuser (the owner of every table); `cmdb_user`
 * exists first, so the migrations' own grants (001, 033, 034, 044, 046) are the only privileges it has. Every statement the
 * routes send runs on a PostgresClient connected as that login: not a superuser, no table owner, no SET ROLE.
 * The route-table controls are packages/api-server/src/rest/routes/__tests__/fixtures/business-service-a1.ts.
 * Substitutions: Neo4jAuthRepository -> in-memory users; Neo4j -> a graph fake that knows which tenant owns each CI.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'crypto';
import { join } from 'path';
import express from 'express';
import { PostgresClient } from '../../../packages/database/src/postgres/client';
import { runMigrations } from '../../../packages/database/src/postgres/migrator';

const root = join(__dirname, '../../..');
const DATABASE = 'hap1422_portfolio';
// Disposable-container LOGIN password; never a deployed credential.
const password = randomUUID();
const connect = (database: string, user: string, secret: string) => new PostgresClient({
  _host: process.env['POSTGRES_HOST'] || 'localhost', _port: Number(process.env['POSTGRES_PORT']),
  _database: database, _user: user, _password: secret,
});
const app: { client: PostgresClient | null } = { client: null };
// The controller keeps the client it gets at import time, before beforeAll connects: forward each access at call time.
const appClientForwarder = new Proxy({}, {
  get: (_target, key) => {
    const client = app.client;
    if (!client) throw new Error('HAP-1422: app login client used before beforeAll connected it');
    const value: unknown = Reflect.get(client, key);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

jest.mock('@cmdb/database', () => {
  const traversal = jest.requireActual<Record<string, unknown>>('@cmdb/database/neo4j/client');
  const audit = jest.requireActual<Record<string, unknown>>('@cmdb/database/postgres/audit.service');
  return {
    ...jest.requireActual<object>('@cmdb/database/journal/journal'),
    isStorableString: jest.requireActual<Record<string, unknown>>('@cmdb/database/journal/encoding')['isStorableString'],
    appendAuditEntry: audit['appendAuditEntry'],
    auditChainReady: audit['auditChainReady'],
    CITraversalLimitError: traversal['CITraversalLimitError'],
    createCITraversalWork: traversal['createCITraversalWork'],
    MAX_CI_TRAVERSAL_NODES: traversal['MAX_CI_TRAVERSAL_NODES'],
    MAX_CI_TRAVERSAL_WORK: traversal['MAX_CI_TRAVERSAL_WORK'],
    CI_TRAVERSAL_QUERY_TIMEOUT_MS: traversal['CI_TRAVERSAL_QUERY_TIMEOUT_MS'],
    getPostgresClient: () => appClientForwarder,
    getNeo4jClient: () => a1GraphClient,
    getAuditService: () => ({}),
  };
});
// Plain class, not jest.fn: the integration config resets mock implementations before each test.
jest.mock('../../../packages/api-server/src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: class {
    findUserById = async (userId: string) => A1_USERS[userId] ?? null;
    findApiKeyByKey = async () => null;
  },
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../packages/api-server/src/auth/jwt.service';
import { getAuthMiddleware } from '../../../packages/api-server/src/auth/auth-bootstrap';
import { businessServiceRoutes } from '../../../packages/api-server/src/rest/routes/business-service.routes';
import { serviceOfferingRoutes } from '../../../packages/api-server/src/rest/routes/service-offering.routes';
import {
  APP_LOGIN, AppLoginRefused, assertAppLogin,
} from '../../../packages/api-server/src/rest/routes/__tests__/fixtures/app-login';
import {
  A1_SEED_SQL, A1_TRUNCATE_SQL, A1_USERS, a1GraphClient, defineA1RouteSuite, T,
} from '../../../packages/api-server/src/rest/routes/__tests__/fixtures/business-service-a1';

const rowsOf = (client: () => PostgresClient) =>
  async (sql: string, params: unknown[] = []) => (await client().query(sql, params)).rows as unknown[];

if (process.env['HAP1422_ACCEPTANCE'] !== '1') {
  it.skip('HAP-1422 runs in its isolated hosted real-store job', () => {});
} else {
  let admin: PostgresClient;
  let owner: PostgresClient;
  // Teardown drops only what this suite created, never a pre-existing cmdb_user.
  let createdRole = false;
  const appRows = rowsOf(() => app.client!);

  beforeAll(async () => {
    const superuser = process.env['POSTGRES_USER'] || 'test';
    const secret = process.env['POSTGRES_PASSWORD'] || '';
    admin = connect(process.env['POSTGRES_DB'] || 'postgres', superuser, secret);
    await admin.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    createdRole = true;
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    owner = connect(DATABASE, superuser, secret);
    await runMigrations(owner, join(root, 'packages/database/src/postgres/migrations'));
    app.client = connect(DATABASE, APP_LOGIN, password);
  }, 180000);
  afterAll(async () => {
    await app.client?.close();
    await owner?.close();
    if (!admin || !createdRole) return;
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`DROP OWNED BY ${APP_LOGIN}`);
    await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
    await admin.close();
  });
  beforeEach(async () => {
    await owner.query(A1_TRUNCATE_SQL + A1_SEED_SQL);
    // Refuse to run a route test unless the routes' connection is the app login (A1 setup guard).
    await assertAppLogin(appRows);
  });

  describe('A1 setup: the routes connect as the app login', () => {
    it('current_user and session_user are cmdb_user: rolsuper = false, owner of no relation or schema', async () => {
      expect(await assertAppLogin(appRows)).toEqual({
        current_user: APP_LOGIN, session_user: APP_LOGIN, rolsuper: false, session_rolsuper: false, rolbypassrls: false,
        rolcreaterole: false,
        has_portfolio: true, owned: [], all_data_roles: [],
      });
    });
    it('044 lets the app login read only the journal columns the routes filter on, and write nothing', async () => {
      expect(await appRows(`SELECT
          has_column_privilege('public.ci_reconciliation_operations', 'state', 'SELECT') AS state,
          has_column_privilege('public.ci_reconciliation_operations', 'plan', 'SELECT') AS plan,
          has_table_privilege('public.ci_reconciliation_operations', 'INSERT, UPDATE, DELETE') AS writes`))
        .toEqual([{ state: true, plan: false, writes: false }]);
    });
  });

  describe('N1: the setup guard refuses the superuser that owns the tables', () => {
    it('refuses the migrator login', async () => {
      const refused = assertAppLogin(rowsOf(() => owner));
      await expect(refused).rejects.toThrow(AppLoginRefused);
      await expect(refused).rejects.toMatchObject({
        reasons: expect.arrayContaining([expect.stringMatching(/ is a superuser$/),
          expect.stringMatching(/ can act as the owner of \d+ relations or schemas$/)]),
      });
    });
  });

  const server = express();
  server.use(express.json());
  server.use('/api/v1', getAuthMiddleware().authenticate());
  server.use('/api/v1/business-services', businessServiceRoutes);
  server.use('/api/v1/service-offerings', serviceOfferingRoutes);
  const jwt = new JWTService(loadConfig().auth.jwt);
  defineA1RouteSuite({
    app: server, router: businessServiceRoutes, offeringRouter: serviceOfferingRoutes, rows: appRows,
    tokenForT: () => jwt.generateAccessToken('user-t', 'tess', 'operator', T),
  });
}

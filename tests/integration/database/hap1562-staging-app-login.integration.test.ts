// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * HAP-1562 (D42) on real PostgreSQL and Neo4j: the API's queries as the Build01 staging app login `cmdb_app`.
 *
 * Isolated hosted real-store acceptance: it creates a cluster role, so it has its own job (HAP1562_ACCEPTANCE=1). As in
 * staging, `cmdb_app` exists before the real migrator runs as the owner (the container superuser), so 045 is its only
 * source of privileges. The API modules are loaded only after the environment names `cmdb_app`, so every statement
 * the routes, the journal, read admission and the connector loader send runs on a PostgreSQL login that is not a
 * superuser and owns nothing. Substitutions: the identity directory (in-memory users) and Kafka (no-op producer).
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'crypto';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { PostgresClient } from '../../../packages/database/src/postgres/client';
import { runMigrations } from '../../../packages/database/src/postgres/migrator';
import { assertAppLogin } from '../../../packages/api-server/src/rest/routes/__tests__/fixtures/app-login';
import type * as Database from '@cmdb/database';

const APP_LOGIN = 'cmdb_app';
const DATABASE = 'hap1562_app_login';
const ORG = randomUUID();
// Disposable-container LOGIN password; never a deployed credential.
const password = randomUUID();
const USER = { _id: 'hap1562-admin', _username: 'hap1562-admin', _role: 'admin', _enabled: true, _organizationId: ORG };

// Plain class and function, not jest.fn: the integration setup resets mock implementations between tests.
jest.mock('../../../packages/api-server/src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: class {
    findUserById = async (id: string) => (id === 'hap1562-admin' ? USER : null);
    findApiKeyByKey = async () => null;
  },
}));
jest.mock('@cmdb/event-processor', () => ({
  ...jest.requireActual<object>('@cmdb/event-processor'), getEventProducer: () => ({ emit: async () => [] }),
}));

if (process.env['HAP1562_ACCEPTANCE'] !== '1') {
  it.skip('HAP-1562 runs in its isolated hosted real-store job', () => {});
} else {
  const env = { ...process.env };
  const connect = (database: string, user: string, secret: string) => new PostgresClient({
    _host: env['POSTGRES_HOST'] || 'localhost', _port: Number(env['POSTGRES_PORT']),
    _database: database, _user: user, _password: secret,
  });
  let admin: PostgresClient;
  let owner: PostgresClient;
  let createdRole = false;
  let api: { app: express.Express; token: string; database: typeof Database };
  const ownerRows = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const send = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => {
    const call = request(api.app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${api.token}`);
    return body ? call.send(body) : call;
  };
  const createCI = async (name: string) => {
    const created = await send('post', '/cis', { name, type: 'server' });
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  };

  beforeAll(async () => {
    const superuser = env['POSTGRES_USER'] || 'test';
    const secret = env['POSTGRES_PASSWORD'] || '';
    admin = connect(env['POSTGRES_DB'] || 'postgres', superuser, secret);
    await admin.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    createdRole = true;
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    owner = connect(DATABASE, superuser, secret);
    await runMigrations(owner, join(__dirname, '../../../packages/database/src/postgres/migrations'));
    // From here every lazily created API client (shared pool, read-admission pool) is the app login. The API modules are
    // imported dynamically, after resetModules: a static import would bind those singletons to the superuser.
    Object.assign(process.env, { POSTGRES_DB: DATABASE, POSTGRES_USER: APP_LOGIN, POSTGRES_PASSWORD: password });
    jest.resetModules();
    const database = await import('@cmdb/database');
    const { loadConfig } = await import('@cmdb/common');
    const { JWTService } = await import('../../../packages/api-server/src/auth/jwt.service');
    const { getAuthMiddleware } = await import('../../../packages/api-server/src/auth/auth-bootstrap');
    const { ciRoutes } = await import('../../../packages/api-server/src/rest/routes/ci.routes');
    const { businessServiceRoutes } = await import('../../../packages/api-server/src/rest/routes/business-service.routes');
    const app = express();
    app.use(express.json());
    app.use('/api/v1', getAuthMiddleware().authenticate());
    app.use('/api/v1/cis', ciRoutes);
    app.use('/api/v1/business-services', businessServiceRoutes);
    const token = new JWTService(loadConfig().auth.jwt).generateAccessToken(USER._id, USER._username, 'admin', ORG);
    api = { app, token, database };
  }, 180000);
  afterAll(async () => {
    const session = api?.database.getNeo4jClient().getSession();
    await session?.run('MATCH (c:CI {organization_id: $org}) DETACH DELETE c', { org: ORG }).finally(() => session?.close());
    await api?.database.getPostgresClient().close();
    await api?.database.getNeo4jClient().close();
    await owner?.close();
    for (const key of ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) process.env[key] = env[key];
    if (!admin || !createdRole) return;
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`DROP OWNED BY ${APP_LOGIN}`);
    await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
    await admin.close();
  });

  describe('HAP-1562: the API as the staging app login', () => {
    it('the routes connect as cmdb_app: rolsuper = false, owner of nothing', async () => {
      const rows = async (sql: string) => (await api.database.getPostgresClient().query(sql)).rows;
      expect(await assertAppLogin(rows)).toMatchObject({
        current_user: APP_LOGIN, session_user: APP_LOGIN, rolsuper: false, rolcreaterole: false, owned: [],
      });
      expect(await rows(`SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user`)).toEqual([{ rolcreatedb: false }]);
    });

    it('startup: the connector loader registers the built-in connectors', async () => {
      const { loadConnectorsAtStartup } = await import('../../../packages/api-server/src/utils/connector-loader');
      await loadConnectorsAtStartup();
      const [counts] = await ownerRows(`SELECT (SELECT count(*) FROM installed_connectors)::int AS installed,
        (SELECT count(*) FROM connector_registry_cache)::int AS registry`);
      expect(counts.installed).toBeGreaterThan(0);
      expect(counts.registry).toBe(counts.installed);
    });

    it('CI routes: journaled create, update and delete commit; list and single reads pass read admission; a sweep runs', async () => {
      const ci = await createCI(`hap1562-${randomUUID().slice(0, 8)}`);
      expect((await send('put', `/cis/${ci}`, { name: 'hap1562-renamed' })).status).toBe(200);
      const list = await send('get', '/cis');
      expect([list.status, list.text.includes(ci)]).toEqual([200, true]);
      expect((await send('get', `/cis/${ci}`)).status).toBe(200);
      expect((await send('delete', `/cis/${ci}`)).status).toBe(204);
      expect(await ownerRows(`SELECT DISTINCT state FROM ci_reconciliation_operations WHERE organization_id = $1 AND ci_id = $2`,
        [ORG, ci])).toEqual([{ state: 'committed' }]);
      expect(await ownerRows(`SELECT epoch > 0 AS bumped FROM ci_reconciliation_epochs WHERE organization_id = $1`, [ORG]))
        .toEqual([{ bumped: true }]);
      await expect(api.database.getNeo4jClient().journal.sweep()).resolves.toBe(0);
    });

    it('business-service routes: create, map a CI, list its CIs and read /context', async () => {
      const created = await send('post', '/business-services', { name: 'HAP-1562 service', service_classification: 'application',
        tbm_tower: 'application', business_criticality: 'low' });
      expect(created.status).toBe(201);
      const service = created.body.data.service_id as string;
      const ci = await createCI(`hap1562-bs-${randomUUID().slice(0, 8)}`);
      // Mapping requires the CI's current dimension row; the ETL that writes cmdb.dim_ci is not running here.
      await ownerRows(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id)
        VALUES ($1, $1, 'server', 'active', $2)`, [ci, ORG]);
      expect((await send('post', `/business-services/${service}/cis`, { ci_ids: [ci] })).status).toBe(201);
      const cis = await send('get', `/business-services/${service}/cis`);
      expect([cis.status, cis.text.includes(ci)]).toEqual([200, true]);
      expect((await send('get', `/business-services/${service}/context`)).status).toBe(200);
    });
  });
}

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** Real REST router and freshly verified identity against isolated in-memory Postgres. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { once } from 'events';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', (reply: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const operation = pending.get(reply.id);
  if (!operation) throw new Error('Unexpected database reply');
  pending.delete(reply.id);
  if (!reply.error) operation.resolve(reply.rows);
  else operation.reject(Object.assign(new Error(reply.error), { code: reply.code }));
});
function query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: rows => resolve({ rows }), reject });
    host.send({ id, op: 'query', sql, params });
  });
}
function exec(sql: string): Promise<void> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: () => resolve(), reject });
    host.send({ id, op: 'exec', sql });
  });
}
let dataQueries = 0;
let credentialLookups = 0;
const pool = { query: async (sql: string, params: unknown[] = []) => {
  dataQueries++;
  if (/\b(?:FROM|JOIN)\s+credentials\b/i.test(sql)) credentialLookups++;
  return query(sql, params);
} };
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool, query: pool.query }), getNeo4jClient: () => ({}),
}));
jest.mock('bcrypt', () => ({}));
jest.mock('../../../middleware/audit.middleware', () => ({ auditMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEGACY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RUN_NULL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RUN_A = '99999999-9999-4999-8999-999999999999';
const SECRET = 'nested-secret-marker-RCRED2';
type TestUser = { _id: string; _username: string; _role: 'admin' | 'operator' | 'viewer'; _enabled: boolean; _organizationId?: string; _platformAdmin?: boolean };
const users: Record<string, TestUser> = {
  a: { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  viewer: { _id: 'viewer', _username: 'readonly', _role: 'viewer', _enabled: true, _organizationId: ORG_A },
  b: { _id: 'b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  internal: { _id: 'internal', _username: 'admin', _role: 'admin', _enabled: true, _organizationId: '00000000-0000-0000-0000-000000000000' },
  none: { _id: 'none', _username: 'none', _role: 'admin', _enabled: true },
  platform: { _id: 'platform', _username: 'operator', _role: 'viewer', _enabled: true, _platformAdmin: true },
  platformOwn: { _id: 'platformOwn', _username: 'platform-own', _role: 'viewer', _enabled: true, _organizationId: ORG_A, _platformAdmin: true },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => users[id] ?? null })),
}));
import { loadConfig, logger } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { connectorConfigRoutes } from '../connector-config.routes';
import { connectorRoutes } from '../connector.routes';
import { requireConnectorScope } from '../../../auth/connector-scope';
import { connectorsRouter } from '../../../../../integration-hub/src/api/connectors.routes';
import { connectorResolvers } from '../../../graphql/resolvers/connector.resolvers';
import { ConnectorConfigurationFieldResolvers } from '../../../graphql/resolvers/connector-fields.resolvers';

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (id: string, forgedOrg?: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(id, users[id]!._username, users[id]!._role, forgedOrg)}`,
});
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/connector-configs', connectorConfigRoutes);
app.use('/api/v1/connectors', connectorRoutes);
app.use('/api/v1/hub/connectors', requireConnectorScope, connectorsRouter);
const url = '/api/v1/connector-configs';
const migrationDir = join(__dirname, '../../../../../database/src/postgres/migrations');

beforeAll(async () => {
  const schema = readFileSync(join(migrationDir, '001_complete_schema.sql'), 'utf8');
  const tables = ['installed_connectors', 'connector_configurations', 'connector_run_history', 'connector_resource_metrics'];
  const ddl = tables.map(table => {
    const block = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
    if (!block) throw new Error(`Missing ${table} schema`);
    return block[0];
  });
  await exec(`CREATE TABLE credentials (id UUID PRIMARY KEY); ${ddl.join('\n')}
    CREATE UNIQUE INDEX idx_connector_configs_name ON connector_configurations(name);`);
  await exec(readFileSync(join(migrationDir, '018_connector_organization_scope.sql'), 'utf8'));
});
afterAll(async () => {
  const exited = once(host, 'exit');
  host.kill();
  await exited;
});
beforeEach(async () => {
  await exec(`TRUNCATE connector_resource_metrics, connector_run_history, connector_configurations, installed_connectors RESTART IDENTITY CASCADE;
    INSERT INTO installed_connectors (connector_type, category, name, installed_version, install_path, metadata, resources)
      VALUES ('test', 'connector', 'Test', '1.0', '/unused', '{}', '["items"]');
    INSERT INTO connector_configurations(id,name,connector_type,connection,options,resource_configs,organization_id)
      VALUES ('${A}','alpha','test','{"auth":{"token":"${SECRET}"}}','{"nested":{"secret":"${SECRET}"}}','{"items":{"password":"${SECRET}"}}','${ORG_A}'),
             ('${B}','beta','test','{"client_secret":"${SECRET}"}','{}','{}','${ORG_B}'),
             ('${LEGACY}','legacy','test','{"password":"${SECRET}"}','{}','{}',NULL);
    INSERT INTO connector_run_history(id,config_id,connector_type,config_name,started_at,status,organization_id,errors,error_message)
      VALUES ('${RUN_A}','${A}','test','alpha',NOW(),'running','${ORG_A}','["${SECRET}"]','${SECRET}'),
             ('${RUN_B}','${B}','test','beta',NOW(),'running','${ORG_B}','["${SECRET}"]','${SECRET}'),
             ('${RUN_NULL}','${LEGACY}','test','legacy',NOW(),'running',NULL,'["${SECRET}"]','${SECRET}');`);
  dataQueries = 0;
  credentialLookups = 0;
});

it('foreign config IDs and missing IDs return identical 404 without mutation across every route', async () => {
  const cases: Array<[string, string, unknown]> = [
    ['get', `/${B}`, undefined], ['put', `/${B}`, { name: 'hijack' }], ['delete', `/${B}`, undefined],
    ['post', `/${B}/test`, {}], ['post', `/${B}/run`, {}], ['post', `/${B}/enable`, {}],
    ['post', `/${B}/disable`, {}], ['get', `/${B}/resources`, undefined],
    ['put', `/${B}/resources`, { enabled_resources: ['items'] }],
    ['get', `/${B}/resources/items`, undefined], ['get', `/${B}/resources/items/metrics`, undefined],
    ['get', `/${B}/runs`, undefined], ['get', `/${B}/metrics`, undefined],
  ];
  for (const [method, suffix, body] of cases) {
    const invoke = (id: string) => request(app)[method as 'get'](`${url}${suffix.replace(B, id)}`).set(bearer('a')).send(body);
    const foreign = await invoke(B);
    const absent = await invoke('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect([foreign.status, foreign.body]).toEqual([absent.status, absent.body]);
    expect(foreign.status).toBe(404);
  }
  const configs = await query('SELECT name, enabled FROM connector_configurations WHERE id = $1', [B]);
  expect(configs.rows).toEqual([{ name: 'beta', enabled: true }]);
  const runs = await query('SELECT COUNT(*)::int AS count FROM connector_run_history');
  expect(runs.rows).toEqual([{ count: 3 }]);
  const foreignRun = await query('SELECT status FROM connector_run_history WHERE id = $1', [RUN_B]);
  expect(foreignRun.rows).toEqual([{ status: 'running' }]);
});

it('returns the same 404 for foreign and missing config filters on the global run list', async () => {
  const foreign = await request(app).get(`${url}/runs/all`).query({ config_id: B }).set(bearer('a'));
  const missing = await request(app).get(`${url}/runs/all`)
    .query({ config_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }).set(bearer('a'));
  expect([foreign.status, foreign.body]).toEqual([missing.status, missing.body]);
  expect(foreign.status).toBe(404);
  const own = await request(app).get(`${url}/runs/all`).query({ config_id: A }).set(bearer('a'));
  expect(own.status).toBe(200);
  expect(own.body.data.map((run: { id: string }) => run.id)).toEqual([RUN_A]);
});

it('refuses every shared connector lifecycle operation for tenant and verified platform identities', async () => {
  const shared = '/api/v1/connectors';
  for (const identity of ['internal', 'a', 'platform', 'platformOwn']) {
    const calls = [
      request(app).post(`${shared}/install`).set(bearer(identity)).send({ connector_type: 'test', force: true }),
      request(app).put(`${shared}/test/update`).set(bearer(identity)).send({ force: true }),
      request(app).post(`${shared}/test/verify`).set(bearer(identity)).send({}),
      request(app).post(`${shared}/cache/refresh`).set(bearer(identity)).send({}),
      request(app).delete(`${shared}/test`).set(bearer(identity)),
    ];
    for (const call of calls) {
      const result = await call;
      expect([result.status, result.body]).toEqual([503, {
        success: false, error: 'CONNECTOR_LIFECYCLE_UNAVAILABLE',
      }]);
    }
  }
  expect(dataQueries).toBe(0);
  expect((await query('SELECT connector_type, verified FROM installed_connectors')).rows)
    .toEqual([{ connector_type: 'test', verified: false }]);
});

it('keeps database exception text out of registry responses and logs', async () => {
  const log = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const failing = jest.spyOn(pool, 'query').mockRejectedValue(new Error(SECRET));
  try {
    for (const path of ['/registry', '/registry/test', '/registry/search?q=test', '/outdated']) {
      const result = await request(app).get(`/api/v1/connectors${path}`).set(bearer('a'));
      expect(result.status).toBe(500);
      expect(JSON.stringify(result.body)).not.toContain(SECRET);
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  } finally {
    failing.mockRestore();
    log.mockRestore();
  }
});

it('scopes list/history and denies foreign/legacy runs while hiding nested secrets', async () => {
  const list = await request(app).get(url).set(bearer('a', ORG_B));
  expect(list.status).toBe(200);
  expect(list.body.data.map((c: { id: string }) => c.id)).toEqual([A]);
  const detail = await request(app).get(`${url}/${A}`).set(bearer('a'));
  expect(detail.status).toBe(200);
  const all = await request(app).get(`${url}/runs/all`).set(bearer('a'));
  expect(all.body.data.map((run: { id: string }) => run.id)).toEqual([RUN_A]);
  const ownRun = await request(app).get(`${url}/runs/${RUN_A}`).set(bearer('a'));
  const ownHistory = await request(app).get(`${url}/${A}/runs`).set(bearer('a'));
  const resources = await request(app).get(`${url}/${A}/resources`).set(bearer('a'));
  const resourceConfig = await request(app).get(`${url}/${A}/resources/items`).set(bearer('a'));
  const updated = await request(app).put(`${url}/${A}`).set(bearer('a')).send({
    resource_configs: { items: { api_key: SECRET } }, options: { nested: { token: SECRET } },
  });
  const resourceUpdate = await request(app).put(`${url}/${A}/resources`).set(bearer('a')).send({
    enabled_resources: ['items'], resource_configs: { items: { password: SECRET } },
  });
  expect(resources.status).toBe(200);
  expect(resourceConfig.status).toBe(200);
  expect(updated.status).toBe(200);
  expect(resourceUpdate.status).toBe(200);
  expect(JSON.stringify([list.body, detail.body, all.body, ownRun.body, ownHistory.body,
    resources.body, resourceConfig.body, updated.body, resourceUpdate.body])).not.toContain(SECRET);
  for (const id of [RUN_B, RUN_NULL]) {
    const denied = await request(app).get(`${url}/runs/${id}`).set(bearer('a'));
    const missing = await request(app).get(`${url}/runs/ffffffff-ffff-4fff-8fff-ffffffffffff`).set(bearer('a'));
    expect([denied.status, denied.body]).toEqual([missing.status, missing.body]);
    expect((await request(app).post(`${url}/runs/${id}/cancel`).set(bearer('a'))).status).toBe(404);
  }
});

it('allows the same name in separate organizations without foreign conflict disclosure', async () => {
  const body = { name: 'beta', connector_type: 'test', connection: { token: SECRET } };
  const created = await request(app).post(url).set(bearer('a')).send(body);
  expect(created.status).toBe(201);
  expect(created.body.data.organization_id).toBe(ORG_A);
  expect(JSON.stringify(created.body)).not.toContain(SECRET);
  const duplicate = await request(app).post(url).set(bearer('a')).send(body);
  expect(duplicate.status).toBe(409);
  const b = await query('SELECT name, organization_id FROM connector_configurations WHERE id = $1', [B]);
  expect(b.rows).toEqual([{ name: 'beta', organization_id: ORG_B }]);
});

it('does not echo nested write-only values in validation responses or warning logs', async () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    const response = await request(app).post(url).set(bearer('a')).send({
      name: 'invalid', connector_type: 'test',
      connection: { nested: { token: SECRET } },
      organization_id: SECRET,
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  } finally {
    warn.mockRestore();
  }
});

it('legacy config is platform-only; internal tenant admin does not inherit privilege', async () => {
  const denied = await request(app).get(`${url}/${LEGACY}`).set(bearer('internal'));
  const missing = await request(app).get(`${url}/ffffffff-ffff-4fff-8fff-ffffffffffff`).set(bearer('internal'));
  expect([denied.status, denied.body]).toEqual([missing.status, missing.body]);
  expect((await request(app).get(`${url}/${LEGACY}`).set(bearer('platform'))).status).toBe(200);
  expect((await request(app).get(`${url}/runs/${RUN_NULL}`).set(bearer('platform'))).status).toBe(200);
  const result = await request(app).get(`${url}/runs/${RUN_NULL}`).set(bearer('platform'));
  expect(JSON.stringify(result.body)).not.toContain(SECRET);
});

it('rejects missing organization before any connector SQL and refuses mismatched run-parent org', async () => {
  const denied = await request(app).get(url).set(bearer('none', ORG_A));
  expect(denied.status).toBe(403);
  expect(dataQueries).toBe(0);
  await expect(query(`INSERT INTO connector_run_history(config_id,connector_type,config_name,started_at,status,organization_id)
    VALUES ($1,'test','alpha',NOW(),'queued',$2)`, [A, ORG_B])).rejects.toMatchObject({ code: '23514' });
  const created = await request(app).post(url).set(bearer('a')).send({ name: 'created', connector_type: 'test', connection: { nested: { token: SECRET } } });
  expect(created.status).toBe(201);
  expect(JSON.stringify(created.body)).not.toContain(SECRET);
  const run = await request(app).post(`${url}/${created.body.data.id}/run`).set(bearer('a')).send({});
  expect(run.status).toBe(202);
  expect(JSON.stringify(run.body)).not.toContain(SECRET);
  const stored = await query('SELECT organization_id FROM connector_run_history WHERE id = $1', [run.body.data.id]);
  expect(stored.rows).toEqual([{ organization_id: ORG_A }]);
});

it('does not log request-supplied resource IDs when queuing an owned run', async () => {
  const log = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  try {
    const result = await request(app).post(`${url}/${A}/run`).set(bearer('a'))
      .send({ resource_id: SECRET });
    expect(result.status).toBe(202);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    expect((await query('SELECT resource_id FROM connector_run_history WHERE id = $1', [result.body.data.id])).rows)
      .toEqual([{ resource_id: SECRET }]);
  } finally {
    log.mockRestore();
  }
});

it('authenticates standalone hub tenant routing, duplicate legacy names and redacted responses', async () => {
  const hub = '/api/v1/hub/connectors';
  await query(`UPDATE connector_configurations SET name = 'alpha' WHERE id = $1`, [LEGACY]);
  const own = await request(app).get(`${hub}/alpha`).set(bearer('a'));
  const ownList = await request(app).get(hub).set(bearer('a'));
  const otherList = await request(app).get(hub).set(bearer('b'));
  const history = await request(app).get(`${hub}/alpha/runs`).set(bearer('a'));
  expect([own.status, ownList.status, otherList.status, history.status]).toEqual([200, 200, 200, 200]);
  expect(own.body.connector.id).toBe(A);
  expect(ownList.body.connectors.map((row: { id: string }) => row.id)).toEqual([A]);
  expect(otherList.body.connectors.map((row: { id: string }) => row.id)).toEqual([B]);
  expect(history.body.runs.map((row: { id: string }) => row.id)).toEqual([RUN_A]);
  expect(JSON.stringify([own.body, ownList.body, otherList.body, history.body])).not.toContain(SECRET);

  const missing = await request(app).get(`${hub}/absent`).set(bearer('a'));
  const foreign = await request(app).get(`${hub}/beta`).set(bearer('a'));
  expect([foreign.status, foreign.body]).toEqual([missing.status, missing.body]);
  for (const method of ['put', 'delete'] as const) {
    const denied = await request(app)[method](`${hub}/beta`).set(bearer('a')).send({ connection: { token: SECRET } });
    expect([denied.status, denied.body]).toEqual([missing.status, missing.body]);
  }
  const runDenied = await request(app).post(`${hub}/beta/run`).set(bearer('a')).send({});
  expect([runDenied.status, runDenied.body]).toEqual([missing.status, missing.body]);
  const unchanged = await query('SELECT name, connection FROM connector_configurations WHERE id = $1', [B]);
  expect(unchanged.rows).toEqual([{ name: 'beta', connection: { client_secret: SECRET } }]);

  const platformDefault = await request(app).get(`${hub}/alpha`).set(bearer('platformOwn'));
  const platformLegacy = await request(app).get(`${hub}/alpha?legacy=true`).set(bearer('platformOwn'));
  expect(platformDefault.body.connector.id).toBe(A);
  expect(platformLegacy.body.connector.id).toBe(LEGACY);
  const platformRestList = await request(app).get(url).set(bearer('platformOwn'));
  expect(platformRestList.body.data.map((row: { id: string }) => row.id)).toEqual([A]);
  const platformHubList = await request(app).get(hub).set(bearer('platformOwn'));
  const legacyHubList = await request(app).get(`${hub}?legacy=true`).set(bearer('platformOwn'));
  expect(platformHubList.body.connectors.map((row: { id: string }) => row.id)).toEqual([A]);
  expect(legacyHubList.body.connectors.map((row: { id: string }) => row.id)).toEqual([LEGACY]);
  expect((await request(app).get(`${hub}/alpha?legacy=true`).set(bearer('a'))).body.connector.id).toBe(A);
  expect((await request(app).get(`${hub}/alpha`).set(bearer('internal'))).status).toBe(404);
  expect((await request(app).get(`${hub}/alpha`).set(bearer('none', ORG_A))).status).toBe(403);
  expect((await request(app).put(`${hub}/alpha`).set(bearer('viewer')).send({ enabled: false })).status).toBe(403);
});

it('atomically merges hub write-only connection and options without erasing omitted secrets', async () => {
  const hub = '/api/v1/hub/connectors/alpha';
  await query('UPDATE connector_configurations SET connection = $1, options = $2 WHERE id = $3', [
    JSON.stringify({ auth: { client_secret: SECRET, account: 'old' }, endpoint: 'original' }),
    JSON.stringify({ nested: { token: SECRET, region: 'old' } }), A,
  ]);
  const first = await request(app).put(hub).set(bearer('a')).send({
    connection: { auth: { account: 'new' } }, options: { nested: { region: 'new' } },
  });
  const second = await request(app).put(hub).set(bearer('a')).send({ connection: {}, options: {} });
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(JSON.stringify([first.body, second.body])).not.toContain(SECRET);
  expect((await query('SELECT connection, options FROM connector_configurations WHERE id = $1', [A])).rows)
    .toEqual([{
      connection: { auth: { client_secret: SECRET, account: 'new' }, endpoint: 'original' },
      options: { nested: { token: SECRET, region: 'new' } },
    }]);
});

it('refuses stored credential references before connector tests or run history creation', async () => {
  const credential = '44444444-4444-4444-8444-444444444444';
  await query('INSERT INTO credentials(id) VALUES ($1)', [credential]);
  await query('UPDATE connector_configurations SET credential_id = $1, enabled = false WHERE id = $2', [credential, A]);
  const rest = await request(app).post(`${url}/${A}/run`).set(bearer('a')).send({});
  const test = await request(app).post(`${url}/${A}/test`).set(bearer('a')).send({});
  const hubRun = await request(app).post('/api/v1/hub/connectors/alpha/run').set(bearer('a')).send({});
  const hubTest = await request(app).post('/api/v1/hub/connectors/alpha/test').set(bearer('a')).send({});
  await query('UPDATE connector_configurations SET credential_id = $1, enabled = false WHERE id = $2', [credential, LEGACY]);
  const platformRest = await request(app).post(`${url}/${LEGACY}/test`).set(bearer('platform')).send({});
  const platformHub = await request(app).post('/api/v1/hub/connectors/legacy/run')
    .set(bearer('platformOwn')).query({ legacy: 'true' }).send({});
  for (const response of [rest, test, hubRun, hubTest, platformRest, platformHub]) {
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(JSON.stringify(response.body)).not.toContain(credential);
  }
  expect(credentialLookups).toBe(0);
  const history = await query('SELECT COUNT(*)::int AS count FROM connector_run_history WHERE config_id = $1', [A]);
  expect(history.rows).toEqual([{ count: 1 }]);
});

it('keeps saved resource secrets when changing only enabled resources', async () => {
  const response = await request(app).put(`${url}/${A}/resources`).set(bearer('a'))
    .send({ enabled_resources: ['items'] });
  expect(response.status).toBe(200);
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
  const saved = await query('SELECT resource_configs FROM connector_configurations WHERE id = $1', [A]);
  expect(saved.rows).toEqual([{ resource_configs: { items: { password: SECRET } } }]);
  const cleared = await request(app).put(`${url}/${A}/resources`).set(bearer('a'))
    .send({ enabled_resources: ['items'], resource_configs: {} });
  expect(cleared.status).toBe(200);
  expect((await query('SELECT resource_configs FROM connector_configurations WHERE id = $1', [A])).rows)
    .toEqual([{ resource_configs: {} }]);
});

it('atomically preserves nested write-only secrets on nonempty partial REST updates and replaces explicit keys', async () => {
  const update = await request(app).put(`${url}/${A}`).set(bearer('a')).send({
    connection: { auth: { account: 'new' } },
    options: { nested: { retry: 3 } },
    resource_configs: { items: { batch_size: 20 } },
  });
  expect(update.status).toBe(200);
  const emptyEditor = await request(app).put(`${url}/${A}`).set(bearer('a'))
    .send({ connection: {}, options: {} });
  expect(emptyEditor.status).toBe(400);
  expect(JSON.stringify(update.body)).not.toContain(SECRET);
  const resources = await request(app).put(`${url}/${A}/resources`).set(bearer('a')).send({
    enabled_resources: ['items'], resource_configs: { items: { batch_size: 30 } },
  });
  expect(resources.status).toBe(200);
  const saved = await query('SELECT connection, options, resource_configs FROM connector_configurations WHERE id = $1', [A]);
  expect(saved.rows).toEqual([{
    connection: { auth: { token: SECRET, account: 'new' } },
    options: { nested: { secret: SECRET, retry: 3 } },
    resource_configs: { items: { password: SECRET, batch_size: 30 } },
  }]);
  const replaced = await request(app).put(`${url}/${A}/resources`).set(bearer('a')).send({
    enabled_resources: ['items'], resource_configs: { items: { password: 'replacement' } },
  });
  expect(replaced.status).toBe(200);
  expect((await query('SELECT resource_configs FROM connector_configurations WHERE id = $1', [A])).rows)
    .toEqual([{ resource_configs: { items: { password: 'replacement', batch_size: 30 } } }]);
});

it('keeps nested secrets on a nonempty partial GraphQL configuration update', async () => {
  const context = { user: {
    _userId: 'a', _username: 'alice', _role: 'operator', _type: 'access', _organizationId: ORG_A,
  } } as any;
  const updated = await connectorResolvers.Mutation.updateConnectorConfiguration(
    null, { id: A, input: {
      connection: { auth: { account: 'graphql' } },
      options: { nested: { retry: 2 } },
      resourceConfigs: { items: { batch_size: 50 } },
    } }, context
  );
  expect(JSON.stringify(updated)).not.toContain(SECRET);
  expect((await query('SELECT connection, options, resource_configs FROM connector_configurations WHERE id = $1', [A])).rows)
    .toEqual([{
      connection: { auth: { token: SECRET, account: 'graphql' } },
      options: { nested: { secret: SECRET, retry: 2 } },
      resource_configs: { items: { password: SECRET, batch_size: 50 } },
    }]);
});

it('returns safe installed resource descriptors instead of silently dropping them', async () => {
  await query('UPDATE installed_connectors SET resources = $1::jsonb WHERE connector_type = $2', [
    JSON.stringify([{
      id: 'hosts', name: 'Hosts', description: 'Server inventory', ci_type: 'server',
      operations: ['extract', 'test_connection'], enabled_by_default: true,
      configuration_schema: { nested: { token: SECRET } }, field_mappings: { authorization: SECRET },
    }]), 'test',
  ]);
  const response = await request(app).get(`${url}/${A}/resources`).set(bearer('a'));
  expect(response.status).toBe(200);
  expect(response.body.data.available_resources).toEqual([{
    id: 'hosts', name: 'Hosts', description: 'Server inventory', ci_type: 'server',
    operations: ['extract', 'test_connection'], enabled_by_default: true,
  }]);
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
});

it('serves installed template fields and safe resource mappings for connector deployment', async () => {
  await query('UPDATE installed_connectors SET resources = $1::jsonb, configuration_schema = $2::jsonb WHERE connector_type = $3', [
    JSON.stringify([{
      id: 'hosts', name: 'Hosts', ci_type: 'server', enabled_by_default: true,
      field_mappings: { name: 'hostname' },
      configuration_schema: { properties: { password: { default: SECRET } } },
    }]),
    JSON.stringify({ required: ['instance_url', 'password'], properties: {
      instance_url: { type: 'string', title: 'Instance URL' },
      password: { type: 'string', format: 'password', default: SECRET },
    } }),
    'test',
  ]);
  const list = await request(app).get('/api/v1/connectors/installed').set(bearer('a'));
  const detail = await request(app).get('/api/v1/connectors/installed/test').set(bearer('a'));
  expect([list.status, detail.status]).toEqual([200, 200]);
  for (const template of [list.body.data[0], detail.body.data]) {
    expect(template.configuration_schema.properties.instance_url.type).toBe('string');
    expect(template.configuration_schema.properties.password.format).toBe('password');
    expect(template.configuration_schema.properties.password.required).toBe(true);
    expect(template.metadata.resources).toEqual([expect.objectContaining({
      id: 'hosts', name: 'Hosts', enabled_by_default: true,
      field_mappings: { name: 'hostname' },
    })]);
    expect(JSON.stringify(template)).not.toContain(SECRET);
  }
  const context = { user: {
    _userId: 'b', _username: 'bob', _role: 'operator', _type: 'access', _organizationId: ORG_B,
  } } as any;
  const graphqlList = await connectorResolvers.Query.installedConnectors(null, {}, context);
  const graphqlDetail = await connectorResolvers.Query.installedConnector(null, { connectorType: 'test' }, context);
  const ownContext = { user: {
    _userId: 'a', _username: 'alice', _role: 'operator', _type: 'access', _organizationId: ORG_A,
  } } as any;
  const nested = await ConnectorConfigurationFieldResolvers.connector({ id: A, connectorType: 'test' }, {}, ownContext);
  for (const template of [graphqlList[0], graphqlDetail, nested] as any[]) {
    expect(template.configurationSchema.properties.password.format).toBe('password');
    expect(template.configurationSchema.properties.password.required).toBe(true);
    expect(template.resources[0].field_mappings).toEqual({ name: 'hostname' });
    expect(JSON.stringify(template)).not.toContain(SECRET);
  }
});

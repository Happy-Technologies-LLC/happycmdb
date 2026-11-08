// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1426 (PoR S5, brief §6 A1-A7): POST /api/v1/portfolio/imports on the production PostgresClient, journal,
 * Neo4jClient and audit chain, every statement run by PGlite as the app login `cmdb_user` (fixtures/app-login.ts; the
 * schema is built by the NOSUPERUSER owner from 001's tables, 003, 008, 011, 028/029/037, 043, 046 and 048, then the
 * app grants, 044 and the journal rows of 045). Neo4j is an in-memory graph that knows which tenant owns each CI.
 * fixtures/happyhive-portfolio-export.jsonl is a HappyHive export of tenant A built from HappyHive's DDL.
 */
import { fork } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});
const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<{ rows: Record<string, any>[]; rowCount: number }>>();
host.on('message', ({ id, rows, rowCount, error, code }: { id: number; rows: Record<string, any>[]; rowCount?: number;
  error?: string; code?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(Object.assign(new Error(error), { code }));
  else call.resolve({ rows, rowCount: rowCount || rows.length });
});
/**
 * `mapFault`: the source id whose first map-row insert fails (a crash after its record was written). `preLink`: the next
 * service-CI mapping insert is run twice, as if another writer linked the pair first.
 */
const mockFault = { mapFault: null as string | null, preLink: false };
function mockSql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query'): Promise<{ rows: Record<string, any>[]; rowCount: number }> {
  if (mockFault.mapFault && text.includes('INSERT INTO portfolio_import_map') && params[3] === mockFault.mapFault) {
    mockFault.mapFault = null;
    return Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }));
  }
  if (mockFault.preLink && text.includes('INSERT INTO ci_business_service_mappings')) {
    mockFault.preLink = false;
    return mockSql(text, params).then(() => mockSql(text, params));
  }
  const id = serial++;
  const call = Promise.withResolvers<{ rows: Record<string, any>[]; rowCount: number }>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}
// The production PostgresClient, journal and audit chain run on one PGlite session as the app login.
jest.mock('pg', () => {
  const actual = jest.requireActual('pg');
  const { assertAppStatement } = jest.requireActual('./fixtures/app-login');
  const query = (text: string, params?: unknown[]) => {
    assertAppStatement(text);
    return mockSql(text, params);
  };
  class Pool {
    options = {};
    on() { return this; }
    query(text: string, params?: unknown[]) { return query(text, params); }
    async connect() { return { query, release: () => undefined }; }
    async end() { return undefined; }
  }
  return { ...actual, Pool, default: { ...actual, Pool } };
});
const mockGraph = { nodes: new Map<string, Record<string, unknown>>(), fences: new Map<string, Record<string, unknown>>(),
  relationships: new Set<string>() };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const owner = (id: unknown) => mockGraph.nodes.get(id as string)?.['organization_id'];
  const run = async (query: string, params: Record<string, any> = {}) => {
    if (query.includes('SHOW CONSTRAINTS')) return { records: [record({ present: 1 })] };
    if (query.includes('MERGE (op:ReconciliationOp')) {
      return { records: [record(mockGraph.fences.get(params['op']) ?? { outcome: 'aborted', org: params['org'], ci: params['ci'], operation: params['operation'] })] };
    }
    if (query.includes('fences_created')) {
      let applied = false;
      if (query.startsWith('CREATE (ci:CI')) {
        applied = !mockGraph.nodes.has(params['id']);
        if (applied) mockGraph.nodes.set(params['id'], { ...params['props'], id: params['id'], organization_id: params['org'] });
      } else if ('from' in params && query.includes('MERGE (a)')) {
        applied = owner(params['from']) === params['org'] && owner(params['to']) === params['org'];
        if (applied) mockGraph.relationships.add(`${params['from']}-${/\[r:(\w+)\]/.exec(query)![1]}->${params['to']}`);
      } else throw new Error(`unexpected write: ${query}`);
      for (const fence of applied ? params['fences'] : []) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: applied ? params['fences'].length : 0 })] };
    }
    if (query.includes('count(r) > 0 AS present')) {
      const edge = `${params['from']}-${/\[r:(\w+)\]/.exec(query)![1]}->${params['to']}`;
      return { records: [record({ present: owner(params['from']) === params['organizationId']
        && owner(params['to']) === params['organizationId'] && mockGraph.relationships.has(edge) })] };
    }
    const node = owner(params['id']) === params['organizationId'] ? mockGraph.nodes.get(params['id']) : undefined;
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    throw new Error(`unexpected statement: ${query}`);
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
type FakeUser = { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId: string;
  _scopes?: unknown; _seedProvenance?: string; _platformAdmin?: boolean };
const SCOPE = ['portfolio:import'];
const users: Record<string, FakeUser> = {
  admin: { _id: 'actor-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
  operator: { _id: 'actor-o', _username: 'olga', _role: 'operator', _enabled: true, _organizationId: A },
  agent: { _id: 'actor-g', _username: 'gary', _role: 'agent', _enabled: true, _organizationId: A },
  viewer: { _id: 'actor-v', _username: 'vera', _role: 'viewer', _enabled: true, _organizationId: A },
  // The migration principals (HAP-1615): the stored scope authorizes, the role grants nothing.
  migrator: { _id: 'actor-m', _username: 'mia', _role: 'operator', _enabled: true, _organizationId: A, _scopes: SCOPE },
  migratorB: { _id: 'actor-n', _username: 'nia', _role: 'viewer', _enabled: true, _organizationId: B, _scopes: SCOPE },
  // Refused although each names the scope: a seeded account, and a scopes value that is not a list.
  seeded: { _id: 'actor-s', _username: 'sam', _role: 'admin', _enabled: true, _organizationId: A, _scopes: SCOPE,
    _seedProvenance: 'pre-cutover-inventory' },
  listless: { _id: 'actor-l', _username: 'lee', _role: 'admin', _enabled: true, _organizationId: A,
    _scopes: 'portfolio:import' },
  platform: { _id: 'actor-p', _username: 'pat', _role: 'admin', _enabled: true, _organizationId: A, _platformAdmin: true },
};
/** Every fake user's API key is `key-<id>`; these call with it, everyone else with a JWT. */
const KEY_CALLERS = ['migrator', 'migratorB', 'platform'];
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
    findApiKeyByKey: async (hash: string) => {
      const user = Object.values(users).find(each => createHash('sha256').update(`key-${each._id}`).digest('hex') === hash);
      return user ? { _id: `k-${user._id}`, _userId: user._id, _role: user._role, _enabled: true } : null;
    },
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

import { loadConfig, logger } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { portfolioImportRoutes } from '../portfolio-import.routes';
import { importedCIId } from '../../controllers/portfolio-import.controller';
import { parseImport } from '../../../services/portfolio-import';
import {
  APP_GRANTS_SQL, APP_LOGIN, assertAppLogin, asTableOwner, createLoginRolesSql, ENTER_APP_LOGIN_SQL, journalReadAclSql,
  migrationSql,
} from './fixtures/app-login';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/portfolio/imports', portfolioImportRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
const token = (user: string) => `Bearer ${jwt.generateAccessToken(users[user]!._id, users[user]!._username,
  users[user]!._role as 'admin', users[user]!._organizationId)}`;
const FILE = readFileSync(join(__dirname, 'fixtures/happyhive-portfolio-export.jsonl'), 'utf8');
const forTenant = (file: string, org: string) => file.replace(A, org);
const post = (user: string, query: string, body: string) => request(app).post(`/api/v1/portfolio/imports${query}`)
  .set(KEY_CALLERS.includes(user) ? { 'x-api-key': `key-${users[user]!._id}` } : { authorization: token(user) })
  .set('content-type', 'application/x-ndjson').send(body);
const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const db = (sql: string) => mockSql(sql, [], 'exec');
const SERVICE = (n: number) => `5e1a0000-0000-4000-8000-00000000000${n}`;
const CI = (n: number) => `c1000000-0000-4000-8000-00000000000${n}`;
const SEEDED = 'bs-seeded-billing';

/** Everything an import can write, per tenant. */
async function state(org: string) {
  const count = async (table: string) => (await rows(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [org]))[0]!['n'];
  return {
    services: await count('dim_business_services'), offerings: await count('service_offerings'),
    mappings: (await rows(`SELECT count(*)::int AS n FROM ci_business_service_mappings m JOIN dim_business_services s
      ON s.service_id = m.service_id WHERE s.organization_id = $1`, [org]))[0]!['n'],
    imports: await count('portfolio_imports'), map: await count('portfolio_import_map'), audit: await count('audit_log'),
    journal: await count('ci_reconciliation_operations'),
    cis: [...mockGraph.nodes.values()].filter(node => node['organization_id'] === org).length,
    // Edges are `<from>-<LABEL>-><to>`; imported CI ids (hh_<hex>) hold no `-`.
    relationships: [...mockGraph.relationships].filter(edge => mockGraph.nodes.get(edge.split('-')[0]!)?.['organization_id'] === org).length,
  };
}
const NOTHING = { services: 1, offerings: 0, mappings: 0, imports: 0, map: 0, audit: 0, journal: 0, cis: 0, relationships: 0 };
/** The fixture applied once in tenant A: the Unassigned legacy service, 2 services, 2 CIs, 1 relationship, 2 links. */
const APPLIED = { services: 4, offerings: 3, mappings: 2, imports: 1, map: 9, audit: 13, journal: 4, cis: 2, relationships: 1 };
const LEGACY = 'unassigned-legacy';

const SERVICE_DEFAULTED = [
  { field: 'service_classification', value: 'other_it', reason: 'classification_defaulted' },
  { field: 'tbm_tower', value: 'other_it', reason: 'tbm_tower_defaulted' },
  { field: 'business_criticality', value: 'medium', reason: 'criticality_defaulted' },
];
const DRY_RUN_MAPPING = [
  { kind: 'service', source_id: LEGACY, target_id: null, action: 'create', defaulted: SERVICE_DEFAULTED },
  { kind: 'service', source_id: SERVICE(1), target_id: null, action: 'create',
    defaulted: [...SERVICE_DEFAULTED, { field: 'lifecycle', value: 'planned', reason: 'lifecycle_needs_owner_principal' }] },
  { kind: 'service', source_id: SERVICE(2), target_id: null, action: 'create', defaulted: SERVICE_DEFAULTED },
  { kind: 'service', source_id: SERVICE(3), target_id: SEEDED, action: 'match', reason: 'name_match' },
  { kind: 'ci', source_id: CI(1), target_id: null, action: 'create', defaulted: [] },
  { kind: 'ci', source_id: CI(2), target_id: null, action: 'create', defaulted: [
    { field: 'status', value: 'active', reason: 'status_defaulted' },
    { field: 'environment', value: 'development', reason: 'environment_defaulted' }] },
  { kind: 'ci', source_id: CI(3), target_id: null, action: 'skip', reason: 'ai_asset_source_owned' },
  { kind: 'ci', source_id: CI(4), target_id: null, action: 'skip', reason: 'unsupported_item_type' },
  { kind: 'relationship', source_id: '7e100000-0000-4000-8000-000000000001', target_id: null, action: 'create' },
  { kind: 'relationship', source_id: '7e100000-0000-4000-8000-000000000002', target_id: null, action: 'skip', reason: 'endpoint_skipped' },
  { kind: 'service_ci', source_id: `${SERVICE(1)}/${CI(1)}`, target_id: null, action: 'create' },
  { kind: 'service_ci', source_id: `${SERVICE(1)}/${CI(2)}`, target_id: null, action: 'create' },
];

beforeAll(async () => {
  const [{ name }] = await rows('SELECT current_database() AS name');
  const schema = migrationSql('001_complete_schema.sql');
  const ddl = (source: string, table: string) =>
    source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0];
  const tables = ['dim_business_services', 'business_service_dependencies', 'ci_business_service_mappings',
    'fact_business_service_incidents', 'fact_business_service_changes', 'audit_log', 'cmdb.dim_ci', 'ci_source_lineage',
    'ci_field_sources', 'reconciliation_conflicts', 'reconciliation_rules', 'source_authority', 'ci_change_history'];
  await db([createLoginRolesSql(name), 'CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!,
    ...tables.map(table => ddl(schema, table))].join('\n'));
  for (const file of ['003_audit_hash_chain.sql', '008_business_service_organization_scope.sql', '011_ci_organization_scope.sql',
    '028_change_history_reconciliation_org_provenance.sql', '029_reconciliation_conflict_identity_rules.sql',
    '037_reconciliation_org_contract.sql', '043_business_service_record_c1.sql', '046_service_offerings.sql',
    '048_portfolio_import.sql']) {
    await db(`BEGIN;\n${migrationSql(file)}\nCOMMIT;`);
  }
  // 045's rows for the journal and its evidence tables (045 itself needs the full schema and grants cmdb_app); the
  // ci_change_history column and constraint of 025/036 that the journal schema gate checks.
  await db(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organization_id UUID;
    ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
    GRANT SELECT, INSERT, UPDATE ON ci_reconciliation_operations, ci_reconciliation_epochs, ci_field_sources,
      ci_source_lineage, reconciliation_conflicts, source_authority TO ${APP_LOGIN};
    GRANT SELECT, INSERT, UPDATE, DELETE ON reconciliation_rules TO ${APP_LOGIN};
    GRANT SELECT, INSERT ON ci_change_history TO ${APP_LOGIN};
    ${APP_GRANTS_SQL}${journalReadAclSql()}${ENTER_APP_LOGIN_SQL}`);
}, 60000);
afterAll(() => { host.kill(); });

beforeEach(async () => {
  mockGraph.nodes.clear();
  mockGraph.fences.clear();
  mockGraph.relationships.clear();
  await asTableOwner(db, () => db(`TRUNCATE dim_business_services, service_offerings, ci_business_service_mappings,
      portfolio_import_map, portfolio_imports, audit_log, ci_reconciliation_operations RESTART IDENTITY CASCADE;
    INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
      operational_status, organization_id) VALUES ('${SEEDED}', 'Billing Portal', 'application', 'application', 'high',
      'active', '${A}'), ('bs-seeded-b', 'Payments', 'application', 'application', 'high', 'active', '${B}');`));
  await assertAppLogin(rows);
});
afterEach(() => assertAppLogin(rows));

it('A1: a dry run plans every line (create, match by name, skip with a reason, defaults named) and persists nothing', async () => {
  const res = await post('migrator', '?mode=dry_run', FILE);
  expect([res.status, res.body]).toEqual([200, { import_id: expect.any(String), mode: 'dry_run', mapping: DRY_RUN_MAPPING, rejected: [] }]);
  expect(await state(A)).toEqual(NOTHING);
});

it('refuses a missing or unknown mode and a tenant in the query (400) before reading the file; nothing written', async () => {
  const statuses = [(await post('migrator', '', FILE)).status, (await post('migrator', '?mode=commit', FILE)).status,
    (await post('migrator', `?mode=apply&organization_id=${B}`, FILE)).status, (await post('migrator', `?mode=apply&tenant_id=${A}`, FILE)).status];
  expect([statuses, await state(A), await state(B)]).toEqual([[400, 400, 400, 400], NOTHING, NOTHING]);
});

it('A2/A7: apply writes the plan with its id map and audit rows (import_id, defaults); re-applying creates nothing', async () => {
  const res = await post('migrator', '?mode=apply', FILE);
  expect(res.status).toBe(201);
  const importId = res.body.import_id as string;
  const ids = Object.fromEntries((res.body.mapping as Array<{ source_id: string; target_id: string }>)
    .map(entry => [entry.source_id, entry.target_id]));
  expect(res.body.mapping.map((entry: { action: string }) => entry.action)).toEqual(DRY_RUN_MAPPING.map(entry => entry.action));
  expect(await state(A)).toEqual(APPLIED);
  expect(await rows(`SELECT name, lifecycle, service_classification, business_criticality, owned_by, source_system, source_id
    FROM dim_business_services WHERE service_id = $1`, [ids[SERVICE(1)]])).toEqual([{ name: 'Payments', lifecycle: 'planned',
    service_classification: 'other_it', business_criticality: 'medium', owned_by: 'jane.doe', source_system: 'happyhive', source_id: SERVICE(1) }]);
  expect(await rows(`SELECT service_level FROM service_offerings WHERE service_id = $1`, [ids[SERVICE(1)]]))
    .toEqual([{ service_level: { response_target_hours: 4 } }]);
  expect([ids[CI(1)], mockGraph.nodes.get(ids[CI(2)]!)?.['environment'], mockGraph.relationships.has(`${ids[CI(1)]}-DEPENDS_ON->${ids[CI(2)]}`)])
    .toEqual([importedCIId(A, CI(1)), 'development', true]);
  const audit = await rows(`SELECT entity_type, entity_id, action, actor, changes, metadata FROM audit_log ORDER BY timestamp, id`);
  expect(audit.map(row => [row['entity_type'], row['action'], row['actor'], row['metadata']['import_id']])).toEqual([
    ['BUSINESS_SERVICE', 'CREATE', 'actor-m', importId], ['SERVICE_OFFERING', 'CREATE', 'actor-m', importId],
    ['BUSINESS_SERVICE', 'CREATE', 'actor-m', importId], ['SERVICE_OFFERING', 'CREATE', 'actor-m', importId],
    ['BUSINESS_SERVICE', 'CREATE', 'actor-m', importId], ['SERVICE_OFFERING', 'CREATE', 'actor-m', importId],
    ['BUSINESS_SERVICE', 'UPDATE', 'actor-m', importId],
    ['CI', 'CREATE', 'actor-m', importId], ['CI', 'CREATE', 'actor-m', importId],
    ['CI', 'RELATIONSHIP_ADD', 'actor-m', importId], ['CI', 'RELATIONSHIP_ADD', 'actor-m', importId],
    ['BUSINESS_SERVICE', 'UPDATE', 'actor-m', importId], ['BUSINESS_SERVICE', 'UPDATE', 'actor-m', importId],
  ]);
  // HAP-1625: the name match binding SERVICE(3) to the seeded service is audited on that service.
  expect([audit[6]!['entity_id'], audit[6]!['changes'], audit[6]!['metadata']['match']])
    .toEqual([SEEDED, [{ field: 'import_source_id', old_value: null, new_value: SERVICE(3) }], 'name_match']);
  expect([audit[2]!['metadata']['defaulted'], audit[8]!['metadata']['defaulted']])
    .toEqual([DRY_RUN_MAPPING[1]!.defaulted, DRY_RUN_MAPPING[5]!.defaulted]);

  const again = await post('migrator', '?mode=apply', FILE);
  expect([again.status, again.body.mapping.map((entry: { action: string; target_id: string | null }) => [entry.action, entry.target_id])])
    .toEqual([201, res.body.mapping.map((entry: { action: string; target_id: string | null }) =>
      [entry.action === 'create' ? 'match' : entry.action, entry.target_id])]);
  expect(await state(A)).toEqual({ ...APPLIED, imports: 2 });
});

it('scenario 8: a tenant\'s first apply creates one retired "Unassigned legacy" service; re-apply, another file and a dry run add no second', async () => {
  const legacy = (res: request.Response) => res.body.mapping.find((entry: { source_id: string }) => entry.source_id === LEGACY);
  const empty = (org: string) => `${FILE.split('\n')[0]!.replace(/"row_counts":\{[^}]*\}/,
    '"row_counts":{"service":0,"ci":0,"relationship":0,"service_ci":0}').replace(A, org)}\n`;
  const dry = await post('migrator', '?mode=dry_run', empty(A));
  expect([legacy(dry), await state(A)]).toEqual([{ kind: 'service', source_id: LEGACY, target_id: null, action: 'create',
    defaulted: SERVICE_DEFAULTED }, NOTHING]);
  const first = await post('migrator', '?mode=apply', FILE);
  const id = legacy(first).target_id as string;
  const runs = [await post('migrator', '?mode=apply', FILE), await post('migrator', '?mode=apply', empty(A)),
    await post('migrator', '?mode=dry_run', FILE)].map(res => [res.status, legacy(res)]);
  expect(runs).toEqual([201, 201, 200].map(status => [status, { kind: 'service', source_id: LEGACY, target_id: id, action: 'match' }]));
  const own = legacy(await post('migratorB', '?mode=apply', empty(B))).target_id;
  expect(await rows(`SELECT service_id, organization_id, name, lifecycle, source_system FROM dim_business_services
    WHERE source_id = $1 ORDER BY organization_id`, [LEGACY])).toEqual([
    { service_id: id, organization_id: A, name: 'Unassigned legacy', lifecycle: 'retired', source_system: 'happyhive' },
    { service_id: own, organization_id: B, name: 'Unassigned legacy', lifecycle: 'retired', source_system: 'happyhive' }]);
  expect(await rows(`SELECT lifecycle, metadata->>'import_id' AS import_id FROM service_offerings s JOIN audit_log a
    ON a.entity_id = s.service_id AND a.action = 'CREATE' WHERE s.service_id = $1`, [id]))
    .toEqual([{ lifecycle: 'retired', import_id: first.body.import_id }]);
  // A file line may not take the reserved source id, as a record or a reference.
  const taken = await post('migrator', '?mode=dry_run', FILE.replace('"service":3,', '"service":4,') +
    `{"kind":"service","source_id":"${LEGACY}","name":"Legacy","status":"draft"}\n`);
  expect(taken.body.rejected).toEqual([{ line: 13, code: 'invalid_field' }]);
});

it('re-link: a service-CI pair another writer linked first is mapped with no BUSINESS_SERVICE UPDATE audit row', async () => {
  mockFault.preLink = true;
  expect((await post('migrator', '?mode=apply', FILE)).status).toBe(201);
  expect([await state(A), (await rows(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'BUSINESS_SERVICE'
    AND action = 'UPDATE' AND metadata->>'match' IS NULL`))[0]!['n']]).toEqual([{ ...APPLIED, audit: APPLIED.audit - 1 }, 1]);
});

it('A3: two services of the same name are ambiguous: skipped, never matched', async () => {
  await asTableOwner(db, () => db(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
    business_criticality, operational_status, organization_id) VALUES ('bs-second-billing', 'billing portal', 'application',
    'application', 'high', 'active', '${A}')`));
  const res = await post('migrator', '?mode=dry_run', FILE);
  expect(res.body.mapping[3]).toEqual({ kind: 'service', source_id: SERVICE(3), target_id: null, action: 'skip', reason: 'ambiguous_name' });
});

it('A3 re-run: a name two file services share is ambiguous for the second, on the first apply and on every re-apply', async () => {
  const file = FILE.replace('"service":3,', '"service":4,') +
    `{"kind":"service","source_id":"${SERVICE(9)}","name":"Billing portal","status":"draft"}\n`;
  const outcomes = [];
  for (const run of [1, 2]) {
    const res = await post('migrator', '?mode=apply', file);
    outcomes.push([run, res.status, res.body.mapping.find((entry: { source_id: string }) => entry.source_id === SERVICE(9))]);
  }
  const skipped = { kind: 'service', source_id: SERVICE(9), target_id: null, action: 'skip', reason: 'ambiguous_name' };
  expect([outcomes, (await state(A)).services]).toEqual([[[1, 201, skipped], [2, 201, skipped]], 4]);
});

it('A4: an apply interrupted after a CI was created resumes on re-run: every record exactly once', async () => {
  mockFault.mapFault = CI(2);
  expect((await post('migrator', '?mode=apply', FILE)).status).toBe(500);
  expect(await state(A)).toMatchObject({ services: 4, cis: 2, relationships: 0, mappings: 0 });
  const res = await post('migrator', '?mode=apply', FILE);
  expect([res.status, res.body.mapping.find((entry: { source_id: string }) => entry.source_id === CI(2))])
    .toEqual([201, { kind: 'ci', source_id: CI(2), target_id: importedCIId(A, CI(2)), action: 'match' }]);
  expect(await state(A)).toEqual({ ...APPLIED, imports: 2 });
});

it('A5: a line with a credential-like or blob key is rejected by line number; its values reach no response, log, audit row or record', async () => {
  const SENTINEL = `sentinel-${randomUUID()}`;
  const spies = (['info', 'warn', 'error', 'debug'] as const).map(level => jest.spyOn(logger, level));
  const file = FILE.replace('"ci":4,', '"ci":8,') +
    `{"kind":"ci","source_id":"${CI(8)}","item_type":"server","name":"leaky","status":"active","attributes":{"nested":{"API-Key":"${SENTINEL}"}}}\n` +
    `{"kind":"ci","source_id":"${CI(9)}","item_type":"server","name":"blob","status":"active","configuration":{"note":"${SENTINEL}"}}\n` +
    `{"kind":"ci","source_id":"c1000000-0000-4000-8000-000000000010","item_type":"server","name":"pw","status":"active","attributes":{"db_pass":"${SENTINEL}"}}\n` +
    `{"kind":"ci","source_id":"c1000000-0000-4000-8000-000000000011","item_type":"server","name":"tenant","status":"active","attributes":{"x":{"organization_id":"${SENTINEL}"}}}\n`;
  const [dry, apply] = [await post('migrator', '?mode=dry_run', file), await post('migrator', '?mode=apply', file)];
  const rejected = [{ line: 13, code: 'forbidden_key' }, { line: 14, code: 'forbidden_key' }, { line: 15, code: 'forbidden_key' },
    { line: 16, code: 'invalid_field' }];
  expect([dry.status, dry.body.rejected, apply.status, apply.body.rejected]).toEqual([200, rejected, 422, rejected]);
  const seen = JSON.stringify([dry.body, apply.body, spies.map(spy => spy.mock.calls), await rows('SELECT * FROM audit_log'),
    [...mockGraph.nodes.values()]]);
  expect([seen.includes(SENTINEL), await state(A)]).toEqual([false, NOTHING]);
});

it('A5 keys (HAP-1625): a credential-like word of a key, camelCase split, is forbidden_key; descriptive look-alikes pass', () => {
  const forbidden = ['key', 'encryption_key', 'signingKey', 'primary_key', 'ssh_keys', 'auth', 'passcode', 'salt', 'dbPass',
    'rootPass', 'adminPass', 'config', 'configs', 'setting', 'settings'];
  const allowed = ['author', 'monkey', 'keyword', 'key_count', 'key_id'];
  const keys = [...forbidden, ...allowed];
  const header = FILE.split('\n')[0]!.replace(/"row_counts":\{[^}]*\}/,
    `"row_counts":{"service":0,"ci":${keys.length},"relationship":0,"service_ci":0}`);
  const parsed = parseImport([header, ...keys.map((key, index) => JSON.stringify(
    { kind: 'ci', source_id: `c-${index}`, item_type: 'server', name: key, attributes: { [key]: 'x' } }))].join('\n'), A);
  expect([parsed.rejected, parsed.records.map(record => 'name' in record ? record.name : null)])
    .toEqual([forbidden.map((_, index) => ({ line: index + 2, code: 'forbidden_key' })), allowed]);
});

it('A6 (HAP-1615): only the portfolio:import scope holder may import; admin, a platform admin\'s API key, every other role, a seeded account and a non-list scopes are 403 before the export is read; the holder\'s body over 1 MiB or 5,000 lines is 413; nothing written', async () => {
  const statuses = [];
  for (const user of ['admin', 'platform', 'operator', 'agent', 'viewer', 'seeded', 'listless']) {
    statuses.push((await post(user, '?mode=dry_run', FILE)).status, (await post(user, '?mode=apply', FILE)).status);
  }
  statuses.push((await post('admin', '?mode=apply', FILE.padEnd(1_048_577, ' '))).status);
  statuses.push((await post('migrator', '?mode=apply', FILE.padEnd(1_048_577, ' '))).status);
  statuses.push((await post('migrator', '?mode=apply', FILE + '{}\n'.repeat(5_000))).status);
  expect([statuses, await state(A)]).toEqual([[...Array(15).fill(403), 413, 413], NOTHING]);
});

it('HAP-1615: removing the holder\'s grant refuses its next request with the same API key; nothing more written', async () => {
  const applied = (await post('migrator', '?mode=apply', FILE)).status;
  users['migrator']!._scopes = [];
  try {
    expect([applied, (await post('migrator', '?mode=apply', FILE)).status, await state(A)]).toEqual([201, 403, APPLIED]);
  } finally {
    users['migrator']!._scopes = SCOPE;
  }
});

it('tenant isolation: another tenant\'s export is 422; the same source ids in tenant B map only to B\'s own records', async () => {
  expect([(await post('migratorB', '?mode=apply', FILE)).status, await state(B)]).toEqual([422, NOTHING]);
  expect((await post('migrator', '?mode=apply', FILE)).status).toBe(201);
  const res = await post('migratorB', '?mode=apply', forTenant(FILE, B));
  expect([res.status, res.body.mapping.slice(0, 5).map((entry: { action: string; reason?: string }) => [entry.action, entry.reason])])
    .toEqual([201, [['create', undefined], ['match', 'name_match'], ['create', undefined], ['create', undefined], ['create', undefined]]]);
  expect(res.body.mapping[1].target_id).toBe('bs-seeded-b');
  expect(res.body.mapping[4].target_id).toBe(importedCIId(B, CI(1)));
  expect(await state(B)).toMatchObject({ services: 4, cis: 2, relationships: 1, mappings: 2, map: 9 });
});

it('D4: a service-CI line naming a CI this tenant does not own (its map row points at another tenant\'s CI) is 422; nothing written', async () => {
  expect((await post('migratorB', '?mode=apply', forTenant(FILE, B))).status).toBe(201);
  // A map row of tenant A that names tenant B's CI (as a forged or stale row would).
  await asTableOwner(db, () => db(`INSERT INTO portfolio_imports (import_id, organization_id, source_system, mode, file_sha256,
      row_counts, actor) VALUES ('${randomUUID()}', '${A}', 'happyhive', 'apply', '${'0'.repeat(64)}', '{}', 'seed');
    INSERT INTO portfolio_import_map (organization_id, source_system, kind, source_id, target_id, import_id)
      SELECT '${A}', 'happyhive', 'ci', '${CI(7)}', '${importedCIId(B, CI(1))}', import_id FROM portfolio_imports
      WHERE organization_id = '${A}'`));
  const header = FILE.split('\n')[0]!.replace('"service_ci":2}', '"service_ci":1}')
    .replace(/"service":3,"ci":4,"relationship":2/, '"service":1,"ci":0,"relationship":0');
  const file = [header, FILE.split('\n')[1],
    `{"kind":"service_ci","service_source_id":"${SERVICE(1)}","ci_source_id":"${CI(7)}"}`].join('\n');
  const before = await state(A);
  const res = await post('migrator', '?mode=apply', file);
  expect([res.status, res.body.rejected, await state(A)]).toEqual([422, [{ line: 3, code: 'unknown_reference' }], before]);
});

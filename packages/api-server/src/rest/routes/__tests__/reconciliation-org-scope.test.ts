// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** LH-5: mounted REST/GraphQL over the real reconciliation SQL tables and CI dimension. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const CI_A = '11111111-1111-4111-8111-111111111111';
const CI_B = '22222222-2222-4222-8222-222222222222';
const CI_NULL = '33333333-3333-4333-8333-333333333333';
const MISSING = '44444444-4444-4444-8444-444444444444';
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});
const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<Record<string, unknown>[]>>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, unknown>[]; error?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(new Error(error));
  else call.resolve(rows);
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query'): Promise<Record<string, unknown>[]> {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>[]>();
  pending.set(id, { promise, resolve, reject });
  host.send({ id, op, sql: text, params });
  return promise;
}
const db = { query: async (text: string, params: unknown[] = []) => ({ rows: await sql(text, params) }) };
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => db,
  getNeo4jClient: () => ({ assertJournalReady: async () => undefined, // schema present (the real §3.2 gate: hp1-s4b-merge-conflicts)
    getCI: async (id: string, organizationId: string) =>
      (id === CI_A && organizationId === A) || (id === CI_B && organizationId === B) ? { id } : null,
  }),
}));
jest.mock('@cmdb/identity-resolution', () => ({ getIdentityReconciliationEngine: () => ({}) }));
// Authentication and organization rehydration are the production middleware
// from #49; only the identity store is substituted.
const users: Record<string, { _id: string; _username: string; _role: 'operator'; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'operator', _enabled: true },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => users[id] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));
jest.mock('../../../middleware/audit.middleware', () => ({ auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next() }));

import { loadConfig } from '@cmdb/common';
import { getNeo4jClient } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import type { TokenPayload } from '../../../auth/types';
import { reconciliationRoutes } from '../reconciliation.routes';
import { reconciliationResolvers } from '../../../graphql/resolvers/reconciliation.resolvers';
import { reconciliationTypeDefs } from '../../../graphql/schema/reconciliation.schema';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/reconciliation', reconciliationRoutes);
const gqlApp = express();
let server: ApolloServer;
const jwt = new JWTService(loadConfig().auth.jwt);
// The unverified principal even carries a stale org-A claim; #49 must ignore it.
const bearer = (organization: string) => {
  const id = organization === 'a' ? 'user-a' : organization === 'b' ? 'user-b' : 'user-none';
  return `Bearer ${jwt.generateAccessToken(id, users[id]._username, 'operator', A)}`;
};
const api = (organization: string, path: string) => request(app).get(`/api/v1/reconciliation/${path}`).set('authorization', bearer(organization));
const post = (organization: string, id: string) => request(app).post(`/api/v1/reconciliation/conflicts/${id}/resolve`).set('authorization', bearer(organization)).send({ resolution: 'accept_source' });
const gql = (organization: string, query: string) => request(gqlApp).post('/graphql').set('authorization', bearer(organization)).send({ query });
const cid = (n: number) => `55555555-5555-4555-8555-55555555555${n}`;
const migration = join(__dirname, '../../../../../database/src/postgres/migrations');

beforeAll(async () => {
  const schema = readFileSync(join(migration, '001_complete_schema.sql'), 'utf8');
  const tables = ['cmdb.dim_ci', 'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts', 'reconciliation_rules', 'source_authority'];
  await sql('CREATE SCHEMA cmdb;\n' + tables.map(table => {
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`Missing DDL ${table}`);
    return match[0];
  }).join('\n'), [], 'exec');
  await sql(readFileSync(join(migration, '011_ci_organization_scope.sql'), 'utf8'), [], 'exec');
  const journalMigration = readFileSync(join(migration, '028_change_history_reconciliation_org_provenance.sql'), 'utf8');
  const provenance = ['ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts'].map(table => {
    const match = journalMigration.match(new RegExp(`ALTER TABLE ${table}\\s+[\\s\\S]*?;`));
    if (!match) throw new Error(`Missing provenance DDL ${table}`);
    return match[0];
  });
  const journalTable = journalMigration.match(/CREATE TABLE IF NOT EXISTS ci_reconciliation_operations \([\s\S]*?\n\);/);
  if (!journalTable) throw new Error('Missing journal DDL');
  await sql([...provenance, journalTable[0]].join('\n'), [], 'exec');
  await sql(readFileSync(join(migration, '029_reconciliation_conflict_identity_rules.sql'), 'utf8'), [], 'exec');
  // Simulate an unsafely imported legacy NULL-org row; production migration 011 disallows new NULLs.
  await sql('ALTER TABLE cmdb.dim_ci ALTER COLUMN organization_id DROP NOT NULL', [], 'exec');
  server = new ApolloServer({
    typeDefs: [`scalar JSON\ntype Query { health: String }\ntype Mutation { health: String }`, reconciliationTypeDefs],
    resolvers: reconciliationResolvers,
  });
  await server.start();
  gqlApp.use('/graphql', express.json(), getAuthMiddleware().authenticate(),
    expressMiddleware(server, { context: async ({ req }) => ({
      user: (req as Request & { user: TokenPayload }).user, _neo4jClient: getNeo4jClient(),
    }) }));
});
afterAll(async () => { await server?.stop(); host.kill(); });
beforeEach(async () => {
  await sql('TRUNCATE reconciliation_conflicts, ci_source_lineage, ci_field_sources, cmdb.dim_ci, reconciliation_rules, source_authority', [], 'exec');
  await sql(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id) VALUES
    ('${CI_A}', 'A', 'server', 'active', '${A}'),
    ('${CI_B}', 'B', 'server', 'active', '${B}'),
    ('${CI_NULL}', 'legacy', 'server', 'active', NULL)`, [], 'exec');
  for (const [index, ci] of [CI_A, CI_B, CI_NULL].entries()) {
    const org = index === 0 ? A : index === 1 ? B : null;
    await sql(`INSERT INTO ci_source_lineage(ci_id, source_name, source_id, confidence_score, organization_id) VALUES ($1, $2, $3, 90, $4)`, [ci, `source-${index}`, `secret-${index}`, org]);
    await sql(`INSERT INTO ci_field_sources(ci_id, field_name, field_value, source_name, organization_id) VALUES ($1, 'password', $2, $3, $4)`, [ci, `value-${index}`, `source-${index}`, org]);
    await sql(`INSERT INTO reconciliation_conflicts(id, ci_id, conflict_type, source_data, target_data, conflicting_fields, organization_id)
      VALUES ($1, $2, 'field_conflict', $3, $4, '["password"]', $5)`, [cid(index), ci, JSON.stringify({ secret: `source-${index}` }), JSON.stringify({ secret: `target-${index}` }), org]);
  }
});
it('lists only owned conflicts with matching total and no foreign/NULL metadata via REST and mounted GraphQL', async () => {
  const rest = await api('a', 'conflicts');
  expect(rest.status).toBe(200);
  expect(rest.body.pagination.total).toBe(1);
  expect(rest.body.data.map((row: { id: string }) => row.id)).toEqual([cid(0)]);
  const graph = await gql('a', '{ _reconciliation { listConflicts { _id _sourceData _targetData } } }');
  expect(graph.body.errors).toBeUndefined();
  expect(graph.body.data._reconciliation.listConflicts).toEqual([{ _id: cid(0), _sourceData: { secret: 'source-0' }, _targetData: { secret: 'target-0' } }]);
  expect((await api('b', 'conflicts')).body.data[0].id).toBe(cid(1));
});

it('refuses an authenticated caller without a verified organization on every metadata path', async () => {
  for (const path of ['conflicts', `lineage/${CI_A}`, `field-sources/${CI_A}`]) {
    expect((await api('unverified', path)).status).toBe(403);
  }
  expect((await post('unverified', cid(0))).status).toBe(403);
  for (const query of [
    '{ _reconciliation { listConflicts { _id } } }',
    `{ _reconciliation { getCILineage(_ciId: "${CI_A}") { _ciId } } }`,
    `{ _reconciliation { getCIFieldSources(_ciId: "${CI_A}") { _ciId } } }`,
    `mutation { _reconciliation { resolveConflict(_id: "${cid(0)}", _resolution: "merge", _expectedRevision: "r") { _id } } }`,
  ]) {
    expect((await gql('unverified', query)).body.errors[0].extensions.code).toBe('FORBIDDEN');
  }
  expect((await sql('SELECT status FROM reconciliation_conflicts WHERE id = $1', [cid(0)]))[0].status).toBe('pending');
});

for (const [route, field, graphField, detail] of [
  ['lineage', 'sources', '_sources', '_sourceId'],
  ['field-sources', 'fields', '_fields', '_fieldValue'],
] as const) {
  it(`${route} returns owned values, identical foreign/missing/NULL not-found across REST and GraphQL`, async () => {
    const own = await api('a', `${route}/${CI_A}`);
    expect(own.status).toBe(200);
    expect(own.body.data[field]).toHaveLength(1);
    const absent = await api('a', `${route}/${MISSING}`);
    expect(absent.status).toBe(404);
    expect((await api('a', `${route}/${CI_B}`)).text).toBe(absent.text); // byte-identical
    expect((await api('a', `${route}/${CI_NULL}`)).text).toBe(absent.text);
    const gqlName = route === 'lineage' ? 'getCILineage' : 'getCIFieldSources';
    const ownGraph = await gql('a', `{ _reconciliation { ${gqlName}(_ciId: "${CI_A}") { ${graphField} { ${detail} } } } }`);
    expect(ownGraph.body.errors).toBeUndefined();
    expect(ownGraph.body.data._reconciliation[gqlName][graphField]).toHaveLength(1);
    await sql(`DELETE FROM ${route === 'lineage' ? 'ci_source_lineage' : 'ci_field_sources'} WHERE ci_id = $1`, [CI_A]);
    expect((await api('a', `${route}/${CI_A}`)).body.data[field]).toEqual([]);
    const emptyGraph = await gql('a', `{ _reconciliation { ${gqlName}(_ciId: "${CI_A}") { ${graphField} { ${detail} } } } }`);
    expect(emptyGraph.body.errors).toBeUndefined();
    expect(emptyGraph.body.data._reconciliation[gqlName][graphField]).toEqual([]);
    const outcomes = await Promise.all([MISSING, CI_B, CI_NULL].map(id => gql('a', `{ _reconciliation { ${gqlName}(_ciId: "${id}") { _ciId } } }`)));
    expect(outcomes.map(outcome => outcome.body.errors[0].extensions.code)).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
    expect(outcomes[1].text).toBe(outcomes[0].text); // byte-identical, GraphQL parity
    expect(outcomes[2].text).toBe(outcomes[0].text);
  });
}

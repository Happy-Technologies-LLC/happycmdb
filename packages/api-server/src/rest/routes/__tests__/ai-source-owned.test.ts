// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1442 (AAI S1): the four AI CI classes are source-owned. AISyncWriter is the only path that creates or changes
 * them (journaled createCI/updateCIProperties, natural-key idempotent, one chained audit row per write by
 * `sync:<stream>`); REST POST/PUT/DELETE /api/v1/cis, the GraphQL CI mutations and reconciliation merges are refused
 * with 409 `source_owned` before T1, so they write nothing. Mounted ciRoutes and reconciliation routes with real JWT
 * auth, journal, engine and AuditService on PGlite as the non-owner app login cmdb_user (HAP-1422 guard);
 * Neo4j is an in-memory node map that records every graph write.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
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
function mockSql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const call = Promise.withResolvers<{ rows: Record<string, any>[]; rowCount: number }>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}
jest.mock('pg', () => {
  const actual = jest.requireActual('pg');
  class Pool {
    options = {};
    on() { return this; }
    query(text: string, params?: unknown[]) { return mockSql(text, params); }
    async connect() { return { query: (text: string, params?: unknown[]) => mockSql(text, params), release: () => undefined }; }
    async end() { return undefined; }
  }
  return { ...actual, Pool, default: { ...actual, Pool } };
});
const mockGraph = { nodes: new Map<string, Record<string, unknown>>(), fences: new Map<string, Record<string, unknown>>(),
  writes: [] as string[] };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const owned = (id: unknown, org: unknown) => {
    const node = mockGraph.nodes.get(id as string);
    return node?.['organization_id'] === org ? node : undefined;
  };
  const run = async (query: string, params: Record<string, any> = {}) => {
    if (query.includes('SHOW CONSTRAINTS')) return { records: [record({ present: 1 })] };
    if (query.includes('MERGE (op:ReconciliationOp')) {
      return { records: [record(mockGraph.fences.get(params['op']) ?? { outcome: 'aborted', org: params['org'], ci: params['ci'], operation: params['operation'] })] };
    }
    if (query.includes('fences_created')) {
      mockGraph.writes.push(query);
      let node = owned(params['id'], params['org']);
      if (query.startsWith('CREATE (ci:CI')) {
        if (mockGraph.nodes.has(params['id'])) throw Object.assign(new Error('ci_id_unique'), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' });
        node = { ...params['props'], id: params['id'], organization_id: params['org'] };
        mockGraph.nodes.set(params['id'], node);
      } else if (query.includes('DETACH DELETE')) {
        if (node) mockGraph.nodes.delete(params['id']);
      } else if (node) Object.assign(node, params['props']);
      for (const fence of node ? params['fences'] : []) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: node ? params['fences'].length : 0 })] };
    }
    if (query.includes('UNWIND range(0, size($ciIds) - 1)')) { // the engine's lineage match
      const hit = (params['ciIds'] as string[]).find(id => owned(id, params['organizationId']));
      return { records: hit ? [record({ ci_id: hit })] : [] };
    }
    const node = owned(params['id'], params['organizationId']);
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    mockGraph.writes.push(query); // an unrecognised statement counts as a graph write
    throw new Error(`unexpected statement: ${query}`);
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
jest.mock('@cmdb/event-processor', () => ({
  ...jest.requireActual('@cmdb/event-processor'), getEventProducer: () => ({ emit: async () => [] }),
}));
const admin = { _id: 'actor-a', _username: 'alice', _role: 'admin' as const, _enabled: true, _organizationId: A };
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => (id === admin._id ? admin : null), findApiKeyByKey: async () => null })),
}));
jest.mock('../../../middleware/audit.middleware', () => ({ auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next() }));

import { loadConfig, SourceOwnedError, type CIInput } from '@cmdb/common';
import { AISyncWriter, AISyncWriteRefused, getAuditService, getNeo4jClient, getPostgresClient, type AISyncStream } from '@cmdb/database';
import { getIdentityReconciliationEngine } from '@cmdb/identity-resolution';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { resolvers } from '../../../graphql/resolvers';
import { ciRoutes } from '../ci.routes';
import { itilRoutes } from '../itil.routes';
import { reconciliationRoutes } from '../reconciliation.routes';
import { relationshipRoutes } from '../relationship.routes';
import { APP_GRANTS_SQL, ENTER_APP_LOGIN_SQL, assertAppLogin, createLoginRolesSql, journalReadAclSql } from './fixtures/app-login';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
app.use('/api/v1/reconciliation', reconciliationRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
app.use('/api/v1/itil', itilRoutes);
const bearer = `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken(admin._id, admin._username, admin._role, A)}`;
const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const digest = (hex: string) => `sha256:${hex.repeat(64)}`;
const CLASSES = ['agent-release', 'ai-model', 'cell', 'ai-deployment'] as const;
type AIClass = typeof CLASSES[number];
const SAMPLES: Record<AIClass, ['c4_releases' | 'c8_cells' | 'c8_admissions', Record<string, string | number>]> = {
  'agent-release': ['c4_releases', { release_digest: digest('a'), release_status: 'approved', config_digest: digest('c') }],
  'ai-model': ['c4_releases', { model_id: 'model-1', profile: 'default' }],
  'cell': ['c8_cells', { cell_id: 'cell-1', cell_status: 'running' }],
  'ai-deployment': ['c8_admissions', { cell_id: 'cell-1', release_digest: digest('a'), running_count: 1 }],
};
const ids = {} as Record<AIClass, string>;
/** Everything a refused write must leave as it was: the node, journal, audit chain, evidence and graph writes. */
const snapshot = async (id: string) => ({
  node: { ...mockGraph.nodes.get(id) }, graphWrites: mockGraph.writes.length,
  ...(await rows(`SELECT (SELECT count(*)::int FROM ci_reconciliation_operations) AS ops,
    (SELECT count(*)::int FROM audit_log) AS audit, (SELECT count(*)::int FROM ci_field_sources) AS fields,
    (SELECT count(*)::int FROM reconciliation_conflicts) AS conflicts, (SELECT count(*)::int FROM ci_change_history) AS history`))[0],
});
const sourceOwned = { status: 409, code: 'source_owned' };

beforeAll(async () => {
  const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
  const sql = (file: string) => readFileSync(join(migrations, file), 'utf8');
  const schema = sql('001_complete_schema.sql');
  await mockSql(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ...['audit_log', 'cmdb.dim_ci',
    'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts', 'reconciliation_rules', 'source_authority', 'ci_change_history',
    'dim_business_services'].map(table => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0])]
    .join('\n'), [], 'exec');
  for (const file of ['003_audit_hash_chain.sql', '011_ci_organization_scope.sql', '028_change_history_reconciliation_org_provenance.sql',
    '029_reconciliation_conflict_identity_rules.sql', '037_reconciliation_org_contract.sql']) await mockSql(sql(file), [], 'exec');
  await mockSql(`ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required CHECK (organization_id IS NOT NULL) NOT VALID;
    ${['drift_detection_results', 'baseline_snapshots', 'ci_criticality_scores'].map(table =>
    `CREATE TABLE ${table} (organization_id UUID, ci_id TEXT, ci_incarnation_id UUID);`).join(' ')}
    CREATE TABLE impact_analyses (organization_id UUID, source_ci_id TEXT, ci_incarnation_id UUID);
    CREATE TABLE itil_baselines (id UUID PRIMARY KEY, organization_id UUID NOT NULL, baseline_data JSONB NOT NULL);`,
  [], 'exec'); // 025, 036 (S4a); a delete's derived-row purge reads only these columns
  const [{ db }] = (await mockSql('SELECT current_database() AS db')).rows;
  // The app login holds the fixture grants plus the journal and evidence grants 045 gives the staging app login.
  await mockSql(`${createLoginRolesSql(db)} RESET ROLE; ${APP_GRANTS_SQL} ${journalReadAclSql()}
    GRANT SELECT, INSERT, UPDATE ON ci_reconciliation_operations, ci_reconciliation_epochs, ci_field_sources, ci_source_lineage,
      reconciliation_conflicts, source_authority TO cmdb_user;
    GRANT SELECT ON reconciliation_rules TO cmdb_user; GRANT SELECT, INSERT ON ci_change_history TO cmdb_user;
    GRANT SELECT, DELETE ON drift_detection_results, baseline_snapshots, ci_criticality_scores, impact_analyses TO cmdb_user;
    GRANT SELECT, INSERT ON itil_baselines TO cmdb_user;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public, cmdb TO cmdb_user; ${ENTER_APP_LOGIN_SQL}`, [], 'exec');
  await assertAppLogin(async text => (await mockSql(text)).rows);
  // Given one CI of each class (as a sync would leave it), so every refusal below runs against an existing AI CI.
  for (const cls of CLASSES) {
    ids[cls] = randomUUID();
    mockGraph.nodes.set(ids[cls], { id: ids[cls], organization_id: A, name: `${cls} sample`, type: cls, lifecycle: 'live',
      authoritative_source: SAMPLES[cls][0] === 'c4_releases' ? 'happylab-c4' : 'hivecell-c8', incarnation_id: randomUUID(), ...SAMPLES[cls][1] });
  }
}, 60000);
afterAll(() => { host.kill(); });

it('S1: an agent-release written by the sync writer exists in Neo4j and PostgreSQL as happylab-c4; a second write of the same digest updates it, never a duplicate', async () => {
  const writer = new AISyncWriter(getNeo4jClient());
  const D = digest('1');
  const first = await writer.upsert(A, 'c4_releases', { class: 'agent-release', name: 'release one',
    attributes: { release_digest: D, release_status: 'approved', config_digest: digest('2') } });
  const second = await writer.upsert(A, 'c4_releases', { class: 'agent-release', name: 'release one',
    attributes: { release_digest: D, release_status: 'revoked', config_digest: digest('2') } });
  expect([first.action, second.action, second.ciId]).toEqual(['created', 'updated', first.ciId]);
  expect([...mockGraph.nodes.values()].filter(node => node['release_digest'] === D)).toEqual([expect.objectContaining({
    id: first.ciId, organization_id: A, type: 'agent-release', authoritative_source: 'happylab-c4', lifecycle: 'live',
    release_digest: D, release_status: 'revoked' })]);
  expect(await rows(`SELECT operation, state, actor FROM ci_reconciliation_operations WHERE ci_id = $1 ORDER BY created_at`, [first.ciId]))
    .toEqual([{ operation: 'direct_write', state: 'committed', actor: 'sync:c4_releases' },
      { operation: 'direct_write', state: 'committed', actor: 'sync:c4_releases' }]);
  const [created] = await rows(`SELECT changes FROM audit_log WHERE entity_id = $1 AND action = 'CREATE'`, [first.ciId]);
  expect(created!['changes']).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'authoritative_source', new_value: 'happylab-c4' }),
    expect.objectContaining({ field: 'release_digest', new_value: D })]));
});

it('S6: every sync-writer write (create and update, each stream) appends exactly one hash-chained audit_log row by sync:<stream>', async () => {
  const writer = new AISyncWriter(getNeo4jClient());
  for (const cls of CLASSES) {
    const [stream, attributes] = SAMPLES[cls];
    for (const [name, action] of [[`${cls} synced`, 'CREATE'], [`${cls} renamed`, 'UPDATE']] as const) {
      const [before] = await rows('SELECT count(*)::int AS n FROM audit_log');
      const { ciId } = await writer.upsert(A, stream, { class: cls, name, attributes });
      expect(await rows('SELECT count(*)::int AS n FROM audit_log')).toEqual([{ n: before!['n'] + 1 }]);
      expect(await rows(`SELECT entity_id, action, actor, actor_type, organization_id FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT 1`))
        .toEqual([{ entity_id: ciId, action, actor: `sync:${stream}`, actor_type: 'system', organization_id: A }]);
    }
  }
  expect(await getAuditService(getPostgresClient().pool).verifyAuditChain()).toMatchObject({ ok: true });
});

it('HAP-1608 A: audit actor_type is the writer\'s explicit type, never read from the actor id', async () => {
  // A user whose id starts `sync:` stays a user; identity reconciliation writes as system (the sync writer: S6).
  const plain = randomUUID();
  await getNeo4jClient().createCI({ _id: plain, name: 'plain', _type: 'server' } as CIInput, A, 'sync:c4_releases');
  await rows(`INSERT INTO ci_source_lineage (organization_id, ci_id, source_name, source_id) VALUES ($1, $2, 'disc', 'disc-1')`, [A, plain]);
  const engine = getIdentityReconciliationEngine();
  await engine.reconcileCI({ name: 'plain', ci_type: 'server', source: 'disc', source_id: 'disc-1',
    identifiers: { external_id: 'disc-1' }, attributes: { owner: 'ops' }, confidence_score: 90 }, A);
  expect(await rows(`SELECT action, actor, actor_type FROM audit_log WHERE entity_id = $1 ORDER BY timestamp, id`, [plain]))
    .toEqual([{ action: 'CREATE', actor: 'sync:c4_releases', actor_type: 'user' },
      { action: 'UPDATE', actor: 'system:identity-reconciliation', actor_type: 'system' }]);
  expect(await getAuditService(getPostgresClient().pool).verifyAuditChain()).toMatchObject({ ok: true });
});

describe('S2: REST /api/v1/cis refuses every AI class with 409 source_owned and writes nothing', () => {
  const cases = CLASSES.flatMap(cls => (['POST', 'PUT', 'DELETE'] as const).map(verb => [verb, cls] as const));
  it.each(cases)('%s /api/v1/cis %s is 409 source_owned and writes nothing', async (verb, cls) => {
    const server = randomUUID();
    mockGraph.nodes.set(server, { id: server, organization_id: A, name: 'plain', type: 'server', incarnation_id: randomUUID() });
    const before = [await snapshot(ids[cls]), await snapshot(server)];
    const calls = verb === 'POST' ? [request(app).post('/api/v1/cis').send({ name: 'forged', type: cls })]
      : verb === 'DELETE' ? [request(app).delete(`/api/v1/cis/${ids[cls]}`)]
      // An update of the AI CI, and an update that would turn a plain CI into this class.
        : [request(app).put(`/api/v1/cis/${ids[cls]}`).send({ name: 'forged' }), request(app).put(`/api/v1/cis/${server}`).send({ type: cls })];
    for (const call of calls) {
      const res = await call.set('authorization', bearer);
      expect({ status: res.status, code: res.body.code }).toEqual(sourceOwned);
    }
    expect([await snapshot(ids[cls]), await snapshot(server)]).toEqual(before);
    expect([...mockGraph.nodes.values()].filter(node => node['name'] === 'forged')).toEqual([]);
  });
});

it('S3/N1: a merge from a source with higher authority than happylab-c4 cannot change release_digest, release_status or config_digest; a merge creating an AI class is refused', async () => {
  const id = ids['agent-release'];
  // The organization's policy ranks the rogue source above happylab-c4, which owns the three fields today.
  await rows(`INSERT INTO source_authority (organization_id, source_name, authority_score) VALUES ($1, 'happylab-c4', 5), ($1, 'rogue', 10)`, [A]);
  for (const field of ['release_digest', 'release_status', 'config_digest']) {
    const value = SAMPLES['agent-release'][1][field];
    await rows(`INSERT INTO ci_field_sources (organization_id, ci_id, field_name, field_value, value_json, source_name)
      VALUES ($1, $2, $3, $4, $5, 'happylab-c4')`, [A, id, field, value, JSON.stringify(value)]);
  }
  // The rogue source already identifies the CI (its lineage), so the engine matches and would merge field by field.
  await rows(`INSERT INTO ci_source_lineage (organization_id, ci_id, source_name, source_id) VALUES ($1, $2, 'rogue', 'rogue-1')`, [A, id]);
  const before = await snapshot(id);
  const attributes = { release_digest: digest('e'), release_status: 'revoked', config_digest: digest('f') };
  const merge = (body: object) => request(app).post('/api/v1/reconciliation/merge').set('authorization', bearer)
    .send({ name: 'rogue', source: 'rogue', attributes, ...body });
  for (const res of [await merge({ ci_type: 'server', source_id: 'rogue-1', identifiers: { external_id: 'rogue-1' } }),
    await merge({ ci_type: 'agent-release', source_id: 'rogue-2', identifiers: { external_id: 'rogue-2' } })]) {
    expect({ status: res.status, code: res.body.code }).toEqual(sourceOwned);
  }
  expect(await snapshot(id)).toEqual(before);
  expect(mockGraph.nodes.get(id)).toMatchObject(SAMPLES['agent-release'][1]);
});

it('N1: a relationship write touching an AI CI is refused with source_owned (the sync writer adds INSTANCE_OF in S3/S4)', async () => {
  const server = randomUUID();
  mockGraph.nodes.set(server, { id: server, organization_id: A, name: 'plain', type: 'server', incarnation_id: randomUUID() });
  const before = [await snapshot(ids['ai-deployment']), await snapshot(server)];
  for (const body of [{ from_id: ids['ai-deployment'], to_id: ids['agent-release'], type: 'INSTANCE_OF' },
    { from_id: server, to_id: ids['cell'], type: 'DEPENDS_ON' }]) {
    const res = await request(app).post('/api/v1/relationships').set('authorization', bearer).send(body);
    expect({ status: res.status, code: res.body.code }).toEqual(sourceOwned);
  }
  expect([await snapshot(ids['ai-deployment']), await snapshot(server)]).toEqual(before);
});

it('N1: resolving a type conflict (accept_source or merge) cannot give a plain CI an AI class', async () => {
  const server = randomUUID();
  mockGraph.nodes.set(server, { id: server, organization_id: A, name: 'plain', type: 'server', incarnation_id: randomUUID() });
  // A fresh pending conflict on `type`: the stored field source matches the conflict's target.
  await rows(`INSERT INTO ci_field_sources (organization_id, ci_id, field_name, field_value, value_json, source_name)
    VALUES ($1, $2, 'type', 'server', '"server"', 'cmdb')`, [A, server]);
  const revision = 'f'.repeat(64);
  const [conflict] = await rows(`INSERT INTO reconciliation_conflicts (id, organization_id, ci_id, conflict_type, source_data,
      target_data, conflicting_fields, field_name, source_name, source_id, incoming_json, target_json, target_source_name, content_hash,
      detected_by)
    VALUES ($1, $2, $3, 'field_conflict', '{}', '{}', '["type"]', 'type', 'rogue', 'rogue-3', '"agent-release"', '"server"', 'cmdb', $4,
      'actor-a') RETURNING id`, [randomUUID(), A, server, revision]);
  const before = await snapshot(server);
  const resolve = (body: object) => request(app).post(`/api/v1/reconciliation/conflicts/${conflict!['id']}/resolve`)
    .set('authorization', bearer).send({ expected_revision: revision, ...body });
  for (const res of [await resolve({ resolution: 'accept_source' }), await resolve({ resolution: 'merge', merged_data: 'AI_MODEL' })]) {
    expect({ status: res.status, code: res.body.code }).toEqual(sourceOwned);
  }
  expect(await snapshot(server)).toEqual(before);
});

it('S4: the GraphQL createCI, updateCI and deleteCI mutations on an AI class are refused with source_owned and write nothing', async () => {
  const context = { _neo4jClient: getNeo4jClient(), user: { _userId: admin._id, _username: admin._username, _role: admin._role,
    _type: 'access' as const, _organizationId: A },
  _loaders: { _ciLoader: { clear: () => undefined }, _relationshipLoader: { clearAll: () => undefined }, _dependentLoader: { clearAll: () => undefined } } };
  const code = (call: Promise<unknown>) => call.then(() => 'resolved', (error: { extensions?: { code?: string } }) => error.extensions?.code);
  const mutation = resolvers.Mutation as Record<string, (parent: unknown, args: unknown, ctx: unknown) => Promise<unknown>>;
  for (const cls of CLASSES) {
    const before = await snapshot(ids[cls]);
    expect([
      await code(mutation['createCI']!(null, { input: { _name: 'forged', _type: cls.toUpperCase().replace(/-/g, '_') } }, context)),
      await code(mutation['updateCI']!(null, { id: ids[cls], input: { _name: 'forged' } }, context)),
      await code(mutation['deleteCI']!(null, { id: ids[cls] }, context)),
    ]).toEqual(['source_owned', 'source_owned', 'source_owned']);
    expect(await snapshot(ids[cls])).toEqual(before);
  }
});

it('A1: an upsert without lifecycle keeps a retired AI CI retired; only a create defaults lifecycle to live', async () => {
  const writer = new AISyncWriter(getNeo4jClient());
  const write = { class: 'cell' as const, name: 'cell to retire', attributes: { cell_id: 'cell-retire', cell_status: 'stopped' } };
  const { ciId } = await writer.upsert(A, 'c8_cells', write);
  expect(mockGraph.nodes.get(ciId)).toMatchObject({ lifecycle: 'live' });
  await writer.upsert(A, 'c8_cells', { ...write, lifecycle: 'retired' });
  await writer.upsert(A, 'c8_cells', { ...write, name: 'cell renamed' });
  expect(mockGraph.nodes.get(ciId)).toMatchObject({ name: 'cell renamed', lifecycle: 'retired' });
});

it('A2: a stream named after an Object.prototype member is AISyncWriteRefused and writes nothing', async () => {
  const writer = new AISyncWriter(getNeo4jClient());
  const before = await snapshot(ids['cell']);
  for (const stream of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await expect(writer.upsert(A, stream as AISyncStream, { class: 'cell', name: 'forged', attributes: { cell_id: 'cell-1' } }))
      .rejects.toBeInstanceOf(AISyncWriteRefused);
  }
  expect(await snapshot(ids['cell'])).toEqual(before);
});

describe('A4: every other write path refuses an AI CI with source_owned and writes nothing', () => {
  it('ITIL PATCH lifecycle and status of an AI CI are 409 source_owned', async () => {
    for (const cls of CLASSES) {
      const before = await snapshot(ids[cls]);
      for (const [path, body] of [['lifecycle', { stage: 'RETIRE' }], ['status', { status: 'RETIRED' }]] as const) {
        const res = await request(app).patch(`/api/v1/itil/configuration-items/${ids[cls]}/${path}`).set('authorization', bearer).send(body);
        expect({ status: res.status, code: res.body.code }).toEqual(sourceOwned);
      }
      expect(await snapshot(ids[cls])).toEqual(before);
    }
  });

  it('ITIL baseline restore onto an AI CI is 409 source_owned', async () => {
    for (const cls of CLASSES) {
      const baseline = randomUUID();
      await rows('INSERT INTO itil_baselines (id, organization_id, baseline_data) VALUES ($1, $2, $3)',
        [baseline, A, JSON.stringify({ [ids[cls]]: { name: 'forged', release_status: 'revoked' } })]);
      const before = await snapshot(ids[cls]);
      const res = await request(app).post(`/api/v1/itil/baselines/${baseline}/restore`).set('authorization', bearer)
        .send({ ciId: ids[cls], performedBy: admin._id });
      expect({ status: res.status, code: res.body.code }).toEqual(sourceOwned);
      expect(await snapshot(ids[cls])).toEqual(before);
    }
  });

  it('REST DELETE /api/v1/relationships with an AI endpoint is 409 source_owned', async () => {
    const server = randomUUID();
    mockGraph.nodes.set(server, { id: server, organization_id: A, name: 'plain', type: 'server', incarnation_id: randomUUID() });
    const before = [await snapshot(ids['ai-deployment']), await snapshot(server)];
    for (const [from, to, type] of [[ids['ai-deployment'], ids['agent-release'], 'INSTANCE_OF'], [server, ids['cell'], 'DEPENDS_ON']]) {
      const res = await request(app).delete('/api/v1/relationships').query({ from_id: from, to_id: to, type }).set('authorization', bearer);
      expect({ status: res.status, code: res.body.code }).toEqual(sourceOwned);
    }
    expect([await snapshot(ids['ai-deployment']), await snapshot(server)]).toEqual(before);
  });

  it('GraphQL createRelationship and deleteRelationship with an AI endpoint are source_owned', async () => {
    const server = randomUUID();
    mockGraph.nodes.set(server, { id: server, organization_id: A, name: 'plain', type: 'server', incarnation_id: randomUUID() });
    const loader = { clear: () => undefined, clearAll: () => undefined };
    const context = { _neo4jClient: getNeo4jClient(), user: { _userId: admin._id, _username: admin._username, _role: admin._role,
      _type: 'access' as const, _organizationId: A }, _loaders: { _ciLoader: loader, _relationshipLoader: loader, _dependentLoader: loader } };
    const code = (call: Promise<unknown>) => call.then(() => 'resolved', (error: { extensions?: { code?: string } }) => error.extensions?.code);
    const mutation = resolvers.Mutation as Record<string, (parent: unknown, args: unknown, ctx: unknown) => Promise<unknown>>;
    const before = [await snapshot(ids['ai-deployment']), await snapshot(server)];
    expect([
      await code(mutation['createRelationship']!(null, { input: { _fromId: server, _toId: ids['cell'], _type: 'DEPENDS_ON' } }, context)),
      await code(mutation['deleteRelationship']!(null, { fromId: ids['ai-deployment'], toId: ids['agent-release'], type: 'INSTANCE_OF' },
        context)),
    ]).toEqual(['source_owned', 'source_owned']);
    expect([await snapshot(ids['ai-deployment']), await snapshot(server)]).toEqual(before);
  });

  it('the legacy unjournaled create (ETL Postgres-to-Neo4j repair) refuses every AI class', async () => {
    for (const cls of CLASSES) {
      const id = randomUUID();
      const before = await snapshot(id);
      await expect(getNeo4jClient().legacyCreateCIUnjournaled({ _id: id, name: 'forged', _type: cls } as unknown as CIInput, A))
        .rejects.toBeInstanceOf(SourceOwnedError);
      expect(await snapshot(id)).toEqual(before);
      expect(mockGraph.nodes.has(id)).toBe(false);
    }
  });
});

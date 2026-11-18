// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1444 (AAI S2): the per-tenant C4 sync writes agent-release and ai-model CIs (USES) through AISyncWriter, retires
 * revoked releases and never deletes. Real journal, audit chain, credential store and ai_sync_cursors on PGlite as the
 * app login cmdb_user; Neo4j is an in-memory node and edge map; C4 is a 127.0.0.1 server answering Suite Contracts v2
 * C4 records `A` in the common paging envelope {items, next_cursor, as_of}, one item per page.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const TOKEN = `c4-token-${randomBytes(16).toString('hex')}`;
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
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
/** Every statement sent to PGlite, in order (the steady-state cost test counts the receipt reads in it). */
const statements: string[] = [];
function mockSql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  statements.push(text);
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
const mockGraph = { nodes: new Map<string, Record<string, any>>(), edges: [] as Array<{ from: string; to: string; type: string }>,
  fences: new Map<string, Record<string, unknown>>(), writes: [] as string[] };
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
      const relationship = /MERGE \(a\)-\[r:(\w+)\]->\(b\)/.exec(query);
      let applied = false;
      if (relationship) {
        applied = !!(owned(params['from'], params['org']) && owned(params['to'], params['org']));
        if (applied && !mockGraph.edges.some(e => e.from === params['from'] && e.to === params['to'] && e.type === relationship[1])) {
          mockGraph.edges.push({ from: params['from'], to: params['to'], type: relationship[1]! });
        }
      } else if (query.startsWith('CREATE (ci:CI')) {
        if (mockGraph.nodes.has(params['id'])) throw Object.assign(new Error('ci_id_unique'), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' });
        // Neo4j stores no null: `SET ci = $props` leaves a null property out and `SET ci += $props` removes it.
        mockGraph.nodes.set(params['id'], { ...Object.fromEntries(Object.entries(params['props']).filter(([, v]) => v !== null)),
          id: params['id'], organization_id: params['org'] });
        applied = true;
      } else {
        const node = owned(params['id'], params['org']);
        if (node && query.includes('DETACH DELETE')) mockGraph.nodes.delete(params['id']);
        else if (node) {
          for (const [key, value] of Object.entries(params['props'])) {
            if (value === null) delete node[key];
            else node[key] = value;
          }
        }
        applied = !!node;
      }
      for (const fence of applied ? params['fences'] : []) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: applied ? params['fences'].length : 0 })] };
    }
    if (query.includes('AS incarnationId')) { // Neo4jClient.getCIIncarnations
      return { records: (params['ids'] as string[]).map(id => owned(id, params['organizationId'])).filter(Boolean)
        .map(n => record({ ciId: n!['id'], incarnationId: n!['incarnation_id'] ?? null })) };
    }
    if (query.includes('UNWIND $frontier')) { // Neo4jClient.traverseCIs: one hop from every frontier CI
      // Production traversals follow DEPENDS_ON only (`[relationship:DEPENDS_ON]`), and the C4 sync writes USES, so these
      // routes never list a sync edge. GET /impact/graph is the one read that does (see the engine spy in the HAP-2030 tests).
      const outbound = query.includes('(source)-[relationship');
      const dependsOnly = query.includes('relationship:DEPENDS_ON');
      const hops: Array<Record<string, unknown>> = [];
      for (const sourceId of params['frontier'] as string[]) {
        const source = owned(sourceId, params['organizationId']);
        for (const edge of source ? mockGraph.edges : []) {
          if (dependsOnly && edge.type !== 'DEPENDS_ON') continue;
          const targetId = outbound ? (edge.from === sourceId ? edge.to : undefined) : (edge.to === sourceId ? edge.from : undefined);
          const target = targetId === undefined ? undefined : owned(targetId, params['organizationId']);
          if (target) hops.push({ source: { properties: source }, target: { properties: target }, relationship: { type: edge.type, properties: {} },
            startNodeId: edge.from, endNodeId: edge.to });
        }
      }
      return { records: hops.slice(0, actual.integer.toNumber(params['rowLimit'])).map(record) };
    }
    if (query.includes('AS key')) { // Neo4jClient.listOwnedKeys
      const keys = [...mockGraph.nodes.values()].filter(n => n['organization_id'] === params['organizationId']
        && n['type'] === params['type'] && typeof n[params['field']] === 'string' && n[params['field']] > params['after'])
        .map(n => n[params['field']] as string).sort().slice(0, actual.integer.toNumber(params['rowLimit']));
      return { records: keys.map(key => record({ key })) };
    }
    if (query.includes('AS present')) { // Neo4jClient.relationshipExists
      const hit = owned(params['from'], params['organizationId']) && owned(params['to'], params['organizationId'])
        && mockGraph.edges.some(e => e.from === params['from'] && e.to === params['to'] && query.includes(`[r:${e.type}]`));
      return { records: [record({ present: !!hit })] };
    }
    const node = owned(params['id'], params['organizationId']);
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    mockGraph.writes.push(query);
    throw new Error(`unexpected statement: ${query}`);
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));

import { Job, type JobsOptions } from 'bullmq';
const mockUsers = new Map<string, { _id: string; _username: string; _role: 'admin' | 'viewer'; _enabled: boolean; _organizationId: string }>();
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => mockUsers.get(id) ?? null, findApiKeyByKey: async () => null })),
}));
jest.mock('@cmdb/event-processor', () => ({
  ...jest.requireActual('@cmdb/event-processor'), getEventProducer: () => ({ emit: async () => [] }),
}));
import { getEncryptionService, loadConfig } from '@cmdb/common';
import { AISyncWriteRefused, AISyncWriter, getNeo4jClient, getPostgresClient, getUnifiedCredentialService, setJournalSeam } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { loadEdgeEvidence, qualificationOf } from '../../edge-evidence';
import { ciRoutes } from '../ci.routes';
import { relationshipRoutes } from '../relationship.routes';
import { getImpactPredictionEngine } from '@cmdb/ai-ml-engine';
import { AISyncScheduler } from '../../../../../discovery-engine/src/schedulers/ai-sync-scheduler';
import { enqueueC4ReleaseSyncs, syncC4Releases } from '../../../../../discovery-engine/src/ai-sync/c4-release-sync';
import { impactRoutes } from '../drift-impact.routes';
import { c4Origin } from '../../../../../discovery-engine/src/ai-sync/c4-client';
import { APP_GRANTS_SQL, ENTER_APP_LOGIN_SQL, PGLITE_SUPERUSER, assertAppLogin, createLoginRolesSql, journalReadAclSql, receiptTableSql } from './fixtures/app-login';

const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const digest = (hex: string) => `sha256:${hex.repeat(64)}`;
const hex40 = (c: string) => c.repeat(40);

/** A C4 record exactly as Suite Contracts v2 C4 `A` (with the 2026-11-03 runtime_pins.settings_sha256 amendment). */
function release(hex: string, status: string, pins: Array<{ model_id: string; profile: string }>): Record<string, unknown> {
  return {
    release_digest: digest(hex), name: `release-${hex}`, version: 3,
    agent_roles: [{ role: 'service_request_management', version: hex40('1'), digest: digest('d') }],
    skills: [{ skill_id: 'happy-technologies:skills/a', version: hex40('2'), digest: digest('e') },
      { skill_id: 'happy-technologies:skills/b', version: hex40('3'), digest: digest('f') }],
    model_pins: pins,
    runtime_pins: { cell_parser_commit: hex40('4'), sandbox_image_digest: digest('9'), driver: 'claude-code',
      runtime_version: '1.2.3', adapter_contract_version: '0.2', settings_sha256: '8'.repeat(64) },
    instructions_digest: digest('7'), bindings_digest: digest('6'), config_digest: digest('5'),
    rollback_of: null, evaluation_sha256: null, approval_decision_id: '0b0c0d0e-0000-4000-8000-000000000001',
    signed_by: 'happylab-release-key-1', signed_at: '2026-11-05T10:00:00Z', status,
  };
}

const c4 = { asOf: '2026-11-06T12:00:00Z', records: new Map<string, Record<string, unknown>>(), forceListed: new Set<string>(),
  hits: [] as string[] };
const server: Server = createServer((req, res) => {
  c4.hits.push(req.url!);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthenticated' });
  const url = new URL(req.url!, 'http://c4.invalid');
  if (url.pathname === '/v1/releases') {
    const listed = [...c4.records.values()].filter(r => r['status'] === 'approved' || c4.forceListed.has(r['release_digest'] as string));
    const at = Number(url.searchParams.get('cursor') ?? 0);
    return send(200, { items: listed.slice(at, at + 1), next_cursor: at + 1 < listed.length ? String(at + 1) : null, as_of: c4.asOf });
  }
  const record = c4.records.get(decodeURIComponent(url.pathname.replace('/v1/releases/', '')));
  return record && record['status'] !== 'draft' ? send(200, record) : send(404, { error: 'not_found' });
});
let baseUrl = '';
const sync = (org: string) => syncC4Releases(org, { neo4j: getNeo4jClient(), pool: getPostgresClient().pool, baseUrl });
const ciOf = (org: string, type: string, field: string, value: string) => [...mockGraph.nodes.values()]
  .find(n => n['organization_id'] === org && n['type'] === type && n[field] === value);
const cursor = async (org: string) => (await rows(`SELECT cursor, as_of, last_error_code FROM ai_sync_cursors
  WHERE organization_id = $1 AND stream = 'c4_releases'`, [org]))[0];
/** What an unchanged run must leave as it was: every node and edge, the journal and the audit chain. */
const snapshot = async () => ({ nodes: JSON.stringify([...mockGraph.nodes.entries()]), edges: JSON.stringify(mockGraph.edges),
  graphWrites: mockGraph.writes.length, ...(await rows(`SELECT (SELECT count(*)::int FROM ci_reconciliation_operations) AS ops,
    (SELECT count(*)::int FROM audit_log) AS audit`))[0] });

beforeAll(async () => {
  const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
  const sql = (file: string) => readFileSync(join(migrations, file), 'utf8');
  const schema = sql('001_complete_schema.sql');
  await mockSql(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ...['audit_log', 'cmdb.dim_ci',
    'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts', 'reconciliation_rules', 'source_authority', 'ci_change_history',
    'dim_business_services', 'credentials'].map(table => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0])]
    .join('\n'), [], 'exec');
  for (const file of ['003_audit_hash_chain.sql', '011_ci_organization_scope.sql', '028_change_history_reconciliation_org_provenance.sql',
    '029_reconciliation_conflict_identity_rules.sql', '037_reconciliation_org_contract.sql']) await mockSql(sql(file), [], 'exec');
  await mockSql(`ALTER TABLE credentials ADD COLUMN organization_id UUID;
    ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required CHECK (organization_id IS NOT NULL) NOT VALID;`,
  [], 'exec'); // 021, 025
  const [{ db }] = (await mockSql('SELECT current_database() AS db')).rows;
  await mockSql(`${createLoginRolesSql(db)} RESET ROLE; ${APP_GRANTS_SQL} ${journalReadAclSql()}
    GRANT SELECT, INSERT, UPDATE ON ci_reconciliation_operations, ci_reconciliation_epochs, ci_field_sources, ci_source_lineage,
      reconciliation_conflicts, source_authority TO cmdb_user;
    GRANT SELECT ON reconciliation_rules TO cmdb_user; GRANT SELECT, INSERT ON ci_change_history TO cmdb_user;
    GRANT SELECT ON credentials TO cmdb_user;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public, cmdb TO cmdb_user;`, [], 'exec');
  await mockSql(`BEGIN;\n${sql('047_ai_sync_cursors.sql')}\nCOMMIT;`, [], 'exec');
  await mockSql(receiptTableSql(), [], 'exec');
  // Given tenant A's HappyLab principal in the credential store (encrypted like every stored credential); B has none.
  await mockSql(`INSERT INTO credentials (name, protocol, scope, credentials, tags, created_by, organization_id)
    VALUES ('happylab c4', 'bearer', 'api', $1::jsonb, ARRAY['happylab-c4'], 'admin-a', $2)`,
  [JSON.stringify(getEncryptionService().encrypt(JSON.stringify({ token: TOKEN }))), A]);
  await mockSql(ENTER_APP_LOGIN_SQL, [], 'exec');
  await assertAppLogin(async text => (await mockSql(text)).rows);
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60000);
afterAll(async () => {
  host.kill();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});

const R1 = digest('1');
const PINS = [{ model_id: 'claude-opus-4', profile: 'default' }, { model_id: 'claude-haiku-4', profile: 'fast' }];
/** R1 is not yet signed (C4 publishes signed_by and signed_at as null), which Neo4j stores as absent properties. */
const r1 = (status: string) => ({ ...release('1', status, PINS), signed_by: null, signed_at: null });

it('A1: an approved release with two model pins becomes one agent-release CI and two ai-model CIs joined by USES, each with c4_as_of', async () => {
  c4.records.set(R1, r1('approved'));
  await expect(sync(A)).resolves.toMatchObject({ success: true, created: 3, updated: 0 });
  const rel = ciOf(A, 'agent-release', 'release_digest', R1)!;
  expect(rel).toMatchObject({ name: 'release-1', version: 3, release_status: 'approved', lifecycle: 'live', c4_as_of: c4.asOf,
    authoritative_source: 'happylab-c4', skill_digests: [digest('e'), digest('f')], config_digest: digest('5') });
  const models = PINS.map(pin => ciOf(A, 'ai-model', 'model_id', pin.model_id)!);
  expect(models.map(m => [m['profile'], m['c4_as_of'], m['first_seen_release']])).toEqual([['default', c4.asOf, R1], ['fast', c4.asOf, R1]]);
  expect(mockGraph.edges).toEqual(models.map(m => ({ from: rel['id'], to: m['id'], type: 'USES' })));
  // HAP-2029: each USES edge has one static_observed receipt by the stream's system principal; no other class exists.
  expect(await rows(`SELECT organization_id, from_ci_id, to_ci_id, from_incarnation_id, to_incarnation_id, relationship_type, evidence_class,
    polarity, source_name, source_id, method, observer, observer_type FROM relationship_evidence_receipts ORDER BY to_ci_id`))
    .toEqual(models.map(m => ({ organization_id: A, from_ci_id: rel['id'], to_ci_id: m['id'], from_incarnation_id: rel['incarnation_id'],
      to_incarnation_id: m['incarnation_id'], relationship_type: 'USES', evidence_class: 'static_observed', polarity: 'supports',
      source_name: 'ai_sync', source_id: 'c4_releases', method: 'ai_sync', observer: 'sync:c4_releases', observer_type: 'system' }))
      .sort((x, y) => (x.to_ci_id < y.to_ci_id ? -1 : 1)));
  expect(await cursor(A)).toEqual({ cursor: c4.asOf, as_of: new Date(c4.asOf), last_error_code: null });
});

it('A2: a second run over unchanged C4 data changes no CI or edge and appends no journal or audit row', async () => {
  const before = await snapshot();
  await expect(sync(A)).resolves.toMatchObject({ success: true, created: 0, updated: 0, unchanged: 3 });
  expect(await snapshot()).toEqual(before);
});

it('A3: a release revoked in C4 is retired (release_status revoked), the CI and its USES edges remain, and an older C4 snapshot cannot un-revoke it', async () => {
  c4.records.set(R1, r1('revoked'));
  await expect(sync(A)).resolves.toMatchObject({ success: true, retired: 1 });
  expect(ciOf(A, 'agent-release', 'release_digest', R1)).toMatchObject({ lifecycle: 'retired', release_status: 'revoked' });
  expect(mockGraph.edges).toHaveLength(2);
  const retired = { ...ciOf(A, 'agent-release', 'release_digest', R1)! };
  const [stored, asOf] = [await cursor(A), c4.asOf];
  c4.asOf = '2026-11-06T11:00:00Z'; // a lagging C4 that still lists R1 as approved
  c4.records.set(R1, r1('approved'));
  await expect(sync(A)).resolves.toMatchObject({ success: false, created: 0, updated: 0 });
  expect(ciOf(A, 'agent-release', 'release_digest', R1)).toEqual(retired);
  expect(await cursor(A)).toEqual({ ...stored, last_error_code: 'c4_snapshot_stale' });
  c4.asOf = asOf;
  c4.records.set(R1, r1('revoked'));
  expect(PINS.map(pin => ciOf(A, 'ai-model', 'model_id', pin.model_id)?.['lifecycle'])).toEqual(['live', 'live']);
});

it('A4: C4 answering 404 for a held digest leaves its CI unchanged, records c4_not_found and deletes nothing', async () => {
  const R2 = digest('2');
  c4.records.set(R2, release('2', 'approved', [PINS[0]!]));
  await sync(A);
  const held = { ...ciOf(A, 'agent-release', 'release_digest', R2)! };
  const nodes = mockGraph.nodes.size;
  c4.records.delete(R2);
  await sync(A);
  expect(ciOf(A, 'agent-release', 'release_digest', R2)).toEqual(held);
  expect([mockGraph.nodes.size, mockGraph.writes.filter(q => q.includes('DELETE'))]).toEqual([nodes, []]);
  expect(await cursor(A)).toMatchObject({ last_error_code: 'c4_not_found' });
});

it('A5: only the brief §4 attributes are stored; skill and instruction content, runtime pins and secrets are not', async () => {
  const R3 = digest('3');
  c4.records.set(R3, { ...release('3', 'approved', [{ model_id: 'gpt-x', profile: 'strict' }]), instructions: 'SECRET INSTRUCTION TEXT',
    skill_contents: { a: 'SKILL BODY' }, manifest: { secret: TOKEN }, api_token: TOKEN });
  await sync(A);
  // createCI's core properties as Neo4j keeps them (its null external_id and discovery_provider are not stored).
  const WRITER = ['id', 'organization_id', 'type', 'name', 'status', 'environment', 'discovered_at', 'metadata', 'incarnation_id',
    'authoritative_source', 'lifecycle'];
  expect(Object.keys(ciOf(A, 'agent-release', 'release_digest', R3)!).sort()).toEqual([...WRITER, 'release_digest', 'version',
    'release_status', 'signed_by', 'signed_at', 'config_digest', 'instructions_digest', 'skill_digests', 'c4_as_of'].sort());
  expect(Object.keys(ciOf(A, 'ai-model', 'model_id', 'gpt-x')!).sort())
    .toEqual([...WRITER, 'model_id', 'profile', 'first_seen_release', 'c4_as_of'].sort());
  expect(JSON.stringify([...mockGraph.nodes.values()])).not.toMatch(new RegExp(`SECRET|SKILL BODY|${TOKEN}|settings_sha256|claude-code`));
});

it('A6: the scheduled and enqueued BullMQ job data carry no token: the fan-out is {} and each tenant job is {organizationId}', async () => {
  const added: unknown[][] = [];
  // Each job goes through BullMQ's own option check (the one Queue.add runs), without Redis.
  class CheckedJob extends Job {
    check() { this.validateOptions(this.asJSON()); }
  }
  const stub = { toKey: (key: string) => key, qualifiedName: 'bull:test', keys: {}, opts: {}, client: new Promise(() => undefined) };
  const queue = { add: async (name: string, data: object, opts: JobsOptions) => {
    new CheckedJob(stub as never, name, data, opts).check();
    added.push([name, data, opts]);
    return {};
  } };
  await new AISyncScheduler(queue as never).start();
  await expect(enqueueC4ReleaseSyncs(queue as never, getUnifiedCredentialService(getPostgresClient().pool))).resolves.toBe(1);
  expect(added.map(([name, data]) => [name, data])).toEqual([['c4-releases-fanout', {}], ['c4-releases', { organizationId: A }]]);
  expect(JSON.stringify(added)).not.toContain(TOKEN);
});

it('tenant: an organization without its own HappyLab principal reads nothing from C4, gets no CI and cannot touch A', async () => {
  const before = { ...(await snapshot()), cursorA: await cursor(A), hits: c4.hits.length };
  await expect(sync(B)).resolves.toMatchObject({ success: false, created: 0 });
  expect([...mockGraph.nodes.values()].filter(n => n['organization_id'] === B)).toEqual([]);
  expect({ ...(await snapshot()), cursorA: await cursor(A), hits: c4.hits.length }).toEqual(before);
  expect(await cursor(B)).toMatchObject({ cursor: null, last_error_code: 'c4_no_credential' });
});

it('status allowlist: an unknown status leaves a held CI unchanged and never creates one (c4_status_refused)', async () => {
  const R4 = digest('4');
  c4.records.set(R4, release('4', 'approved', [PINS[0]!]));
  await sync(A);
  const held = { ...ciOf(A, 'agent-release', 'release_digest', R4)! };
  const R5 = digest('5');
  c4.records.set(R4, release('4', 'suspended', [PINS[0]!]));
  c4.records.set(R5, release('5', 'pending_review', [{ model_id: 'never-seen', profile: 'x' }]));
  c4.forceListed.add(R5);
  await sync(A);
  expect(ciOf(A, 'agent-release', 'release_digest', R4)).toEqual(held);
  expect([ciOf(A, 'agent-release', 'release_digest', R5), ciOf(A, 'ai-model', 'model_id', 'never-seen')]).toEqual([undefined, undefined]);
  expect(await cursor(A)).toMatchObject({ last_error_code: 'c4_status_refused' });
});

it('env gate: the sync starts only for an http(s) HAPPYLAB_C4_URL without userinfo, and then talks only to its origin', () => {
  expect([undefined, '', 'not a url', 'ftp://c4.internal', 'https://u:p@c4.internal', 'https://tok@c4.internal',
    'https://c4.internal:8443/v1/releases?x=1'].map(c4Origin))
    .toEqual([null, null, null, null, null, null, 'https://c4.internal:8443']);
});

/**
 * HAP-2030: an unchanged edge the source still reports is re-observed (one `reobserved` static_observed receipt per edge and
 * 24 h), so an edge older than the 7-day window heals instead of reading stale. Every test runs its own freshly created
 * tenants. The database clock cannot be advanced, so ageing is simulated the only way a test can: as the table owner (here
 * PGlite's bootstrap superuser, who created the table) with the append-only trigger disabled for the one UPDATE.
 */
describe('HAP-2030: re-observation of unchanged edges', () => {
  const RC = digest('c');
  const TRIPLE = [{ model_id: 'claude-opus-4', profile: 'default' }, { model_id: 'claude-haiku-4', profile: 'fast' },
    { model_id: 'claude-sonnet-4', profile: 'balanced' }];
  /** The receipt fields every AI-sync receipt carries, the creation one and every re-observation. */
  const STREAM_RECEIPT = { evidence_class: 'static_observed', polarity: 'supports', source_name: 'ai_sync', source_id: 'c4_releases',
    method: 'ai_sync', observer: 'sync:c4_releases', observer_type: 'system', relationship_type: 'USES' };
  type Edge = { from: string; to: string; type: string };
  type Tenant = { org: string; rel: Record<string, any>; models: Array<Record<string, any>>; edges: Edge[] };

  const app = express();
  app.use(express.json());
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/cis', ciRoutes);
  app.use('/api/v1/relationships', relationshipRoutes);
  app.use('/api/v1/impact', impactRoutes);
  const jwt = new JWTService(loadConfig().auth.jwt);
  const login = (org: string, role: 'admin' | 'viewer') => {
    const id = `${role}-${org}`;
    mockUsers.set(id, { _id: id, _username: `${role}-${org.slice(0, 8)}`, _role: role, _enabled: true, _organizationId: org });
    return { authorization: `Bearer ${jwt.generateAccessToken(id, `${role}-${org.slice(0, 8)}`, role, org, 0, Math.floor(Date.now() / 1000))}` };
  };

  beforeAll(() => {
    c4.records.clear();
    c4.forceListed.clear();
    c4.records.set(RC, release('c', 'approved', TRIPLE));
  });
  afterEach(() => {
    setJournalSeam(undefined);
    jest.restoreAllMocks();
  });

  /** Fixture work as the table owner; the app login resumes afterwards (nothing else runs meanwhile). */
  async function asOwner<T>(work: () => Promise<T>): Promise<T> {
    await mockSql(`RESET ROLE; SET SESSION AUTHORIZATION ${PGLITE_SUPERUSER};`, [], 'exec');
    try {
      return await work();
    } finally {
      await mockSql(ENTER_APP_LOGIN_SQL, [], 'exec');
    }
  }
  const asUnguardedOwner = (work: () => Promise<unknown>) => asOwner(async () => {
    await mockSql('ALTER TABLE relationship_evidence_receipts DISABLE TRIGGER USER', [], 'exec');
    try {
      await work();
    } finally {
      await mockSql('ALTER TABLE relationship_evidence_receipts ENABLE TRIGGER USER', [], 'exec');
    }
  });
  /** Every receipt of the organization happened `interval` earlier than it did. */
  const ageAll = (org: string, interval: string) => asUnguardedOwner(() => mockSql(
    'UPDATE relationship_evidence_receipts SET observed_at = observed_at - $2::interval WHERE organization_id = $1', [org, interval]));
  /** The edge's newest receipt happened exactly `interval` before the database's now(). */
  const setNewestAge = (edge: Edge, interval: string) => asUnguardedOwner(() => mockSql(`UPDATE relationship_evidence_receipts
    SET observed_at = now() - $3::interval WHERE receipt_id = (SELECT receipt_id FROM relationship_evidence_receipts
      WHERE from_ci_id = $1 AND to_ci_id = $2 ORDER BY observed_at DESC, receipt_id LIMIT 1)`, [edge.from, edge.to, interval]));
  const decoy = (d: { org: string; edge: Edge; fromInc: string; toInc: string; cls?: string; polarity?: string; sourceName?: string;
    sourceId?: string | null }) => asOwner(() => mockSql(`INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id,
      from_incarnation_id, to_incarnation_id, relationship_type, evidence_class, polarity, source_name, source_id, method, rationale_code,
      observed_at, observer, observer_type, correlation_id)
    VALUES ($1, $2, $3, $4, $5, 'USES', $6, $7, $8, $9, 'ai_sync', 'reobserved', now(), 'sync:c4_releases', 'system', $10)`,
  [d.org, d.edge.from, d.edge.to, d.fromInc, d.toInc, d.cls ?? 'static_observed', d.polarity ?? 'supports', d.sourceName ?? 'ai_sync',
    d.sourceId === undefined ? 'c4_releases' : d.sourceId, randomUUID()]));

  const receiptsOf = (edge: Edge) => rows(`SELECT * FROM relationship_evidence_receipts WHERE from_ci_id = $1 AND to_ci_id = $2
    ORDER BY observed_at, receipt_id`, [edge.from, edge.to]);
  const count = async (text: string, params: unknown[] = []) => (await rows(text, params))[0]!['n'] as number;
  const receiptCount = (org: string) => count('SELECT count(*)::int AS n FROM relationship_evidence_receipts WHERE organization_id = $1', [org]);
  const costs = async (org: string) => ({ receipts: await receiptCount(org),
    ops: await count('SELECT count(*)::int AS n FROM ci_reconciliation_operations WHERE organization_id = $1', [org]),
    audit: await count('SELECT count(*)::int AS n FROM audit_log') });
  /** The graph, every CI property and the whole audit chain, byte for byte. */
  const graphAndAudit = async () => ({ nodes: JSON.stringify([...mockGraph.nodes.entries()]), edges: JSON.stringify(mockGraph.edges),
    graphWrites: mockGraph.writes.length, audit: (await rows('SELECT to_jsonb(a)::text AS r FROM audit_log a ORDER BY 1')).map(r => r['r']) });
  const read = async (t: Tenant) => {
    const qualified = await loadEdgeEvidence(t.org, t.edges, { timeoutMs: 3000 });
    return t.edges.map(e => qualificationOf(qualified, e.from, e.to, e.type));
  };
  const currentness = async (t: Tenant) => (await read(t)).map(q => q.currentness);

  async function tenant(): Promise<string> {
    const org = randomUUID();
    await asOwner(() => mockSql(`INSERT INTO credentials (name, protocol, scope, credentials, tags, created_by, organization_id)
      VALUES ($1, 'bearer', 'api', $2::jsonb, ARRAY['happylab-c4'], 'admin', $3)`,
    [`happylab c4 ${org}`, JSON.stringify(getEncryptionService().encrypt(JSON.stringify({ token: TOKEN }))), org]));
    return org;
  }
  /** A new organization after its first sync: one release, three models, three USES edges, one creation receipt each. */
  async function synced(): Promise<Tenant> {
    const org = await tenant();
    await expect(sync(org)).resolves.toMatchObject({ success: true, created: 4, updated: 0 });
    const rel = ciOf(org, 'agent-release', 'release_digest', RC)!;
    const models = TRIPLE.map(pin => ciOf(org, 'ai-model', 'model_id', pin.model_id)!);
    return { org, rel, models, edges: models.map(m => ({ from: rel['id'], to: m['id'], type: 'USES' })) };
  }
  const seed = (org: string) => {
    const id = randomUUID();
    mockGraph.nodes.set(id, { id, organization_id: org, name: 'seeded', type: 'server', incarnation_id: randomUUID() });
    return id;
  };
  const NEWEST_FIRST = ['reobserved', null];

  it('heals: edges aged past the 7-day window read stale; the next sync appends exactly one reobserved receipt per edge and they read current; graph, CI properties and audit chain are untouched; an aged edge nobody re-synced stays stale', async () => {
    const live = await synced();
    const control = await synced(); // aged the same way, never synced again
    expect(await currentness(live)).toEqual(['current', 'current', 'current']);
    await ageAll(live.org, '8 days');
    await ageAll(control.org, '8 days');
    expect(await currentness(live)).toEqual(['stale', 'stale', 'stale']);
    expect(await currentness(control)).toEqual(['stale', 'stale', 'stale']);
    const before = await graphAndAudit();
    const receiptsBefore = await Promise.all(live.edges.map(receiptsOf));

    await expect(sync(live.org)).resolves.toMatchObject({ success: true, created: 0, updated: 0, unchanged: 4 });

    for (const [i, edge] of live.edges.entries()) {
      const after = await receiptsOf(edge);
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual(receiptsBefore[i]![0]); // the old receipt is untouched
      expect(after[1]).toMatchObject({ ...STREAM_RECEIPT, organization_id: live.org, from_ci_id: edge.from, to_ci_id: edge.to,
        from_incarnation_id: live.rel['incarnation_id'], to_incarnation_id: live.models[i]!['incarnation_id'],
        rationale_code: 'reobserved', source_version: null });
    }
    expect(await graphAndAudit()).toEqual(before);
    expect(await currentness(live)).toEqual(['current', 'current', 'current']);
    expect(await currentness(control)).toEqual(['stale', 'stale', 'stale']);
    expect(await receiptCount(control.org)).toBe(3);
  });

  /**
   * GET /impact/graph is the one read that lists a USES edge: the engine matches `-[rel]-` with no type filter (verified over the
   * real engine in impact-graph-evidence.test.ts), so its edges are every edge of the organization's graph around the root.
   * The engine is stood in for here by exactly that; the evidence qualification the route adds is real.
   */
  const graphEdges = (org: string) => jest.spyOn(getImpactPredictionEngine(), 'buildDependencyGraph').mockImplementation(async (root) => {
    const edges = mockGraph.edges.filter(e => (e.from === root || e.to === root)
      && mockGraph.nodes.get(e.from)?.['organization_id'] === org && mockGraph.nodes.get(e.to)?.['organization_id'] === org);
    const ids = [...new Set([root, ...edges.flatMap(e => [e.from, e.to])])];
    return { nodes: ids.map(id => ({ id, ci_id: id, ci_name: id, ci_type: 'server', criticality: 0, dependencies_count: 0, dependents_count: 0 })),
      edges: edges.map(e => ({ source_id: e.from, target_id: e.to, relationship_type: e.type, weight: 1, is_critical: e.type === 'DEPENDS_ON' })),
      metadata: { total_nodes: ids.length, total_edges: edges.length, max_depth: 3, generated_at: new Date() } };
  });

  it('heals through the route: GET /impact/graph reads the edges stale after ageing and current after the next sync', async () => {
    const t = await synced();
    graphEdges(t.org);
    const get = async () => {
      const res = await request(app).get(`/api/v1/impact/graph/${t.rel['id']}`).set(login(t.org, 'viewer'));
      expect(res.status).toBe(200);
      return res.body.data.edges.map((e: any) => [e.source_id, e.target_id, e.relationship_type, e.currentness]);
    };
    const expected = (state: string) => t.edges.map(e => [e.from, e.to, 'USES', state]);
    expect(await get()).toEqual(expected('current'));
    await ageAll(t.org, '8 days');
    expect(await get()).toEqual(expected('stale'));
    await sync(t.org);
    expect(await get()).toEqual(expected('current'));
  });

  describe('throttle', () => {
    it('an immediate second sync appends no receipt, journal row or audit row; the period is 24 h per edge and a third sync right after a re-observation adds none', async () => {
      const t = await synced();
      const base = await costs(t.org);
      await sync(t.org);
      expect(await costs(t.org)).toEqual(base);

      for (const edge of t.edges) await setNewestAge(edge, '23 hours 59 minutes');
      await sync(t.org);
      expect(await costs(t.org)).toEqual(base);

      for (const edge of t.edges) await setNewestAge(edge, '24 hours 1 minute');
      await sync(t.org);
      const reobserved = await costs(t.org);
      expect([reobserved.receipts, reobserved.audit]).toEqual([base.receipts + 3, base.audit]);
      expect(reobserved.ops).toBeGreaterThan(base.ops);

      await sync(t.org);
      expect(await costs(t.org)).toEqual(reobserved);
    });

    it('is decided per edge: of three edges only the one past 24 h gains a receipt', async () => {
      const t = await synced();
      await setNewestAge(t.edges[1]!, '25 hours');
      await sync(t.org);
      expect(await Promise.all(t.edges.map(async e => (await receiptsOf(e)).map(r => r['rationale_code']))))
        .toEqual([[null], [null, 'reobserved'], [null]]);
    });

    it('is measured on the database clock: a process clock an hour ahead or behind changes neither the no-row nor the row case', async () => {
      const t = await synced();
      const fakeOnlyDate = async <T>(offsetMs: number, work: () => Promise<T>): Promise<T> => {
        jest.useFakeTimers({ now: Date.now() + offsetMs, doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
          'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
          'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        try {
          return await work();
        } finally {
          jest.useRealTimers();
        }
      };
      const base = await receiptCount(t.org);
      // 23 h 30 min old is recent on the database clock; a process clock an hour ahead would call it 24 h 30 min old.
      for (const edge of t.edges) await setNewestAge(edge, '23 hours 30 minutes');
      await expect(fakeOnlyDate(3_600_000, () => sync(t.org))).resolves.toMatchObject({ success: true });
      expect(await receiptCount(t.org)).toBe(base);
      // 24 h 30 min old is due on the database clock; a process clock an hour behind would call it 23 h 30 min old.
      for (const edge of t.edges) await setNewestAge(edge, '24 hours 30 minutes');
      await expect(fakeOnlyDate(-3_600_000, () => sync(t.org))).resolves.toMatchObject({ success: true });
      expect(await receiptCount(t.org)).toBe(base + 3);
    });
  });

  it('concurrent syncs of one tenant after ageing append exactly one receipt per edge: the loser decides the throttle again under the slot', async () => {
    const t = await synced();
    await ageAll(t.org, '8 days');
    const settled = await Promise.allSettled([sync(t.org), sync(t.org)]);
    expect(settled.map(s => s.status)).toEqual(['fulfilled', 'fulfilled']);
    // One run won each edge; the other's plan found the winner's receipt under the slot: an aborted `throttled` group (two
    // slot rows) per edge, no receipt, nothing left pending, and no row a real plan failure would leave.
    expect(await rows(`SELECT state, last_error, count(*)::int AS n FROM ci_reconciliation_operations WHERE organization_id = $1
      AND state <> 'committed' GROUP BY state, last_error`, [t.org])).toEqual([{ state: 'aborted', last_error: 'throttled', n: 6 }]);
    expect(await Promise.all(t.edges.map(async e => (await receiptsOf(e)).filter(r => r['rationale_code'] === 'reobserved').length)))
      .toEqual([1, 1, 1]);
  });

  it('the throttle is decided again under the slot: an outside read that missed a just-written receipt still appends nothing and leaves an aborted throttled row, never a plan_failed one', async () => {
    const t = await synced();
    const [edge] = t.edges;
    const client = getNeo4jClient();
    const real = client.hasRecentObservation.bind(client);
    let outside = true;
    jest.spyOn(client, 'hasRecentObservation').mockImplementation(async (...args) => {
      if (outside) { // the cheap read outside the slot sees nothing recent, as it would just before a concurrent writer's T2
        outside = false;
        return false;
      }
      return real(...args);
    });
    const base = await costs(t.org);
    await expect(new AISyncWriter(client).link(t.org, 'c4_releases', edge!.from, 'USES', edge!.to)).resolves.toBe('unchanged');
    expect(await receiptsOf(edge!)).toHaveLength(1);
    expect(await costs(t.org)).toMatchObject({ receipts: base.receipts, audit: base.audit });
    expect(await rows(`SELECT state, last_error FROM ci_reconciliation_operations
      WHERE organization_id = $1 AND ci_id = ANY($2::text[]) AND state <> 'committed' ORDER BY ci_id`, [t.org, [edge!.from, edge!.to]]))
      .toEqual([edge!.from, edge!.to].map(() => ({ state: 'aborted', last_error: 'throttled' })));
  });

  describe('organization, incarnation, class and stream fence', () => {
    it('no receipt of another organization, another incarnation of an endpoint, another class, source name, stream or polarity suppresses the re-observation, which is written for this organization and the current incarnations', async () => {
      const t = await synced();
      await ageAll(t.org, '8 days');
      const [target, ...others] = t.edges as [Edge, Edge, Edge];
      const base = { org: t.org, edge: target, fromInc: t.rel['incarnation_id'], toInc: t.models[0]!['incarnation_id'] };
      await decoy({ ...base, org: randomUUID() }); // another organization naming this tenant's ids and incarnations
      await decoy({ ...base, fromInc: randomUUID() }); // an older incarnation of the release
      await decoy({ ...base, toInc: randomUUID() }); // an older incarnation of the model
      await decoy({ ...base, cls: 'declared' });
      await decoy({ ...base, sourceName: 'other_sync' });
      await decoy({ ...base, sourceId: 'other_stream' });
      await decoy({ ...base, sourceId: null });
      await decoy({ ...base, polarity: 'contradicts' });
      const before = await receiptsOf(target);
      expect(before).toHaveLength(9);

      await expect(sync(t.org)).resolves.toMatchObject({ success: true, unchanged: 4 });

      const added = (await receiptsOf(target)).filter(r => !before.some(b => b['receipt_id'] === r['receipt_id']));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ ...STREAM_RECEIPT, organization_id: t.org, from_incarnation_id: t.rel['incarnation_id'],
        to_incarnation_id: t.models[0]!['incarnation_id'], rationale_code: 'reobserved' });
      for (const edge of others) expect((await receiptsOf(edge)).map(r => r['rationale_code'])).toEqual([null, 'reobserved']);
    });

    it("another organization's aged edge is neither re-observed nor named by this tenant's sync, and a link to its CIs is refused with no receipt", async () => {
      const [a, b] = [await synced(), await synced()];
      await ageAll(a.org, '8 days');
      await ageAll(b.org, '8 days');
      const bBefore = await Promise.all(b.edges.map(receiptsOf));
      await sync(a.org);
      expect(await Promise.all(b.edges.map(receiptsOf))).toEqual(bBefore);
      expect(await currentness(b)).toEqual(['stale', 'stale', 'stale']);
      expect(await currentness(a)).toEqual(['current', 'current', 'current']);
      expect(await count(`SELECT count(*)::int AS n FROM relationship_evidence_receipts WHERE organization_id = $1
        AND (from_ci_id = ANY($2::text[]) OR to_ci_id = ANY($2::text[]))`, [a.org, [b.rel['id'], ...b.models.map(m => m['id'])]])).toBe(0);

      const writer = new AISyncWriter(getNeo4jClient());
      const total = await count('SELECT count(*)::int AS n FROM relationship_evidence_receipts');
      await expect(writer.link(a.org, 'c4_releases', b.rel['id'], 'USES', b.models[0]!['id'])).rejects.toBeInstanceOf(AISyncWriteRefused);
      await expect(writer.link(a.org, 'c4_releases', a.rel['id'], 'USES', b.models[0]!['id'])).rejects.toBeInstanceOf(AISyncWriteRefused);
      await expect(writer.link(b.org, 'c4_releases', b.rel['id'], 'USES', a.models[0]!['id'])).rejects.toBeInstanceOf(AISyncWriteRefused);
      expect(await count('SELECT count(*)::int AS n FROM relationship_evidence_receipts')).toBe(total);
    });
  });

  it('an edge that vanishes between the existence check and the plan is created through the normal path: one receipt, no re-observation row', async () => {
    const t = await synced();
    const [edge] = t.edges as [Edge, Edge, Edge];
    await ageAll(t.org, '8 days');
    const client = getNeo4jClient();
    const real = client.hasRecentObservation.bind(client);
    let calls = 0;
    jest.spyOn(client, 'hasRecentObservation').mockImplementation(async (...args) => {
      const recent = await real(...args);
      if (calls++ === 0) mockGraph.edges.splice(mockGraph.edges.findIndex(e => e.from === edge.from && e.to === edge.to), 1);
      return recent;
    });
    const base = await costs(t.org);
    await expect(new AISyncWriter(client).link(t.org, 'c4_releases', edge.from, 'USES', edge.to)).resolves.toBe('created');
    expect(mockGraph.edges).toContainEqual(edge);
    const receipts = await receiptsOf(edge);
    expect(receipts.map(r => r['rationale_code'])).toEqual([null, null]); // the aged creation receipt and the new creation receipt
    expect(receipts[1]).toMatchObject({ ...STREAM_RECEIPT, organization_id: t.org, polarity: 'supports' });
    expect((await costs(t.org)).receipts).toBe(base.receipts + 1);
    expect(await rows(`SELECT last_error FROM ci_reconciliation_operations WHERE organization_id = $1 AND state = 'aborted'
      AND ci_id = $2`, [t.org, edge.from])).toEqual([{ last_error: 'target_missing' }]);
  });

  it('recovery: a re-observation that dies before T2 leaves a pending group without graph effect and no receipt; the sweep commits exactly one, replay-idempotently', async () => {
    const t = await synced();
    const [edge] = t.edges as [Edge, Edge, Edge];
    await ageAll(t.org, '8 days');
    const base = await costs(t.org);
    const graphBefore = await graphAndAudit();
    setJournalSeam(async point => { if (point === 'beforeT2') throw new Error('crash before T2'); });
    await expect(new AISyncWriter(getNeo4jClient()).link(t.org, 'c4_releases', edge.from, 'USES', edge.to)).rejects.toThrow();
    setJournalSeam(undefined);
    expect(await receiptsOf(edge)).toHaveLength(1);
    const pending = await rows(`SELECT state, operation, graph_effect, group_id FROM ci_reconciliation_operations
      WHERE organization_id = $1 AND ci_id = ANY($2::text[]) AND state = 'pending'`, [t.org, [edge.from, edge.to]]);
    expect(pending.map(p => [p['state'], p['operation'], p['graph_effect']])).toEqual([['pending', 'relationship_write', false],
      ['pending', 'relationship_write', false]]);

    await rows(`UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval '1 minute'
      WHERE organization_id = $1 AND ci_id = ANY($2::text[]) AND state = 'pending'`, [t.org, [edge.from, edge.to]]);
    await getNeo4jClient().journal.sweep();
    await getNeo4jClient().journal.sweep();

    const receipts = await receiptsOf(edge);
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({ ...STREAM_RECEIPT, organization_id: t.org, rationale_code: 'reobserved',
      correlation_id: pending[0]!['group_id'], from_incarnation_id: t.rel['incarnation_id'] });
    expect((await rows(`SELECT DISTINCT state, graph_effect FROM ci_reconciliation_operations WHERE group_id = $1`, [pending[0]!['group_id']])))
      .toEqual([{ state: 'committed', graph_effect: false }]);
    expect(await costs(t.org)).toMatchObject({ receipts: base.receipts + 1, audit: base.audit });
    expect(await graphAndAudit()).toEqual(graphBefore);
    await expect(new AISyncWriter(getNeo4jClient()).link(t.org, 'c4_releases', edge.from, 'USES', edge.to)).resolves.toBe('unchanged');
  });

  it('steady state: a sync over unchanged, throttled edges issues no journal operation and no audit row, writes no receipt and reads receipts once per edge', async () => {
    const t = await synced();
    const base = await costs(t.org);
    const first = statements.length;
    await expect(sync(t.org)).resolves.toMatchObject({ success: true, created: 0, updated: 0, unchanged: 4 });
    const issued = statements.slice(first);
    expect(issued.filter(text => /FROM relationship_evidence_receipts/.test(text))).toHaveLength(t.edges.length);
    expect(issued.filter(text => /INSERT INTO (relationship_evidence_receipts|ci_reconciliation_operations|audit_log)/.test(text))).toEqual([]);
    expect(await costs(t.org)).toEqual(base);
  });

  it('observer type: the AI creation and re-observation receipts are system, a receipt written through POST /relationships is still user', async () => {
    const t = await synced();
    await ageAll(t.org, '8 days');
    await sync(t.org);
    expect(await Promise.all(t.edges.map(async e => (await receiptsOf(e)).map(r => [r['rationale_code'], r['observer_type'], r['observer']]))))
      .toEqual(t.edges.map(() => [[null, 'system', 'sync:c4_releases'], ['reobserved', 'system', 'sync:c4_releases']]));

    const [from, to] = [seed(t.org), seed(t.org)];
    const created = await request(app).post('/api/v1/relationships').set(login(t.org, 'admin')).send({ from_id: from, to_id: to, type: 'DEPENDS_ON' });
    expect(created.status).toBe(201);
    expect((await receiptsOf({ from, to, type: 'DEPENDS_ON' })).map(r => [r['evidence_class'], r['observer_type'], r['observer']]))
      .toEqual([['declared', 'user', `admin-${t.org}`]]);
  });

  it('reads agree: after the re-observation the impact graph counts both receipts, reports static_observed and the newest support, and its receipts_href lists the same two', async () => {
    const t = await synced();
    graphEdges(t.org);
    await ageAll(t.org, '8 days');
    await sync(t.org);
    const [edge] = t.edges as [Edge, Edge, Edge];
    const graph = await request(app).get(`/api/v1/impact/graph/${edge.to}`).set(login(t.org, 'viewer'));
    expect(graph.status).toBe(200);
    expect(graph.body.data.edges).toHaveLength(1);
    const [qualified] = graph.body.data.edges;
    const receipts = await receiptsOf(edge);
    expect(receipts).toHaveLength(2);
    expect(qualified).toMatchObject({ source_id: edge.from, target_id: edge.to, relationship_type: 'USES', currentness: 'current',
      evidence: { classes: ['static_observed'], support: { supports: 2, contradicts: 0 }, receipt_count: 2, receipts_truncated: false,
        last_supported_at: (receipts[1]!['observed_at'] as Date).toISOString() } });
    const listed = await request(app).get(qualified.evidence.receipts_href).set(login(t.org, 'viewer'));
    expect(listed.status).toBe(200);
    expect(listed.body.pagination.total).toBe(2);
    expect(listed.body.data.receipts.map((r: any) => r.rationale_code)).toEqual(NEWEST_FIRST);
  });
});

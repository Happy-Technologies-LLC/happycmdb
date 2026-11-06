// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1444 (AAI S2): the per-tenant C4 sync writes agent-release and ai-model CIs (USES) through AISyncWriter, retires
 * revoked releases and never deletes. Real journal, audit chain, credential store and ai_sync_cursors on PGlite as the
 * app login cmdb_user; Neo4j is an in-memory node and edge map; C4 is a 127.0.0.1 server answering Suite Contracts v2
 * C4 records `A` in the common paging envelope {items, next_cursor, as_of}, one item per page.
 */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';

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
import { getEncryptionService } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient, getUnifiedCredentialService } from '@cmdb/database';
import { AISyncScheduler } from '../../../../../discovery-engine/src/schedulers/ai-sync-scheduler';
import { enqueueC4ReleaseSyncs, syncC4Releases } from '../../../../../discovery-engine/src/ai-sync/c4-release-sync';
import { APP_GRANTS_SQL, ENTER_APP_LOGIN_SQL, assertAppLogin, createLoginRolesSql, journalReadAclSql } from './fixtures/app-login';

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

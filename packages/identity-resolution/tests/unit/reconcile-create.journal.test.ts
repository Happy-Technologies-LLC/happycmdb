// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2016 (HP1-S5 child 2): IdentityReconciliationEngine.reconcileCI creates a missing CI through the journal
 * (createFromMerge), not a raw Cypher CREATE. Real Neo4jClient, journal, audit chain and engine on PGlite; Neo4j is an
 * in-memory node map (fences, global id uniqueness) that also answers the engine's identification queries and applies a
 * raw unfenced CREATE, so a create that bypasses the journal shows up as a node with no journal, history or audit row.
 */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'system:identity-reconciliation';
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, '../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'),
  [], { serialization: 'advanced' });
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

const mockGraph = { nodes: new Map<string, Record<string, any>>(), fences: new Map<string, Record<string, unknown>>(),
  creates: [] as string[], failCreate: false };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const conflict = (message: string) =>
    Object.assign(new Error(message), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' });
  const owned = (org: unknown) => [...mockGraph.nodes.values()].filter(node => node['organization_id'] === org);
  const run = async (query: string, params: Record<string, any> = {}) => {
    if (query.includes('entityType')) {
      return { records: [record({ labelsOrTypes: ['CI'], properties: ['organization_id', 'external_id'] })] };
    }
    if (query.includes('SHOW CONSTRAINTS')) return { records: [record({ present: 1 })] };
    if (query.includes('MERGE (op:ReconciliationOp')) {
      return { records: [record(mockGraph.fences.get(params['op']) ??
        { outcome: 'aborted', org: params['org'], ci: params['ci'], operation: params['operation'] })] };
    }
    if (query.includes('fences_created')) {
      if (query.startsWith('CREATE (ci:CI') && mockGraph.failCreate) throw new Error('graph unavailable');
      const existing = mockGraph.nodes.get(params['id']);
      let node = existing?.['organization_id'] === params['org'] ? existing : undefined;
      if (query.startsWith('CREATE (ci:CI')) {
        if (existing) throw conflict('ci_id_unique');
        mockGraph.creates.push(params['id']);
        node = { ...params['props'], id: params['id'], organization_id: params['org'],
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        mockGraph.nodes.set(params['id'], node!);
      } else if (node) Object.assign(node, params['props']);
      for (const fence of node ? params['fences'] : []) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: node ? params['fences'].length : 0 })] };
    }
    if (query.includes('SET ci = $properties')) { // the pre-HAP-2016 raw create: no fence, no journal
      mockGraph.creates.push(params['properties'].id);
      mockGraph.nodes.set(params['properties'].id, { ...params['properties'], incarnation_id: 'raw' });
      return { records: [record({ ci_id: params['properties'].id, incarnation_id: 'raw' })] };
    }
    if (query.includes('UNWIND range')) {
      const id = (params['ciIds'] as string[]).find(candidate => mockGraph.nodes.get(candidate)?.['organization_id'] === params['organizationId']);
      return { records: id ? [record({ ci_id: id })] : [] };
    }
    const attribute = /ci\.(\w+) = \$value/.exec(query)?.[1];
    if (attribute) {
      const found = owned(params['organizationId']).find(node => node[attribute] === params['value']);
      return { records: found ? [record({ ci_id: found['id'] })] : [] };
    }
    const scoped = params['organizationId'] ?? undefined;
    const found = mockGraph.nodes.get(params['id']);
    const node = found && (scoped === undefined || found['organization_id'] === scoped) ? found : undefined;
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    throw new Error(`unexpected statement: ${query}`);
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
const mockEmit = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: () => ({ emit: (...args: unknown[]) => mockEmit(...args) }),
  EventType: { CI_UPDATED: 'ci.updated', CI_DISCOVERED: 'ci.discovered' },
}));

import { PlanUnrepresentableError, getAuditService, getNeo4jClient, getPostgresClient, JournalAbortedError,
  JournalGapError, JournalUnavailableError, setJournalSeam } from '@cmdb/database';
import { SourceOwnedError } from '@cmdb/common';
import { IdentityReconciliationEngine } from '../../src/engine/identity-reconciliation-engine';

jest.setTimeout(30000);

const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const exec = (text: string) => mockSql(text, [], 'exec');
const engine = () => IdentityReconciliationEngine.getInstance();

const discovered = (overrides: Record<string, unknown> = {}) => ({
  name: 'web-01', ci_type: 'server', source: 'vmware', source_id: 'vm-100', environment: 'production',
  identifiers: { serial_number: 'SN-100' }, attributes: { os: 'linux' }, relationships: [], confidence_score: 90,
  ...overrides,
}) as Parameters<IdentityReconciliationEngine['reconcileCI']>[0];

/** Everything the journal, lineage and field-source tables hold for one CI (all organizations), oldest first. */
const trail = async (ciId: string) => ({
  operations: await rows(`SELECT operation, state, actor, organization_id FROM ci_reconciliation_operations
    WHERE ci_id = $1 ORDER BY created_at`, [ciId]),
  history: await rows(`SELECT change_type, change_source, organization_id FROM ci_change_history
    WHERE ci_id = $1 ORDER BY changed_at, id`, [ciId]),
  audit: await rows(`SELECT action, actor, actor_type, organization_id FROM audit_log WHERE entity_id = $1 ORDER BY timestamp, id`, [ciId]),
  lineage: await rows(`SELECT source_name, source_id, organization_id FROM ci_source_lineage WHERE ci_id = $1`, [ciId]),
  fields: await rows(`SELECT field_name, source_name, organization_id FROM ci_field_sources WHERE ci_id = $1 ORDER BY field_name`, [ciId]),
});
const COUNT_TABLES = ['ci_reconciliation_operations', 'ci_change_history', 'audit_log', 'ci_source_lineage', 'ci_field_sources'];
const snapshot = async () => ({
  nodes: [...mockGraph.nodes.entries()].map(([id, node]) => [id, { ...node }]),
  tables: Object.fromEntries(await Promise.all(COUNT_TABLES.map(async table =>
    [table, (await rows(`SELECT count(*)::int AS n FROM ${table}`))[0]!['n']]))),
});
const created = (organization: string) => ({ operations: [{ operation: 'create', state: 'committed', actor: ACTOR, organization_id: organization }],
  history: [{ change_type: 'created', change_source: 'vmware', organization_id: organization }],
  audit: [{ action: 'CREATE', actor: ACTOR, actor_type: 'system', organization_id: organization }],
  lineage: [{ source_name: 'vmware', source_id: 'vm-100', organization_id: organization }],
  fields: [{ field_name: 'os', source_name: 'vmware', organization_id: organization }] });

beforeAll(async () => {
  const migrations = join(__dirname, '../../../database/src/postgres/migrations');
  const sql = (file: string) => readFileSync(join(migrations, file), 'utf8');
  const schema = sql('001_complete_schema.sql');
  await exec(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ...['audit_log', 'cmdb.dim_ci',
    'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts', 'reconciliation_rules', 'source_authority', 'ci_change_history',
    'dim_business_services'].map(table => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0])]
    .join('\n'));
  for (const file of ['003_audit_hash_chain.sql', '011_ci_organization_scope.sql', '028_change_history_reconciliation_org_provenance.sql',
    '029_reconciliation_conflict_identity_rules.sql', '037_reconciliation_org_contract.sql']) await exec(sql(file));
  await exec(`ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required CHECK (organization_id IS NOT NULL) NOT VALID;`);
}, 60000);
afterAll(() => { host.kill(); });
beforeEach(async () => {
  mockGraph.nodes.clear(); mockGraph.fences.clear(); mockGraph.creates.length = 0; mockGraph.failCreate = false;
  mockEmit.mockClear();
  for (const table of [...COUNT_TABLES, 'cmdb.dim_ci']) await rows(`DELETE FROM ${table}`);
  await rows('DELETE FROM source_authority WHERE organization_id IS NOT NULL');
});
afterEach(() => setJournalSeam(undefined));

describe('create-if-missing is one journaled create under a stable id', () => {
  it('gives two organizations two CIs for one (source, source_id), each with its own journal, history, audit, lineage and field sources', async () => {
    const idA = await engine().reconcileCI(discovered(), ORG_A);
    const idB = await engine().reconcileCI(discovered(), ORG_B);

    expect(idA).toMatch(/^ci_[0-9a-f]{32}$/);
    expect(idB).toMatch(/^ci_[0-9a-f]{32}$/);
    expect(idA).not.toBe(idB);
    expect(mockGraph.nodes.get(idA!)).toMatchObject({ organization_id: ORG_A, name: 'web-01', serial_number: 'SN-100', os: 'linux' });
    expect(mockGraph.nodes.get(idB!)).toMatchObject({ organization_id: ORG_B, name: 'web-01', serial_number: 'SN-100', os: 'linux' });
    expect(await trail(idA!)).toEqual(created(ORG_A));
    expect(await trail(idB!)).toEqual(created(ORG_B));
    // Neither CI is visible to the other organization's identification.
    expect((await engine().findExistingCI({ serial_number: 'SN-100' }, discovered(), ORG_A))?.ci_id).toBe(idA);
    expect((await engine().findExistingCI({ serial_number: 'SN-100' }, discovered(), ORG_B))?.ci_id).toBe(idB);
    expect(await getAuditService(getPostgresClient().pool).verifyAuditChain()).toMatchObject({ ok: true });
    expect(mockEmit.mock.calls.map(([type, , payload]) => [type, (payload as { ci_id: string }).ci_id,
      (payload as { organization_id: string }).organization_id])).toEqual([
      ['ci.discovered', idA, ORG_A], ['ci.discovered', idB, ORG_B]]);
  });

  it('a repeat in the same organization updates the same CI and creates no second node', async () => {
    const first = await engine().reconcileCI(discovered(), ORG_A);
    mockEmit.mockClear();
    const second = await engine().reconcileCI(discovered({ attributes: { os: 'linux', role: 'web' } }), ORG_A);

    expect(second).toBe(first);
    expect([...mockGraph.nodes.keys()]).toEqual([first]);
    expect(mockGraph.nodes.get(first!)).toMatchObject({ role: 'web' });
    expect((await trail(first!)).history.map(row => row.change_type)).toEqual(['created', 'updated']);
    expect((await trail(first!)).audit).toEqual([created(ORG_A).audit[0], { action: 'UPDATE', actor: ACTOR, actor_type: 'system', organization_id: ORG_A }]);
    expect(mockEmit.mock.calls.map(([type]) => type)).toEqual(['ci.updated']);
  });

  it('a retry that identifies nothing meets the stable id and never makes a second CI', async () => {
    const first = await engine().reconcileCI(discovered({ identifiers: {} }), ORG_A);
    const before = await snapshot();
    mockEmit.mockClear();

    await expect(engine().reconcileCI(discovered({ identifiers: {} }), ORG_A)).rejects.toBeInstanceOf(JournalAbortedError);

    expect(mockGraph.creates).toEqual([first]);
    expect((await snapshot()).nodes).toEqual(before.nodes);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("the creating source owns the attributes it wrote: a later source overwrites them only with at least its authority", async () => {
    const first = await engine().reconcileCI(discovered(), ORG_A); // vmware (authority 9) wrote os=linux
    await engine().reconcileCI(discovered({ source: 'nmap', source_id: '10.0.0.1', attributes: { os: 'windows' } }), ORG_A);
    expect(mockGraph.nodes.get(first!)).toMatchObject({ os: 'linux' }); // nmap (5) loses

    await rows(`INSERT INTO source_authority (organization_id, source_name, authority_score) VALUES ($1, 'nmap', 10)`, [ORG_A]);
    await engine().reconcileCI(discovered({ source: 'nmap', source_id: '10.0.0.1', attributes: { os: 'windows' } }), ORG_A);
    expect(mockGraph.nodes.get(first!)).toMatchObject({ os: 'windows' }); // the organization ranks nmap above vmware
    expect((await trail(first!)).fields).toEqual([{ field_name: 'os', source_name: 'nmap', organization_id: ORG_A }]);
  });
});

describe('a failed create leaves no node without its history row, and no event', () => {
  it('a rejected graph write leaves no node, no history, audit or lineage, and emits nothing', async () => {
    mockGraph.failCreate = true;
    const before = await snapshot();

    await expect(engine().reconcileCI(discovered(), ORG_A)).rejects.toBeInstanceOf(JournalUnavailableError);

    expect(mockGraph.nodes.size).toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
    // The pending intent is aborted by recovery (the fence was never written); nothing else appears.
    await rows(`UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval '1 minute'`);
    await getNeo4jClient().journal.sweep();
    const after = await snapshot();
    expect(mockGraph.nodes.size).toBe(0);
    expect({ ...after.tables, ci_reconciliation_operations: 0 }).toEqual({ ...before.tables, ci_reconciliation_operations: 0 });
    expect(await rows('SELECT state FROM ci_reconciliation_operations')).toEqual([{ state: 'aborted' }]);
  });

  it('a journal failure after the graph write holds the node pending with no event, and recovery writes its history, audit and lineage', async () => {
    setJournalSeam(async point => { if (point === 'afterW') throw new Error('process died after W'); });

    await expect(engine().reconcileCI(discovered(), ORG_A)).rejects.toBeInstanceOf(JournalUnavailableError);
    setJournalSeam(undefined);

    const [id] = [...mockGraph.nodes.keys()];
    expect(id).toMatch(/^ci_/);
    expect(mockEmit).not.toHaveBeenCalled();
    expect((await trail(id!)).history).toEqual([]);
    // The stable id keeps a retry out: it meets the in-flight gap instead of making a second CI.
    await expect(engine().reconcileCI(discovered(), ORG_A)).rejects.toBeInstanceOf(JournalGapError);
    expect(mockGraph.nodes.size).toBe(1);

    await rows(`UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval '1 minute'`);
    await getNeo4jClient().journal.sweep();
    expect(await trail(id!)).toEqual(created(ORG_A));
  });
});

describe('refusals write nothing', () => {
  it.each(['agent-release', 'ai-model', 'cell', 'ai-deployment'])('refuses the source-owned class %s', async ci_type => {
    const before = await snapshot();

    await expect(engine().reconcileCI(discovered({ ci_type }), ORG_A)).rejects.toBeInstanceOf(SourceOwnedError);

    expect(await snapshot()).toEqual(before);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it.each([
    ['a source_id over 255 characters', { source_id: 'x'.repeat(256) }],
    ['a source over 255 characters', { source: 'x'.repeat(256) }],
    ['a missing source_id', { source_id: '' }],
  ])('refuses %s as unrepresentable before any journal row', async (_name, overrides) => {
    const before = await snapshot();

    await expect(engine().reconcileCI(discovered(overrides), ORG_A)).rejects.toBeInstanceOf(PlanUnrepresentableError);

    expect(await snapshot()).toEqual(before);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2015 (HP1-S5 child 1): the ETL ReconciliationJob writes Neo4j only through the journaled Neo4jClient API
 * (createCI, updateCIProperties), scoped to the organization of the cmdb.dim_ci row. Real Neo4jClient, journal and audit
 * chain on PGlite; Neo4j is an in-memory node map (fences, per-org external_id uniqueness, global id uniqueness) that
 * records every graph write, so a write that bypasses the journal shows up as a node change with no journal row.
 */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Job } from 'bullmq';

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'system:etl-reconciliation';
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, '../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'),
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

const mockGraph = { nodes: new Map<string, Record<string, unknown>>(), fences: new Map<string, Record<string, unknown>>(),
  writes: [] as string[] };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const conflict = (message: string) =>
    Object.assign(new Error(message), { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' });
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
      mockGraph.writes.push(query);
      const existing = mockGraph.nodes.get(params['id']);
      let node = existing?.['organization_id'] === params['org'] ? existing : undefined;
      if (query.startsWith('CREATE (ci:CI')) {
        if (existing) throw conflict('ci_id_unique');
        const externalId = params['props'].external_id;
        if (externalId && [...mockGraph.nodes.values()].some(other =>
          other['organization_id'] === params['org'] && other['external_id'] === externalId)) throw conflict('external_id_unique');
        node = { ...params['props'], id: params['id'], organization_id: params['org'],
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        mockGraph.nodes.set(params['id'], node!);
      } else if (node) Object.assign(node, params['props']);
      for (const fence of node ? params['fences'] : []) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: node ? params['fences'].length : 0 })] };
    }
    const scoped = params['organizationId'] === null || params['organizationId'] === undefined ? undefined : params['organizationId'];
    const found = mockGraph.nodes.get(params['id']);
    const node = found && (scoped === undefined || found['organization_id'] === scoped) ? found : undefined;
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

import { logger } from '@cmdb/common';
import { getAuditService, getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { ReconciliationJob } from '../reconciliation.job';

jest.setTimeout(30000);

const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const exec = (text: string) => mockSql(text, [], 'exec');

async function addRow(ciId: string, organizationId: string,
  overrides: { type?: string; status?: string; externalId?: string | null } = {}): Promise<void> {
  await rows(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, external_id, is_current, organization_id)
    VALUES ($1, $2, $3, $4, 'production', $5, TRUE, $6)`,
  [ciId, `${ciId} name`, overrides.type ?? 'server', overrides.status ?? 'active', overrides.externalId ?? null, organizationId]);
}

function addNode(id: string, organizationId: string | undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const node = { id, name: `${id} name`, type: 'server', status: 'active', environment: 'production',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: '{}',
    ...(organizationId === undefined ? {} : { organization_id: organizationId }), ...overrides };
  mockGraph.nodes.set(id, node);
  return node;
}

const reconcile = (ciIds: string[], conflictStrategy: string) => new ReconciliationJob(getNeo4jClient(), getPostgresClient())
  .execute({ id: `recon-${conflictStrategy}`, data: { ciIds, autoResolve: true, conflictStrategy },
    updateProgress: async () => undefined } as unknown as Job);

/** Everything the journal leaves behind for one CI (all organizations), oldest first. */
const trail = async (ciId: string) => ({
  operations: await rows(`SELECT operation, state, actor, organization_id FROM ci_reconciliation_operations
    WHERE ci_id = $1 ORDER BY created_at`, [ciId]),
  // A direct write adds no ci_change_history row (only a plan with `history` does); its evidence is the operation and the audit row.
  audit: await rows(`SELECT action, actor, actor_type, organization_id FROM audit_log WHERE entity_id = $1 ORDER BY timestamp, id`, [ciId]),
});
const noTrail = { operations: [], audit: [] };

beforeAll(async () => {
  const migrations = join(__dirname, '../../../../database/src/postgres/migrations');
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
  mockGraph.nodes.clear(); mockGraph.fences.clear(); mockGraph.writes.length = 0;
  await rows('DELETE FROM cmdb.dim_ci');
});

describe('postgres-wins repair of a node missing in Neo4j', () => {
  it('creates it through the journal, stamped with the row organization only, with the row status; another org\'s node is untouched', async () => {
    await addRow('create-a', ORG_A, { status: 'maintenance', externalId: 'ext-a' });
    await addRow('create-b', ORG_B);
    const nodeB = addNode('create-b', ORG_B);
    const before = { ...nodeB };

    const result = await reconcile(['create-a', 'create-b'], 'postgres-wins');

    expect(result).toMatchObject({ _conflictsDetected: 1, _conflictsResolved: 1, _manualReviewRequired: 0 });
    expect(mockGraph.nodes.get('create-a')).toMatchObject({
      organization_id: ORG_A, status: 'maintenance', type: 'server', name: 'create-a name', environment: 'production',
      external_id: 'ext-a', incarnation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(mockGraph.nodes.get('create-b')).toEqual(before);
    expect(await trail('create-a')).toEqual({
      operations: [{ operation: 'direct_write', state: 'committed', actor: ACTOR, organization_id: ORG_A }],
      audit: [{ action: 'CREATE', actor: ACTOR, actor_type: 'system', organization_id: ORG_A }],
    });
    expect(await trail('create-b')).toEqual(noTrail);
    expect(await getAuditService(getPostgresClient().pool).verifyAuditChain()).toMatchObject({ ok: true });
  });

  it.each(['agent-release', 'ai-model', 'cell', 'ai-deployment'])('refuses the source-owned class %s: no node, no journal row', async type => {
    const id = `source-owned-${type}`;
    await addRow(id, ORG_A, { type });
    const writes = mockGraph.writes.length;

    const result = await reconcile([id], 'postgres-wins');

    expect(result).toMatchObject({ _conflictsDetected: 1, _conflictsResolved: 0, _manualReviewRequired: 1 });
    expect(mockGraph.nodes.has(id)).toBe(false);
    expect(mockGraph.writes.length).toBe(writes);
    expect(await trail(id)).toEqual(noTrail);
  });

  it('leaves the conflict unresolved when A\'s external_id is already taken in A, logging the error class and no value', async () => {
    addNode('holder', ORG_A, { external_id: 'ext-taken-9f3' });
    await addRow('duplicate-ext', ORG_A, { externalId: 'ext-taken-9f3' });
    const logged: string[] = [];
    const capture = (...args: unknown[]) => { logged.push(JSON.stringify(args)); return logger; };
    const spies = (['warn', 'error', 'info'] as const).map(level => jest.spyOn(logger, level).mockImplementation(capture as never));

    let result;
    try {
      result = await reconcile(['duplicate-ext'], 'postgres-wins');
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }

    expect(result).toMatchObject({ _conflictsDetected: 1, _conflictsResolved: 0, _manualReviewRequired: 1 });
    expect(mockGraph.nodes.has('duplicate-ext')).toBe(false);
    expect((await trail('duplicate-ext')).operations).toEqual([
      { operation: 'direct_write', state: 'aborted', actor: ACTOR, organization_id: ORG_A }]);
    expect((await trail('duplicate-ext')).audit).toEqual([]);
    expect(logged.some(line => line.includes('JournalAbortedError'))).toBe(true);
    expect(logged.filter(line => /ext-taken-9f3|duplicate-ext name/.test(line))).toEqual([]);
  });
});

describe('status repair of an existing row and node', () => {
  it('postgres-wins updates the node of the row organization through the journal; the same id in another org keeps its status', async () => {
    await addRow('status-a', ORG_A, { status: 'active' });
    addNode('status-a', ORG_A, { status: 'maintenance', incarnation_id: '33333333-3333-4333-8333-333333333333' });
    addNode('status-bystander', ORG_B, { status: 'maintenance' });
    await addRow('status-bystander', ORG_B, { status: 'active' });
    // Not reconciled by this run: it must never be touched.
    const bystander = { ...mockGraph.nodes.get('status-bystander')! };

    const result = await reconcile(['status-a'], 'postgres-wins');

    expect(result._conflictsResolved).toBe(1);
    expect(mockGraph.nodes.get('status-a')).toMatchObject({ organization_id: ORG_A, status: 'active',
      incarnation_id: '33333333-3333-4333-8333-333333333333' });
    expect(mockGraph.nodes.get('status-bystander')).toEqual(bystander);
    expect(await trail('status-a')).toEqual({
      operations: [{ operation: 'direct_write', state: 'committed', actor: ACTOR, organization_id: ORG_A }],
      audit: [{ action: 'UPDATE', actor: ACTOR, actor_type: 'system', organization_id: ORG_A }],
    });
    expect(await trail('status-bystander')).toEqual(noTrail);
  });

  it.each(['neo4j-wins', 'postgres-wins'])('%s writes nothing when org A re-created the id of B\'s current row', async strategy => {
    await addRow('reused', ORG_B, { status: 'active' });
    const nodeA = addNode('reused', ORG_A, { status: 'maintenance' });
    const before = { ...nodeA };
    const writes = mockGraph.writes.length;

    const result = await reconcile(['reused'], strategy);

    expect(result).toMatchObject({ _conflictsResolved: 0, _manualReviewRequired: 1 });
    expect(mockGraph.nodes.get('reused')).toEqual(before);
    expect(mockGraph.writes.length).toBe(writes);
    expect(await rows('SELECT ci_status, organization_id FROM cmdb.dim_ci WHERE ci_id = $1', ['reused']))
      .toEqual([{ ci_status: 'active', organization_id: ORG_B }]);
    expect(await trail('reused')).toEqual(noTrail);
  });

  it('postgres-wins leaves an org-less node of the internal organization unwritten (updateCIProperties is strict-org)', async () => {
    await addRow('orgless', INTERNAL_ORG, { status: 'active' });
    const node = addNode('orgless', undefined, { status: 'maintenance' });
    const before = { ...node };
    const writes = mockGraph.writes.length;

    const result = await reconcile(['orgless'], 'postgres-wins');

    expect(result).toMatchObject({ _conflictsResolved: 0, _manualReviewRequired: 1 });
    expect(mockGraph.nodes.get('orgless')).toEqual(before);
    expect(mockGraph.writes.length).toBe(writes);
    expect(await trail('orgless')).toEqual(noTrail);
  });

  it('neo4j-wins still copies the node status into PostgreSQL without a graph write', async () => {
    await addRow('pg-side', ORG_A, { status: 'active' });
    addNode('pg-side', ORG_A, { status: 'maintenance' });
    const writes = mockGraph.writes.length;

    const result = await reconcile(['pg-side'], 'neo4j-wins');

    expect(result._conflictsResolved).toBe(1);
    expect(await rows('SELECT ci_status FROM cmdb.dim_ci WHERE ci_id = $1', ['pg-side'])).toEqual([{ ci_status: 'maintenance' }]);
    expect(mockGraph.writes.length).toBe(writes);
  });
});

describe('status repair of a source-owned AI node', () => {
  it('postgres-wins leaves the status unrepaired: the journal refuses it before any row', async () => {
    await addRow('ai-status', ORG_A, { type: 'ai-model', status: 'active' });
    const node = addNode('ai-status', ORG_A, { type: 'ai-model', status: 'maintenance' });
    const before = { ...node };
    const writes = mockGraph.writes.length;

    const result = await reconcile(['ai-status'], 'postgres-wins');

    expect(result).toMatchObject({ _cisChecked: 1, _conflictsResolved: 0, _manualReviewRequired: 1 });
    expect(mockGraph.nodes.get('ai-status')).toEqual(before);
    expect(mockGraph.writes.length).toBe(writes);
    expect(await trail('ai-status')).toEqual(noTrail);
  });
});

// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * HAP-1530 seed-ci, the journaled CI seed tool for the CO-1 scratch CMDB.
 * S1: on an empty scratch CMDB one run gives the seeded CI through createCI (one committed direct_write journal op,
 * one HAP-784 audit CREATE row), its current cmdb.dim_ci row and its mapping; /context of the service serves the CI
 * node and its MAPPED_CI edge. S2: a re-run adds nothing. S3: the target guard refuses a non-scratch target, and the
 * tool holds no unjournaled :CI write. PostgreSQL is PGlite as the non-owner app login; Neo4j is an in-memory node map.
 */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import ts from 'typescript';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'), NODE_ENV: 'test',
  NEO4J_URI: 'bolt://127.0.0.1:7687', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});
const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
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
// The production PostgresClient, journal, ETL job and controller run on one PGlite session (calls are sequential).
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
  writes: [] as string[], marked: false };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const owned = (id: unknown, org: unknown) => mockGraph.nodes.get(id as string)?.['organization_id'] === org;
  const run = async (query: string, params: Record<string, any> = {}) => {
    if (query.includes('TenantFixtureMarker')) return { records: [record({ marked: mockGraph.marked, used: mockGraph.nodes.size > 0 })] };
    if (query.includes('SHOW CONSTRAINTS')) return { records: [record({ present: 1 })] };
    if (query.includes('MERGE (op:ReconciliationOp')) {
      return { records: [record(mockGraph.fences.get(params['op']) ?? { outcome: 'aborted', org: params['org'], ci: params['ci'], operation: params['operation'] })] };
    }
    if (query.includes('fences_created')) {
      mockGraph.writes.push(query);
      if (!query.startsWith('CREATE (ci:CI')) throw new Error(`unexpected graph write: ${query}`);
      const now = actual.types.DateTime.fromStandardDate(new Date()); // the statement's datetime()
      mockGraph.nodes.set(params['id'], { ...params['props'], id: params['id'], organization_id: params['org'], created_at: now, updated_at: now });
      for (const fence of params['fences']) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: params['fences'].length })] };
    }
    if (query.includes('ci.id IN $ids')) {
      return { records: (params['ids'] as string[]).filter(id => owned(id, params['organizationId'])).map(id => record({ id })) };
    }
    if (query.includes('UNWIND $frontier')) return { records: [] };
    const node = owned(params['id'], params['organizationId']) ? mockGraph.nodes.get(params['id']) : undefined;
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    throw new Error(`unexpected statement: ${query}`);
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));

import { BusinessServiceController } from '../../rest/controllers/business-service.controller';
import {
  APP_GRANTS_SQL, ENTER_APP_LOGIN_SQL, PGLITE_SUPERUSER, assertAppLogin, createLoginRolesSql, journalReadAclSql, migrationSql,
} from '../../rest/routes/__tests__/fixtures/app-login';
import { Neo4jClient } from '@cmdb/database';
import { assertTarget, main, parseArgs, SEED_CIS, TargetRefusedError } from '../seed-ci';

const [CI] = SEED_CIS;
const tableDdl = (source: string, tables: string[]) => tables.map(table =>
  source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0]).join('\n');
const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { stdout: line => out.push(line), stderr: line => err.push(line) });
  return { code, out, err };
};
const counts = async () => (await mockSql(`SELECT
  (SELECT count(*)::int FROM ci_reconciliation_operations WHERE ci_id = $1) AS ops,
  (SELECT count(*)::int FROM ci_reconciliation_operations
    WHERE ci_id = $1 AND organization_id = $3 AND operation = 'direct_write' AND state = 'committed') AS committed,
  (SELECT count(*)::int FROM audit_log WHERE entity_type = 'CI' AND entity_id = $1) AS audit,
  (SELECT count(*)::int FROM audit_log WHERE entity_type = 'CI' AND entity_id = $1 AND action = 'CREATE'
    AND organization_id = $3) AS audit_create,
  (SELECT count(*)::int FROM cmdb.dim_ci WHERE ci_id = $1) AS dim,
  (SELECT count(*)::int FROM ci_business_service_mappings WHERE ci_id = $1 AND service_id = $2) AS mapped`,
[CI!.id, CI!.serviceId, CI!.organizationId])).rows[0];
const context = () => {
  const controller = new BusinessServiceController();
  const app = express().get('/:service_id/context', (req, res) => {
    Object.assign(req, { user: { _userId: 'reader', _organizationId: CI!.organizationId } });
    void controller.getServiceContext(req, res);
  });
  return request(app).get(`/${CI!.serviceId}/context`);
};

beforeAll(async () => {
  const base = migrationSql('001_complete_schema.sql');
  await mockSql(['CREATE SCHEMA cmdb;', ...base.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, tableDdl(base, [
    'audit_log', 'cmdb.dim_ci', 'cmdb.fact_discovery', 'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts',
    'reconciliation_rules', 'source_authority', 'ci_change_history', 'dim_business_services', 'business_service_dependencies',
    'ci_business_service_mappings'])].join('\n'), [], 'exec');
  for (const file of ['003_audit_hash_chain.sql', '008_business_service_organization_scope.sql', '011_ci_organization_scope.sql',
    '028_change_history_reconciliation_org_provenance.sql', '029_reconciliation_conflict_identity_rules.sql',
    '037_reconciliation_org_contract.sql', '042_co1_access_request_fulfilment_seed.sql', '043_business_service_record_c1.sql']) {
    await mockSql(migrationSql(file), [], 'exec');
  }
  await mockSql(`ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
    CHECK (organization_id IS NOT NULL) NOT VALID;
    CREATE TABLE cmdb.tenant_fixture_marker (id int)`, [], 'exec'); // 025, 036 (S4a); the PostgreSQL fixture marker
  const [{ db }] = (await mockSql('SELECT current_database() AS db')).rows;
  // The app login holds the migration grants (fixture) plus the journal and ETL grants the tool uses: 045 gives the
  // journal tables to the staging app login; 034 gives cmdb_user INSERT on cmdb.fact_discovery.
  await mockSql(`${createLoginRolesSql(db)} RESET ROLE; ${APP_GRANTS_SQL} ${journalReadAclSql()}
    GRANT SELECT, INSERT, UPDATE ON ci_reconciliation_operations, ci_reconciliation_epochs TO cmdb_user;
    GRANT SELECT, INSERT ON ci_change_history, cmdb.fact_discovery TO cmdb_user;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public, cmdb TO cmdb_user; ${ENTER_APP_LOGIN_SQL}`, [], 'exec');
  await assertAppLogin(async sql => (await mockSql(sql)).rows);
});
afterAll(() => { host.kill(); });

describe('S3 target guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'seed-ci-approvals-'));
  mkdirSync(join(root, 'approvals'));
  afterAll(() => rmSync(root, { recursive: true }));
  /** Writes approvals/founder-<name>.go under the approvals root; returns its --founder-approval reference. */
  const approval = (name: string, text: string) => {
    writeFileSync(join(root, `approvals/founder-${name}.go`), text);
    return `approvals/founder-${name}.go`;
  };
  const GO = 'founder-GO 20261105T120000Z (Nick): seed-ci';
  const HOST = 'host=db.staging.internal\n';
  const NEO4J = 'neo4j=graph.staging.internal\n';
  /** A GO that matches `target` and the staging env on all three fields. */
  const matching = (target: string) => approval(target, `${GO} --target ${target}\ntarget: ${target}\n${HOST}${NEO4J}`);
  const env = { ...process.env, SEED_CI_APPROVALS_ROOT: root, POSTGRES_HOST: 'db.staging.internal',
    NEO4J_URI: 'neo4j+s://graph.staging.internal:7687' };
  const guard = (target: string, ref: string, guardEnv: NodeJS.ProcessEnv = env) =>
    () => assertTarget(parseArgs(['--target', target, '--founder-approval', ref]), guardEnv);

  it('refuses a non-scratch target unless founder-approved; a refused run connects to nothing and writes nothing', async () => {
    // Accepted only here, where pg, neo4j-driver and the BullMQ queue manager are jest mocks: nothing real is reachable.
    for (const target of ['staging', 'production']) {
      expect(() => assertTarget(parseArgs(['--target', target]), env)).toThrow(TargetRefusedError);
      expect(guard(target, matching(target))()).toEqual({ approvalSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
    approval('other', `founder-GO 20261105T120000Z: seed-tenant-fixture --target staging\ntarget: staging\n${HOST}${NEO4J}`);
    approval('nogo', `NO-GO 20261105T120000Z: seed-ci --target staging\ntarget: staging\n${HOST}${NEO4J}`);
    for (const [target, ref, approvalEnv] of [
      ['staging', 'yes', env], ['staging', 'approvals/founder-staging.go', process.env], ['staging', 'approvals/founder-missing.go', env],
      ['staging', 'approvals/founder-other.go', env], ['staging', 'approvals/founder-nogo.go', env], ['qa', 'approvals/founder-staging.go', env],
    ] as const) {
      expect(guard(target, ref, approvalEnv)).toThrow(TargetRefusedError);
    }
    // Built from process.env (which passes the scratch guard), so each case fails exactly one check.
    for (const scratchEnv of [{ ...process.env, NODE_ENV: 'production' }, { ...process.env, POSTGRES_HOST: 'db.internal' },
      { ...process.env, NEO4J_URI: 'neo4j://127.0.0.1:7687' }, { ...process.env, NEO4J_URI: 'bolt://graph.internal:7687' }]) {
      expect(() => assertTarget(parseArgs(['--target', 'scratch']), scratchEnv)).toThrow(TargetRefusedError);
    }
    const refused = await run(['--target', 'production']);
    expect([refused.code, refused.out, mockGraph.writes, await counts()])
      .toEqual([1, [], [], { ops: 0, committed: 0, audit: 0, audit_create: 0, dim: 0, mapped: 0 }]);
    expect(refused.err.join('\n')).toMatch(/--founder-approval/);
  });

  it('F1: NODE_ENV=production is refused for the scratch, staging and production targets, even with a matching GO', () => {
    expect(assertTarget(parseArgs(['--target', 'scratch']), process.env)).toBe('scratch');
    expect(() => assertTarget(parseArgs(['--target', 'scratch']), { ...process.env, NODE_ENV: 'production' })).toThrow(TargetRefusedError);
    for (const target of ['staging', 'production']) {
      const ref = matching(target);
      expect(guard(target, ref)).not.toThrow();
      expect(guard(target, ref, { ...env, NODE_ENV: 'production' })).toThrow(TargetRefusedError);
    }
  });

  it('F1: a GO whose host= differs from POSTGRES_HOST, or with POSTGRES_HOST unset, is refused and the run writes nothing', async () => {
    const ref = matching('staging');
    expect(guard('staging', ref)).not.toThrow();
    expect(guard('staging', ref, { ...env, POSTGRES_HOST: 'db.production.internal' })).toThrow(TargetRefusedError);
    expect(guard('staging', ref, { ...env, POSTGRES_HOST: undefined })).toThrow(TargetRefusedError);
    const blank = approval('blank-host', `${GO}\ntarget: staging\nhost=\n${NEO4J}`);
    expect(guard('staging', blank, { ...env, POSTGRES_HOST: undefined })).toThrow(TargetRefusedError);
    // A second, conflicting host= line does not bind even though one of them matches.
    const twice = approval('two-hosts', `${GO}\ntarget: staging\n${HOST}host=db.production.internal\n${NEO4J}`);
    expect(guard('staging', twice)).toThrow(TargetRefusedError);
    // Through main() with this process's env (POSTGRES_HOST=127.0.0.1): refused before any store is touched.
    process.env['SEED_CI_APPROVALS_ROOT'] = root;
    try {
      const refused = await run(['--target', 'staging', '--founder-approval', ref]);
      expect([refused.code, refused.out, mockGraph.writes, await counts()])
        .toEqual([1, [], [], { ops: 0, committed: 0, audit: 0, audit_create: 0, dim: 0, mapped: 0 }]);
    } finally {
      delete process.env['SEED_CI_APPROVALS_ROOT'];
    }
  });

  it('F1: a GO whose neo4j= differs from the NEO4J_URI host, or with NEO4J_URI unset, is refused', () => {
    const ref = matching('staging');
    expect(guard('staging', ref)).not.toThrow();
    expect(guard('staging', ref, { ...env, NEO4J_URI: 'neo4j+s://graph.production.internal:7687' })).toThrow(TargetRefusedError);
    expect(guard('staging', ref, { ...env, NEO4J_URI: undefined })).toThrow(TargetRefusedError);
  });

  it('F1: a GO without a host= line is refused', () => {
    expect(guard('staging', approval('no-host', `${GO}\ntarget: staging\n${NEO4J}`))).toThrow(TargetRefusedError);
  });

  it('F1: a GO without a neo4j= line is refused', () => {
    expect(guard('staging', approval('no-neo4j', `${GO}\ntarget: staging\n${HOST}`))).toThrow(TargetRefusedError);
  });

  it('F1: a GO naming the target only in prose (no target: field) is refused', () => {
    expect(guard('staging', approval('prose', `${GO} --target staging, then production.\n${HOST}${NEO4J}`)))
      .toThrow(TargetRefusedError);
  });

  it('F1: a GO whose target: field names another target is refused, even when its prose names this one', () => {
    const ref = approval('other-target', `${GO}: staging after this\ntarget: production\n${HOST}${NEO4J}`);
    expect(guard('production', ref)).not.toThrow();
    expect(guard('staging', ref)).toThrow(TargetRefusedError);
  });

  it('F1: --target "" and a target outside [A-Za-z0-9_-]+ are refused by parseArgs', () => {
    const ref = approval('prose-empty', `${GO} --target staging\n${HOST}${NEO4J}`);
    for (const target of ['', 'staging production']) {
      expect(() => parseArgs(['--target', target, '--founder-approval', ref])).toThrow();
    }
  });

  it('F1: --target scratch is refused unless REDIS_HOST is a loopback host', () => {
    expect(assertTarget(parseArgs(['--target', 'scratch']), process.env)).toBe('scratch');
    for (const redisHost of ['cache.internal', undefined]) {
      expect(() => assertTarget(parseArgs(['--target', 'scratch']), { ...process.env, REDIS_HOST: redisHost })).toThrow(TargetRefusedError);
    }
  });

  it('F1: LOOPBACK_HOSTS is typed ReadonlySet<string>: no add, delete or clear', () => {
    const file = join(__dirname, '../seed-tenant-fixture.ts');
    const program = ts.createProgram([file], { noResolve: true, noEmit: true, lib: ['lib.es2022.d.ts'], types: [] });
    const source = program.getSourceFile(file)!;
    let type: ts.Type | undefined;
    ts.forEachChild(source, function visit(node): void {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'LOOPBACK_HOSTS') {
        type = program.getTypeChecker().getTypeAtLocation(node.name);
      }
      ts.forEachChild(node, visit);
    });
    // `has` is the control: an unresolved (error) type has no members and would pass the second check vacuously.
    expect([type?.getProperty('has') !== undefined, ['add', 'delete', 'clear'].filter(name => type?.getProperty(name))])
      .toEqual([true, []]);
  });

  it('refuses --target scratch unless both stores carry the CO-1 tenant-fixture marker: nothing written', async () => {
    const nothing = { ops: 0, committed: 0, audit: 0, audit_create: 0, dim: 0, mapped: 0 };
    // The marker table is the superuser's (beforeAll): rename it as the superuser, then return to the app login.
    const renameMarker = (from: string, to: string) =>
      mockSql(`SET SESSION AUTHORIZATION ${PGLITE_SUPERUSER}; ALTER TABLE cmdb.${from} RENAME TO ${to}; ${ENTER_APP_LOGIN_SQL}`, [], 'exec');
    const graphUnmarked = await run(['--target', 'scratch']);
    mockGraph.marked = true;
    await renameMarker('tenant_fixture_marker', 'unmarked');
    const postgresUnmarked = await run(['--target', 'scratch']);
    await renameMarker('unmarked', 'tenant_fixture_marker');
    mockGraph.marked = false;
    expect([graphUnmarked.code, postgresUnmarked.code, mockGraph.writes, await counts()]).toEqual([1, 1, [], nothing]);
  });
});

describe('on the CO-1 scratch fixture', () => {
  beforeAll(() => { mockGraph.marked = true; });

  it('S1: one run journals the CI create (direct_write + one audit CREATE row), syncs dim_ci, maps it; /context serves it', async () => {
    const seeded = await run(['--target', 'scratch']);
    expect([seeded.code, seeded.err]).toEqual([0, []]);
    expect(JSON.parse(seeded.out[0]!).cis).toEqual([expect.objectContaining({ ci_id: CI!.id, created: true })]);
    expect(mockGraph.nodes.get(CI!.id)).toMatchObject({ name: CI!.name, type: CI!.type, organization_id: CI!.organizationId });
    expect(await counts()).toEqual({ ops: 1, committed: 1, audit: 1, audit_create: 1, dim: 1, mapped: 1 });
    const { status, body } = await context();
    expect(status).toBe(200);
    expect(body.data.nodes).toContainEqual({ kind: 'ci', id: CI!.id, name: CI!.name, type: CI!.type, status: 'active' });
    expect(body.data.edges).toContainEqual({ from: CI!.serviceId, to: CI!.id, type: 'MAPPED_CI', mapping_type: CI!.mappingType });
  });

  it('S2: a re-run is idempotent: no second CI, journal op, audit row, dim_ci version or mapping', async () => {
    const writes = mockGraph.writes.length;
    const again = await run(['--target', 'scratch']);
    expect([again.code, again.err]).toEqual([0, []]);
    expect(JSON.parse(again.out[0]!).cis).toEqual([expect.objectContaining({ ci_id: CI!.id, created: false })]);
    expect([mockGraph.writes.length, mockGraph.nodes.size]).toEqual([writes, 1]);
    expect(await counts()).toEqual({ ops: 1, committed: 1, audit: 1, audit_create: 1, dim: 1, mapped: 1 });
  });
});

it('S3: the tool holds no unjournaled :CI write (every statement is a read-only literal; createCI is its only graph writer)', () => {
  const source = ts.createSourceFile('seed-ci.ts', readFileSync(join(__dirname, '../seed-ci.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const graphMethods = new Set(Object.getOwnPropertyNames(Neo4jClient.prototype));
  const literals: string[] = [];
  const dynamicStatements: string[] = [];
  const graphCalls = new Set<string>();
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    if (ts.isTemplateExpression(node)) literals.push(node.head.text, ...node.templateSpans.map(span => span.literal.text));
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const [statement] = node.arguments;
      if (['run', 'query'].includes(name) && !(statement && (ts.isStringLiteral(statement) || ts.isNoSubstitutionTemplateLiteral(statement)))) {
        dynamicStatements.push(node.getText());
      }
      if (graphMethods.has(name)) graphCalls.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const WRITE_CLAUSE = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|INSERT|UPDATE|UPSERT|DROP|ALTER|TRUNCATE|FOREACH|LOAD|CALL|COPY|GRANT)\b/i;
  expect(literals.filter(text => WRITE_CLAUSE.test(text))).toEqual([]);
  expect(dynamicStatements).toEqual([]);
  // Neo4jClient's graph writers (createCI, updateCI, deleteCI, writeRelationship, ...): only createCI.
  expect([...graphCalls].sort()).toEqual(['close', 'createCI', 'getCI', 'getSession']);
  expect(imports.filter(name => /neo4j-driver|^pg$/.test(name))).toEqual([]);
});

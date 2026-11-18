// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { join } from 'path';
import * as YAML from 'yamljs';

// HAP-2030: openapi.yaml declares exactly what the four impact reads send. The real controllers (and, for the graph, the real
// route) run here; only the stores underneath them are stubbed at the module boundary.
const ORG = '11111111-1111-4111-8111-111111111111';
const INCARNATION = '22222222-2222-4222-8222-222222222222';
const READ_AT = new Date('2026-06-15T12:00:00.000Z');
const mockStores = {
  failEvidence: false as boolean,
  failTraversal: undefined as Error | undefined,
  failEngine: undefined as Error | undefined,
  neo4j: {
    getCI: async () => ({ id: 'ci-a', name: 'A', type: 'server' }),
    getDependenciesWithEdges: async (): Promise<unknown> => { throw new Error('unset'); },
    impactAnalysisWithEdges: async (): Promise<unknown> => { throw new Error('unset'); },
    getDependencyGraph: async (_roots: string[], _org: string, _depth: number, direction: 'in' | 'out'): Promise<unknown> => {
      throw new Error(`unset ${direction}`);
    },
    getCIIncarnations: async (ids: string[]) => new Map(ids.map(id => [id, INCARNATION])),
    getSession: () => ({ run: async () => ({ records: [{ get: () => 'ci-a' }] }), close: async () => undefined }),
  },
  pg: {
    async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
      if (text.includes('relationship_evidence_receipts')) {
        if (mockStores.failEvidence) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
        const [from, to, types] = [params[1], params[2], params[3]] as string[][];
        // ci-a's edges have a supporting declared receipt; every other edge has none (the LEFT JOIN's NULL row).
        return { rows: from.map((fromId, i) => fromId === 'ci-a'
          ? { from_id: fromId, to_id: to[i], rel_type: types[i], evidence_class: 'declared', polarity: 'supports', n: 2,
              newest: new Date(READ_AT.getTime() - 3_600_000), read_at: READ_AT }
          : { from_id: fromId, to_id: to[i], rel_type: types[i], evidence_class: null, polarity: null, n: null, newest: null, read_at: READ_AT }) };
      }
      if (text.includes('WITH RECURSIVE parent')) {
        return { rows: [{
          service_id: 'svc-1', name: 'Service', business_criticality: 'high', lifecycle: 'live', organization_id: ORG,
          out_walk: [{ src: 'svc-1', tgt: 'svc-2', dependency_type: 'hard', depth: 1, name: 'Other', business_criticality: 'low', lifecycle: 'live' }],
          in_walk: [],
          mapped_cis: [{ ci_id: 'ci-a', mapping_type: 'primary', ci_name: 'A', ci_type: 'server', ci_status: 'active' }],
        }] };
      }
      return { rows: [] }; // set_config and the impact envelope's lineage read
    },
    transaction<T>(callback: (client: { query: typeof mockStores.pg.query }) => Promise<T>): Promise<T> {
      return callback({ query: (text, params) => mockStores.pg.query(text, params) });
    },
  },
};
// Not requireActual('@cmdb/database'): its index opens a BullMQ Redis connection that keeps jest from exiting.
jest.mock('@cmdb/database', () => {
  const traversal = jest.requireActual<Record<string, unknown>>('@cmdb/database/neo4j/client');
  const journal = jest.requireActual<object>('@cmdb/database/journal/journal');
  const audit = jest.requireActual<Record<string, unknown>>('@cmdb/database/postgres/audit.service');
  return {
    ...journal,
    isStorableString: jest.requireActual<Record<string, unknown>>('@cmdb/database/journal/encoding')['isStorableString'],
    appendAuditEntry: audit['appendAuditEntry'],
    auditChainReady: audit['auditChainReady'],
    CITraversalLimitError: traversal['CITraversalLimitError'],
    createCITraversalWork: traversal['createCITraversalWork'],
    MAX_CI_TRAVERSAL_NODES: traversal['MAX_CI_TRAVERSAL_NODES'],
    MAX_CI_TRAVERSAL_WORK: traversal['MAX_CI_TRAVERSAL_WORK'],
    CI_TRAVERSAL_QUERY_TIMEOUT_MS: traversal['CI_TRAVERSAL_QUERY_TIMEOUT_MS'],
    getAuditService: () => ({}),
    getNeo4jClient: () => mockStores.neo4j,
    getPostgresClient: () => mockStores.pg,
  };
});
jest.mock('@cmdb/ai-ml-engine', () => ({
  ...jest.requireActual('@cmdb/ai-ml-engine'),
  getConfigurationDriftDetector: () => ({}),
  getImpactPredictionEngine: () => ({
    buildDependencyGraph: async () => {
      if (mockStores.failEngine) throw mockStores.failEngine;
      return {
        nodes: ['ci-a', 'ci-b', 'ci-c'].map(id => ({
          id, ci_id: id, ci_name: id.toUpperCase(), ci_type: 'server', criticality: 50, dependencies_count: 1, dependents_count: 1,
        })),
        edges: [
          { source_id: 'ci-a', target_id: 'ci-b', relationship_type: 'DEPENDS_ON', weight: 1, is_critical: false },
          { source_id: 'ci-c', target_id: 'ci-a', relationship_type: 'DEPENDS_ON', weight: 0.5, is_critical: true },
        ],
        metadata: { total_nodes: 3, total_edges: 2, max_depth: 3, generated_at: READ_AT.toISOString() },
      };
    },
  }),
}));
jest.mock('../../auth/auth-bootstrap', () => {
  const passthrough = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { getAuthMiddleware: () => ({ authenticate: passthrough, requireOrganization: passthrough, requirePermission: passthrough, requireRole: passthrough }) };
});

import express from 'express';
import request from 'supertest';
import { CITraversalLimitError } from '@cmdb/database';
import { ImpactCriticalityLimitError } from '@cmdb/ai-ml-engine';
import { CIController } from '../../rest/controllers/ci.controller';
import { BusinessServiceController } from '../../rest/controllers/business-service.controller';
import { impactRoutes } from '../../rest/routes/drift-impact.routes';
import {
  EDGE_EVIDENCE_SCAN_CAP, EVIDENCE_CLASS_ORDER, deriveCurrentness, edgeKey, qualifyEdges, summarizeEvidence,
  type EvidenceRow,
} from '../../rest/edge-evidence';

type Schema = {
  $ref?: string; type?: string; format?: string; nullable?: boolean; enum?: unknown[]; required?: string[];
  properties?: Record<string, Schema>; items?: Schema; minimum?: number; maximum?: number; description?: string;
};
type Response = { $ref?: string; content?: { 'application/json': { schema: Schema; example?: unknown } } };
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, { get: { responses: Record<string, Response> } }>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Response> };
};
const resolve = (schema: Schema): Schema => {
  if (!schema.$ref) return schema;
  const target = spec.components.schemas[schema.$ref.replace('#/components/schemas/', '')];
  if (!target) throw new Error(`Unresolved ${schema.$ref}`);
  return resolve(target);
};
const response = (path: string, status: string): Response | undefined => {
  const declared = spec.paths[path]!.get.responses[status];
  return declared?.$ref ? spec.components.responses[declared.$ref.replace('#/components/responses/', '')] : declared;
};
const body200 = (path: string): Schema => resolve(response(path, '200')!.content!['application/json'].schema);

/** What is wrong with `value` against `schema` (types, enums, required members, undeclared members, nullability). */
function violations(value: unknown, declared: Schema, at = '$'): string[] {
  const schema = resolve(declared);
  if (value === null) return schema.nullable ? [] : [`${at}: null is not allowed`];
  const found: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) found.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
  if (schema.type === 'string') {
    if (typeof value !== 'string') found.push(`${at}: not a string`);
    else if (schema.format === 'date-time' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)) found.push(`${at}: not a UTC date-time`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) found.push(`${at}: not an integer`);
    else if (schema.minimum !== undefined && (value as number) < schema.minimum) found.push(`${at}: below minimum`);
    else if (schema.maximum !== undefined && (value as number) > schema.maximum) found.push(`${at}: above maximum`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number') found.push(`${at}: not a number`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') found.push(`${at}: not a boolean`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) found.push(`${at}: not an array`);
    else value.forEach((item, i) => found.push(...violations(item, schema.items!, `${at}[${i}]`)));
  } else if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return [...found, `${at}: not an object`];
    const members = value as Record<string, unknown>;
    for (const name of schema.required ?? []) if (!(name in members)) found.push(`${at}.${name}: required member missing`);
    for (const [name, member] of Object.entries(members)) {
      if (!schema.properties?.[name]) found.push(`${at}.${name}: member is not declared`);
      else found.push(...violations(member, schema.properties[name]!, `${at}.${name}`));
    }
  }
  return found;
}

const asRequest = (params: Record<string, string>) => ({ params, query: {}, user: { _userId: 'user-1', _organizationId: ORG } }) as never;
const capture = () => {
  const out: { status: number; body?: any } = { status: 200 };
  const res = { status(code: number) { out.status = code; return res; }, json(body: unknown) { out.body = body; return res; } };
  return { out, res: res as never };
};
const setTraversals = () => {
  mockStores.neo4j.getDependenciesWithEdges = async () => ({ paths: [], edges: [{ from: 'ci-a', to: 'ci-b', type: 'DEPENDS_ON' }] });
  mockStores.neo4j.impactAnalysisWithEdges = async () => ({ nodes: [], edges: [{ from: 'ci-c', to: 'ci-a', type: 'DEPENDS_ON' }] });
};
const NOT_ESTABLISHED = { failEvidence: false, failTraversal: undefined, failEngine: undefined };
beforeEach(() => {
  Object.assign(mockStores, NOT_ESTABLISHED);
  setTraversals();
  mockStores.neo4j.getDependencyGraph = async (_roots, _org, _depth, direction) => direction === 'out'
    ? { nodes: [{ ci: { _id: 'ci-b', name: 'B', _type: 'server', _status: 'active' }, distance: 0 }], edges: [{ from: 'ci-a', to: 'ci-b', type: 'DEPENDS_ON' }] }
    : { nodes: [{ ci: { _id: 'ci-c', name: 'C', _type: 'server', _status: 'active' }, distance: 0 }], edges: [{ from: 'ci-c', to: 'ci-a', type: 'DEPENDS_ON' }] };
});

const row = (evidence_class: EvidenceRow['evidence_class'], polarity: EvidenceRow['polarity'], ageMs: number): EvidenceRow =>
  ({ evidence_class, polarity, n: 1, newest: new Date(READ_AT.getTime() - ageMs) });
const DAY = 86_400_000;

describe('openapi.yaml EdgeCurrentness / EdgeEvidence / QualifiedEdge (HAP-2030)', () => {
  it('EdgeCurrentness enumerates exactly the values deriveCurrentness produces', () => {
    const produced = new Set([
      deriveCurrentness([], READ_AT),
      deriveCurrentness([row('declared', 'supports', DAY)], READ_AT),
      deriveCurrentness([row('declared', 'supports', 400 * DAY)], READ_AT),
      deriveCurrentness([row('declared', 'supports', 2 * DAY), row('declared', 'contradicts', DAY)], READ_AT),
      deriveCurrentness([row('inferred', 'supports', 1)], READ_AT),
      deriveCurrentness([row('runtime_observed', 'supports', 1)], READ_AT),
      deriveCurrentness([row('static_observed', 'supports', 30 * DAY)], READ_AT),
    ]);
    expect([...(spec.components.schemas['EdgeCurrentness']!.enum as string[])].sort()).toEqual([...produced].sort());
  });

  it('EdgeEvidence declares every member summarizeEvidence sends, all required, and nothing else', () => {
    const sent = [
      summarizeEvidence('a', 'b', 'DEPENDS_ON', [row('declared', 'supports', DAY), row('inferred', 'contradicts', DAY)]),
      summarizeEvidence('a', 'b', 'DEPENDS_ON', []),
    ];
    const evidence = resolve(spec.components.schemas['EdgeEvidence']!);
    for (const one of sent) {
      expect(Object.keys(evidence.properties!).sort()).toEqual(Object.keys(one).sort());
      expect([...evidence.required!].sort()).toEqual(Object.keys(one).sort());
      expect(violations(one, evidence)).toEqual([]);
    }
  });

  it('EdgeEvidence.classes items are the classes in the order the service reports them', () => {
    const classes = resolve(spec.components.schemas['EdgeEvidence']!).properties!['classes']!;
    expect(classes.items!.enum).toEqual([...EVIDENCE_CLASS_ORDER]);
  });

  it('EdgeEvidence.receipt_count is capped at the scan cap, so a full scan is representable and nothing beyond it', () => {
    const count = resolve(spec.components.schemas['EdgeEvidence']!).properties!['receipt_count']!;
    expect(count.maximum).toBe(EDGE_EVIDENCE_SCAN_CAP);
    const full = summarizeEvidence('a', 'b', 'T', [{ evidence_class: 'declared', polarity: 'supports', n: EDGE_EVIDENCE_SCAN_CAP, newest: READ_AT }]);
    expect(violations(full, spec.components.schemas['EdgeEvidence']!)).toEqual([]);
  });

  it('QualifiedEdge declares exactly the members qualifyEdges sends, all required', () => {
    const edge = qualifyEdges([{ from: 'a', to: 'b', type: 'DEPENDS_ON' }], new Map([[
      edgeKey('a', 'b', 'DEPENDS_ON'),
      { currentness: 'current' as const, evidence: summarizeEvidence('a', 'b', 'DEPENDS_ON', [row('declared', 'supports', DAY)]) },
    ]]))[0]!;
    const schema = resolve(spec.components.schemas['QualifiedEdge']!);
    expect(Object.keys(schema.properties!).sort()).toEqual(Object.keys(edge).sort());
    expect([...schema.required!].sort()).toEqual(Object.keys(edge).sort());
    expect(violations(edge, schema)).toEqual([]);
  });
});

describe.each([
  // impact also follows the upstream edge of ci-c, which has no receipt: both evidence shapes are sent
  ['/cis/{id}/dependencies', 'getCIDependencies', [false]],
  ['/cis/{id}/impact', 'getImpactAnalysis', [false, true]],
] as const)('openapi.yaml %s (HAP-2030)', (path, method, unsupportedShapes) => {
  const run = async () => {
    const { out, res } = capture();
    await new CIController()[method](asRequest({ id: 'ci-a' }), res);
    return out;
  };

  it('requires edges, each a QualifiedEdge, and the controller sends exactly that', async () => {
    const schema = body200(path);
    expect(schema.required).toContain('edges');
    expect(schema.properties!['edges']!.type).toBe('array');
    const sent = await run();
    expect(sent.status).toBe(200);
    expect(sent.body.edges.length).toBeGreaterThan(0);
    expect(violations(sent.body.edges, schema.properties!['edges']!)).toEqual([]);
    const shapes = sent.body.edges.map((edge: { evidence: { last_supported_at: string | null } }) => edge.evidence.last_supported_at === null);
    expect([...new Set(shapes)].sort()).toEqual([...unsupportedShapes].sort());
  });

  it('documents the 503 and 504 bodies the traversal failure sends, and no partial body comes with them', async () => {
    mockStores.neo4j.getDependenciesWithEdges = async () => { throw new CITraversalLimitError(); };
    const limited = await run();
    expect(limited.status).toBe(503);
    expect(response(path, '503')!.content!['application/json'].example).toEqual(limited.body);
    expect(violations(limited.body, response(path, '503')!.content!['application/json'].schema)).toEqual([]);

    setTraversals();
    mockStores.failEvidence = true; // the evidence statement itself is cancelled by statement_timeout
    const timedOut = await run();
    expect(timedOut.status).toBe(504);
    expect(response(path, '504')!.content!['application/json'].example).toEqual(timedOut.body);
    expect(violations(timedOut.body, response(path, '504')!.content!['application/json'].schema)).toEqual([]);
    expect(Object.keys(timedOut.body).sort()).toEqual(['error', 'success']);
  });
});

describe('openapi.yaml /impact/graph/{rootCiId} (HAP-2030)', () => {
  const app = express();
  app.use((req, _res, next) => { (req as never as { user: unknown }).user = { _userId: 'user-1', _organizationId: ORG, _role: 'viewer' }; next(); });
  app.use('/impact', impactRoutes);
  const edgeSchema = () => body200('/impact/graph/{rootCiId}').properties!['data']!.properties!['edges']!.items!;

  it('requires currentness and evidence on every edge and the real route sends exactly the declared members', async () => {
    const sent = await request(app).get('/impact/graph/ci-a');
    expect(sent.status).toBe(200);
    const item = resolve(edgeSchema());
    expect(item.required).toEqual(expect.arrayContaining(['currentness', 'evidence']));
    expect(sent.body.data.edges).toHaveLength(2);
    for (const edge of sent.body.data.edges) {
      expect(Object.keys(edge).sort()).toEqual(Object.keys(item.properties!).sort());
      expect([...item.required!].sort()).toEqual(Object.keys(edge).sort());
    }
    expect(violations(sent.body.data.edges, { type: 'array', items: edgeSchema() })).toEqual([]);
    // ci-a's edge has a receipt, the other has none: both evidence shapes validate
    expect(sent.body.data.edges.map((edge: { currentness: string }) => edge.currentness)).toEqual(['current', 'unsupported']);
  });

  it('documents the 503 and 504 bodies of the route, including a cancelled evidence statement', async () => {
    mockStores.failEngine = new ImpactCriticalityLimitError();
    const limited = await request(app).get('/impact/graph/ci-a');
    expect(limited.status).toBe(503);
    expect(response('/impact/graph/{rootCiId}', '503')!.content!['application/json'].example).toEqual(limited.body);
    expect(violations(limited.body, response('/impact/graph/{rootCiId}', '503')!.content!['application/json'].schema)).toEqual([]);

    mockStores.failEngine = undefined;
    mockStores.failEvidence = true;
    const timedOut = await request(app).get('/impact/graph/ci-a');
    expect(timedOut.status).toBe(504);
    expect(response('/impact/graph/{rootCiId}', '504')!.content!['application/json'].example).toEqual(timedOut.body);
    expect(violations(timedOut.body, response('/impact/graph/{rootCiId}', '504')!.content!['application/json'].schema)).toEqual([]);
    expect(timedOut.body.data).toBeUndefined(); // never a partial graph
  });
});

describe('openapi.yaml /business-services/{service_id}/context (HAP-2030)', () => {
  const run = async () => {
    const { out, res } = capture();
    await new BusinessServiceController().getServiceContext(asRequest({ service_id: 'svc-1' }), res);
    return out;
  };
  const edgeItem = () => resolve(spec.components.schemas['BusinessServiceContext']!).properties!['edges']!.items!;

  it('declares currentness and evidence as OPTIONAL members of an edge, sent on CI edges only', async () => {
    const sent = await run();
    expect(sent.status).toBe(200);
    const item = resolve(edgeItem());
    expect(Object.keys(item.properties!)).toEqual(expect.arrayContaining(['currentness', 'evidence']));
    expect(item.required).not.toContain('currentness');
    expect(item.required).not.toContain('evidence');
    expect(violations(sent.body.data.edges, { type: 'array', items: edgeItem() })).toEqual([]);

    const edges = sent.body.data.edges as Array<Record<string, unknown>>;
    const ciEdges = edges.filter(edge => edge['type'] === 'DEPENDS_ON' && edge['from'] !== 'svc-1');
    const others = edges.filter(edge => !ciEdges.includes(edge));
    expect(ciEdges.map(edge => [edge['from'], edge['to']])).toEqual([['ci-a', 'ci-b'], ['ci-c', 'ci-a']]);
    for (const edge of ciEdges) expect(Object.keys(edge)).toEqual(expect.arrayContaining(['currentness', 'evidence']));
    expect(others.map(edge => edge['type']).sort()).toEqual(['DEPENDS_ON', 'MAPPED_CI']); // service-to-service and MAPPED_CI
    for (const edge of others) {
      expect(edge).not.toHaveProperty('currentness');
      expect(edge).not.toHaveProperty('evidence');
    }
    const described = resolve(spec.components.schemas['BusinessServiceContext']!).properties!['edges']!.description!;
    expect(described).toMatch(/service-to-service/);
    expect(described).toMatch(/MAPPED_CI/);
    expect(described).toMatch(/carry neither/);
  });

  it('documents the 503 and 504 bodies of the context read, including a cancelled evidence statement', async () => {
    mockStores.neo4j.getDependencyGraph = async () => { throw new CITraversalLimitError(); };
    const limited = await run();
    expect(limited.status).toBe(503);
    expect(response('/business-services/{service_id}/context', '503')!.content!['application/json'].example).toEqual(limited.body);

    mockStores.neo4j.getDependencyGraph = async (_roots, _org, _depth, direction) => (direction === 'out'
      ? { nodes: [], edges: [{ from: 'ci-a', to: 'ci-b', type: 'DEPENDS_ON' }] } : { nodes: [], edges: [] });
    mockStores.failEvidence = true;
    const timedOut = await run();
    expect(timedOut.status).toBe(504);
    expect(response('/business-services/{service_id}/context', '504')!.content!['application/json'].example).toEqual(timedOut.body);
    expect(timedOut.body.data).toBeUndefined();
  });
});

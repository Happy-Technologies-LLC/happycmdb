// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for /api/v1/cis, exercised through the real ciRoutes and
 * CIController behind the real AuthMiddleware/AuthService (JWT verification),
 * with the real Neo4jClient CI methods issuing their Cypher.
 *
 * Neo4j is replaced by an in-memory graph (`graph`) behind a fake driver
 * session. It recognises the statements the controller and Neo4jClient issue
 * and evaluates them over the graph, including each WHERE clause on
 * organization_id that the statement actually contains: a statement without
 * the tenant predicate matches every organization's nodes, exactly as Neo4j
 * would. The real-Neo4j counterpart is tests/integration/ci.api.test.ts.
 *
 * Also runs the backfill packages/database/src/neo4j/migrations/
 * 001_ci_organization_backfill.cypher statement by statement over the graph.
 */

import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import { Neo4jClient } from '../../../../../database/src/neo4j/client';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// In-memory graph and fake driver
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
interface Edge { type: string; from: string; to: string; properties: Props }
const graph = { nodes: new Map<string, Props>(), edges: [] as Edge[] };
let queryCount = 0;

interface FakeRecord { keys: string[]; get(key: string): unknown }
const node = (props: Props) => ({ labels: ['CI'], properties: props });
const record = (row: Record<string, unknown>): FakeRecord => ({ keys: Object.keys(row), get: (key: string) => row[key] });
const num = (value: unknown): number => (neo4j.isInt(value) ? value.toNumber() : Number(value));

/** Predicates the statement actually contains (absent => matches every organization). */
function tenantPredicate(cypher: string, params: Props, variable: string): (props: Props) => boolean {
  return cypher.includes(`${variable}.organization_id = $organizationId`)
    ? props => props['organization_id'] === params['organizationId']
    : () => true;
}

interface Path { nodes: string[]; edges: Edge[] }

/** Variable-length expansion with relationship uniqueness, like Cypher's `-[*1..depth]->`. */
function expand(startId: string, outgoing: boolean, type: string | null, depth: number): Path[] {
  const paths: Path[] = [];
  const walk = (current: Path) => {
    if (current.edges.length >= depth) return;
    const at = current.nodes[current.nodes.length - 1]!;
    for (const edge of graph.edges) {
      if (type !== null && edge.type !== type) continue;
      if (current.edges.includes(edge)) continue;
      const [from, to] = outgoing ? [edge.from, edge.to] : [edge.to, edge.from];
      if (from !== at || !graph.nodes.has(to)) continue;
      const next = { nodes: [...current.nodes, to], edges: [...current.edges, edge] };
      paths.push(next);
      walk(next);
    }
  };
  if (graph.nodes.has(startId)) walk({ nodes: [startId], edges: [] });
  return paths;
}

function run(rawCypher: string, params: Props = {}): FakeRecord[] {
  const cypher = rawCypher.replace(/\s+/g, ' ').trim();
  const ciInScope = tenantPredicate(cypher, params, 'ci');

  if (cypher.startsWith('CREATE INDEX')) return [];

  // Backfill: MATCH (ci:CI) [WHERE <predicate>] SET ci.organization_id = '<uuid>' RETURN count(ci) AS <alias>.
  // Only an absent WHERE (every node) or exactly `ci.organization_id IS NULL` is modelled.
  const backfill = cypher.match(/^MATCH \(ci:CI\) (?:WHERE (.+) )?SET ci\.organization_id = '([^']+)' RETURN count\(ci\) AS (\w+)$/);
  if (backfill) {
    const [, predicate, organizationId, alias] = backfill;
    if (predicate !== undefined && predicate !== 'ci.organization_id IS NULL') {
      throw new Error(`fake Neo4j: unmodelled backfill predicate: ${predicate}`);
    }
    let changed = 0;
    for (const props of graph.nodes.values()) {
      if (predicate !== undefined && props['organization_id'] !== undefined) continue;
      props['organization_id'] = organizationId;
      changed++;
    }
    return [record({ [alias!]: neo4j.int(changed) })];
  }

  if (cypher.startsWith('CREATE (ci:CI')) {
    const id = params['id'] as string;
    if (graph.nodes.has(id)) {
      throw new Error(`Node(1) already exists with label \`CI\` and property \`id\` = '${id}'`);
    }
    const now = new Date().toISOString();
    const props: Props = {
      id, external_id: params['external_id'], name: params['name'], type: params['type'],
      status: params['status'], environment: params['environment'], created_at: now, updated_at: now,
      discovered_at: params['discovered_at'], discovery_provider: params['discovery_provider'],
      metadata: params['metadata'],
      organization_id: cypher.includes('organization_id: $organizationId') ? params['organizationId'] : undefined,
    };
    // Neo4j does not store null-valued properties.
    for (const key of Object.keys(props)) if (props[key] === null || props[key] === undefined) delete props[key];
    graph.nodes.set(id, props);
    return [record({ ci: node(props) })];
  }

  if (cypher.includes('DETACH DELETE ci')) {
    const id = params['id'] as string;
    const props = graph.nodes.get(id);
    const matched = props !== undefined && ciInScope(props);
    if (matched) {
      graph.nodes.delete(id);
      graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
    }
    return cypher.includes('RETURN count(*) AS deleted') ? [record({ deleted: neo4j.int(matched ? 1 : 0) })] : [];
  }

  if (cypher.includes('SET ci += $updates')) {
    const props = graph.nodes.get(params['id'] as string);
    if (props === undefined || !ciInScope(props)) return [];
    Object.assign(props, params['updates'], { updated_at: new Date().toISOString() });
    return [record({ ci: node(props) })];
  }

  if (cypher.startsWith('CALL db.index.fulltext.queryNodes')) {
    const term = String(params['query']).toLowerCase();
    const inScope = tenantPredicate(cypher, params, 'node');
    return [...graph.nodes.values()]
      .filter(props => String(props['name']).toLowerCase().includes(term) && inScope(props))
      .slice(0, num(params['limit']))
      .map(props => record({ node: node(props), score: 1 }));
  }

  const traversal = cypher.match(/^MATCH path = \(ci:CI \{id: \$ciId\}\)(<?-)\[(?:r|:(\w+))\*1\.\.(\d+)\](->?)\((\w+):CI\)/);
  if (traversal) {
    const [, left, type, depth, , variable] = traversal;
    const pathInScope = cypher.includes('all(n IN nodes(path) WHERE n.organization_id = $organizationId)')
      ? (p: Path) => p.nodes.every(id => graph.nodes.get(id)!['organization_id'] === params['organizationId'])
      : () => true;
    const paths = expand(params['ciId'] as string, left === '-', type ?? null, Number(depth)).filter(pathInScope);
    const end = (p: Path) => node(graph.nodes.get(p.nodes[p.nodes.length - 1]!)!);

    if (variable === 'related') {
      const seen = new Set<string>();
      return paths.flatMap(p => p.edges.flatMap(edge => {
        const key = `${edge.type}|${edge.from}|${edge.to}|${p.nodes[p.nodes.length - 1]}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [record({
          type: edge.type, related: end(p), relationship: { properties: edge.properties },
          startNodeId: edge.from, endNodeId: edge.to,
        })];
      }));
    }
    if (variable === 'dep') {
      return paths.map(p => record({
        path: {
          segments: p.edges.map((edge, i) => ({
            start: node(graph.nodes.get(p.nodes[i]!)!),
            relationship: { type: edge.type, properties: edge.properties },
            end: node(graph.nodes.get(p.nodes[i + 1]!)!),
          })),
        },
      }));
    }
    // impacted: RETURN DISTINCT impacted, length(path) AS distance ORDER BY distance
    const seen = new Set<string>();
    return paths
      .sort((x, y) => x.edges.length - y.edges.length)
      .flatMap(p => {
        const key = `${p.nodes[p.nodes.length - 1]}|${p.edges.length}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [record({ impacted: end(p), distance: neo4j.int(p.edges.length) })];
      });
  }

  if (cypher.startsWith('MATCH (ci:CI {id: $id})') && cypher.endsWith('RETURN ci')) {
    const props = graph.nodes.get(params['id'] as string);
    return props !== undefined && ciInScope(props) ? [record({ ci: node(props) })] : [];
  }

  if (cypher.startsWith('MATCH (ci:CI) WHERE')) {
    const matches = [...graph.nodes.values()].filter(props =>
      ciInScope(props) &&
      ['type', 'status', 'environment'].every(f => params[f] === undefined || props[f] === params[f]) &&
      (params['search'] === undefined || String(props['name']).toLowerCase().includes(String(params['search']).toLowerCase()))
    );
    if (cypher.includes('count(ci) as total')) return [record({ total: neo4j.int(matches.length) })];
    const offset = num(params['offset']);
    return matches
      .sort((x, y) => String(x['name']).localeCompare(String(y['name'])))
      .slice(offset, offset + num(params['limit']))
      .map(props => record({ ci: node(props) }));
  }

  throw new Error(`fake Neo4j: unrecognised statement: ${cypher}`);
}

const fakeDriver = {
  session: () => ({
    // Plain functions (not jest.fn): the unit config resets mock implementations.
    run: async (cypher: string, params?: Props) => {
      queryCount++;
      return { records: run(cypher, params) };
    },
    close: async () => undefined,
  }),
  close: async () => undefined,
};

let auditHistoryReads = 0;
const auditService = {
  getCIAuditHistory: async () => {
    auditHistoryReads++;
    return [];
  },
};

// Real Neo4jClient, its driver swapped for the fake (constructing a driver opens no connection).
const neo4jClient = new Neo4jClient('bolt://127.0.0.1:1', 'unused', 'unused');
// `driver` is private: this unchecked view of the instance is the test seam that swaps it.
const driverSeam = neo4jClient as unknown as { driver: { close(): Promise<void> } };
void driverSeam.driver.close();
driverSeam.driver = fakeDriver;

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => neo4jClient,
  getPostgresClient: () => ({ pool: {} }),
  getAuditService: () => auditService,
}));

// bcrypt's native binding is only used for password hashing/login, which the
// token verification path exercised here never calls.
jest.mock('bcrypt', () => ({}));

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
};

jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { ciRoutes } from '../ci.routes';

const BACKFILL = join(__dirname, '../../../../../database/src/neo4j/migrations/001_ci_organization_backfill.cypher');
const NOT_FOUND = { success: false, error: 'Not Found', message: 'CI not found' };

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(userId, USERS[userId]!._username, 'operator', organizationId)}`,
});
const AS_A = bearer('user-a', ORG_A);
const AS_B = bearer('user-b', ORG_B);
const NO_ORG = bearer('user-none');

// Mirrors server.ts: authenticate once on /api/v1, then the router.
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);

function seedCI(id: string, organizationId: string | undefined, extra: Props = {}): void {
  const props: Props = {
    id, name: id, type: 'server', status: 'active', environment: 'production',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    discovered_at: '2026-01-01T00:00:00.000Z', metadata: '{}', ...extra,
  };
  if (organizationId !== undefined) props['organization_id'] = organizationId;
  graph.nodes.set(id, props);
}
const dependsOn = (from: string, to: string) => graph.edges.push({ type: 'DEPENDS_ON', from, to, properties: {} });

beforeEach(() => {
  graph.nodes.clear();
  graph.edges = [];
  // a-app -> a-db, b-app -> b-db, plus a legacy org-less CI.
  seedCI('ci-a-app', ORG_A);
  seedCI('ci-a-db', ORG_A, { name: 'a-database' });
  seedCI('ci-b-app', ORG_B);
  seedCI('ci-b-db', ORG_B, { name: 'b-database' });
  seedCI('ci-legacy', undefined, { name: 'legacy-database' });
  dependsOn('ci-a-app', 'ci-a-db');
  dependsOn('ci-b-app', 'ci-b-db');
  queryCount = 0;
  auditHistoryReads = 0;
});

describe('/api/v1/cis tenant scoping', () => {
  it("GET /cis lists only the caller org's CIs", async () => {
    const res = await request(app).get('/api/v1/cis').set(AS_A);
    expect(res.status).toBe(200);
    expect(res.body.data.map((ci: { id: string }) => ci.id).sort()).toEqual(['ci-a-app', 'ci-a-db']);
    expect(res.body.pagination.total).toBe(2);
  });

  it("POST /cis/search returns only the caller org's matches", async () => {
    const res = await request(app).post('/api/v1/cis/search').set(AS_A).send({ query: 'database' });
    expect(res.status).toBe(200);
    expect(res.body.data.map((hit: { ci: { id: string } }) => hit.ci.id)).toEqual(['ci-a-db']);
  });

  it('GET /cis/:id returns the same 404 for a foreign CI as for a missing one', async () => {
    const own = await request(app).get('/api/v1/cis/ci-a-app').set(AS_A);
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe('ci-a-app');

    for (const suffix of ['', '/relationships', '/dependencies', '/impact', '/audit']) {
      const foreign = await request(app).get(`/api/v1/cis/ci-b-app${suffix}`).set(AS_A);
      const missing = await request(app).get(`/api/v1/cis/ci-nope${suffix}`).set(AS_A);
      expect([foreign.status, foreign.body]).toEqual([404, NOT_FOUND]);
      expect([missing.status, missing.body]).toEqual([404, NOT_FOUND]);
    }
    // The audit log is never read for a CI outside the caller's organization.
    expect(auditHistoryReads).toBe(0);
  });

  it('POST /cis stores the token org and rejects organization_id in the body (400)', async () => {
    const body = { id: 'ci-new', name: 'new-server', type: 'server' };
    const created = await request(app).post('/api/v1/cis').set(AS_A).send(body);
    expect(created.status).toBe(201);
    expect(graph.nodes.get('ci-new')!['organization_id']).toBe(ORG_A);
    expect((await request(app).get('/api/v1/cis/ci-new').set(AS_B)).status).toBe(404);

    const smuggled = await request(app).post('/api/v1/cis').set(AS_A).send({ ...body, id: 'ci-smuggled', organization_id: ORG_B });
    expect(smuggled.status).toBe(400);
    expect(graph.nodes.has('ci-smuggled')).toBe(false);

    const moved = await request(app).put('/api/v1/cis/ci-new').set(AS_A).send({ organization_id: ORG_B });
    expect(moved.status).toBe(400);
    expect(graph.nodes.get('ci-new')!['organization_id']).toBe(ORG_A);
  });

  it('PUT and DELETE on a foreign CI are 404 and change nothing', async () => {
    const before = JSON.stringify([[...graph.nodes.entries()], graph.edges]);

    const put = await request(app).put('/api/v1/cis/ci-b-app').set(AS_A).send({ name: 'renamed-by-a' });
    expect([put.status, put.body]).toEqual([404, NOT_FOUND]);
    const del = await request(app).delete('/api/v1/cis/ci-b-app').set(AS_A);
    expect([del.status, del.body]).toEqual([404, NOT_FOUND]);

    expect(JSON.stringify([[...graph.nodes.entries()], graph.edges])).toBe(before);

    // The owner can still update and delete it.
    expect((await request(app).put('/api/v1/cis/ci-b-app').set(AS_B).send({ name: 'renamed-by-b' })).status).toBe(200);
    expect((await request(app).delete('/api/v1/cis/ci-b-app').set(AS_B)).status).toBe(204);
    expect(graph.nodes.has('ci-b-app')).toBe(false);
  });

  it("GET /cis/:id/impact excludes other orgs' nodes", async () => {
    // Cross-org edges (as unscoped writers can create them):
    //   ci-b-app -> ci-a-db           (B depends on A's db: downstream of ci-a-db)
    //   ci-a-db -> ci-b-db -> ci-a-far (upstream of ci-a-db only through a B node)
    seedCI('ci-a-far', ORG_A);
    dependsOn('ci-b-app', 'ci-a-db');
    dependsOn('ci-a-db', 'ci-b-db');
    dependsOn('ci-b-db', 'ci-a-far');

    const res = await request(app).get('/api/v1/cis/ci-a-db/impact').set(AS_A);
    expect(res.status).toBe(200);
    expect(res.body.data.downstream.map((ci: { id: string }) => ci.id)).toEqual(['ci-a-app']);
    expect(res.body.data.upstream).toEqual([]);
    expect(res.body.totalImpacted).toBe(1);
  });

  it('GET /cis/:id/dependencies and /relationships never hop through another org', async () => {
    seedCI('ci-a-far', ORG_A);
    dependsOn('ci-a-app', 'ci-b-db');
    dependsOn('ci-b-db', 'ci-a-far');

    const deps = await request(app).get('/api/v1/cis/ci-a-app/dependencies').set(AS_A);
    expect(deps.status).toBe(200);
    const depNodes = deps.body.data.flatMap((p: { segments: Array<{ end: { properties: { id: string } } }> }) =>
      p.segments.map(s => s.end.properties.id));
    expect(depNodes).toEqual(['ci-a-db']);

    const rels = await request(app).get('/api/v1/cis/ci-a-app/relationships?direction=out').set(AS_A);
    expect(rels.status).toBe(200);
    expect(rels.body.data.map((r: { target_ci_id: string }) => r.target_ci_id)).toEqual(['ci-a-db']);

    // The route's query schema only accepts `direction` (depth falls back to 1),
    // so the multi-hop case is checked on the client the controller calls.
    const deep = await neo4jClient.getRelationships('ci-a-app', ORG_A, 'out', 3);
    expect(deep.map(r => `${r._startNodeId}->${r._endNodeId}`)).toEqual(['ci-a-app->ci-a-db']);
  });

  it('403 with zero queries without an org claim', async () => {
    const routes: Array<[string, string, object | null]> = [
      ['get', '/api/v1/cis', null],
      ['post', '/api/v1/cis/search', { query: 'database' }],
      ['get', '/api/v1/cis/ci-legacy', null],
      ['post', '/api/v1/cis', { id: 'ci-x', name: 'x', type: 'server' }],
      ['put', '/api/v1/cis/ci-legacy', { name: 'y' }],
      ['delete', '/api/v1/cis/ci-legacy', null],
      ['get', '/api/v1/cis/ci-legacy/relationships', null],
      ['get', '/api/v1/cis/ci-legacy/dependencies', null],
      ['get', '/api/v1/cis/ci-legacy/impact', null],
      ['get', '/api/v1/cis/ci-legacy/audit', null],
    ];
    for (const [method, path, body] of routes) {
      const req = request(app)[method as 'get'](path).set(NO_ORG);
      const res = await (body === null ? req : req.send(body));
      expect([method, path, res.status, res.body]).toEqual([
        method, path, 403, { _error: 'Forbidden', _message: 'Organization claim required' },
      ]);
    }
    expect(queryCount).toBe(0);
    expect(auditHistoryReads).toBe(0);
    expect(graph.nodes.has('ci-legacy')).toBe(true);
  });
});

describe('backfill 001_ci_organization_backfill.cypher', () => {
  // Statements split the way cypher-shell -f reads them: on ';', comment lines dropped.
  const statements = () => readFileSync(BACKFILL, 'utf8')
    .split(';')
    .map(s => s.split('\n').filter(line => !line.trim().startsWith('//')).join('\n').trim())
    .filter(s => s.length > 0);
  const backfill = () => statements().flatMap(s => run(s)).map(r => num(r.get('backfilled')));
  const orgs = () => Object.fromEntries([...graph.nodes].map(([id, props]) => [id, props['organization_id']]));

  it('assigns org-less CIs to the internal org; nodes that already have an org are untouched', () => {
    expect(backfill()).toEqual([1]);
    expect(orgs()).toEqual({
      'ci-a-app': ORG_A, 'ci-a-db': ORG_A, 'ci-b-app': ORG_B, 'ci-b-db': ORG_B, 'ci-legacy': INTERNAL_ORG,
    });
  });

  it('second run changes nothing', () => {
    backfill();
    const after = JSON.stringify([...graph.nodes]);
    expect(backfill()).toEqual([0]);
    expect(JSON.stringify([...graph.nodes])).toBe(after);
  });
});

describe('infrastructure/scripts/init-neo4j.cypher sample data (scripts/db-init.sh)', () => {
  const INIT_SCRIPT = join(__dirname, '../../../../../../infrastructure/scripts/init-neo4j.cypher');

  /** Statements as cypher-shell reads them: comment lines dropped, split on ';' outside '…' literals. */
  function statements(): string[] {
    const script = readFileSync(INIT_SCRIPT, 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    const out: string[] = [];
    let current = '';
    let inString = false;
    for (let i = 0; i < script.length; i++) {
      const ch = script[i]!;
      if (ch === "'" && script[i - 1] !== '\\') inString = !inString;
      if (ch === ';' && !inString) {
        out.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current.trim());
    return out.filter(s => s.length > 0);
  }

  it("puts every seeded :CI in the seeded admin's (internal) organization and assigns no other CI", () => {
    const all = statements();
    const admin = all.find(s => s.startsWith("MERGE (u:User {email: 'admin@happycmdb.local'})"));
    expect(admin).toContain(`u.organizationId = '${INTERNAL_ORG}'`);

    // Any MERGE/CREATE of a node pattern whose labels include CI, wherever it sits in the statement.
    const ciVariable = (s: string): string | null => {
      for (const m of s.matchAll(/\b(?:MERGE|CREATE)\s*\((\w+)((?::\w+)+)/g)) {
        if (m[2]!.split(':').includes('CI')) return m[1]!;
      }
      return null;
    };
    const seeded = all.flatMap(s => {
      const variable = ciVariable(s);
      return variable === null ? [] : [{ variable, statement: s }];
    });
    expect(seeded).toHaveLength(32);

    // Each seed assigns the org exactly once, in its unconditional SET (not ON CREATE/ON MATCH,
    // which would leave pre-tenancy sample CIs without an org on a re-run), and nothing else.
    const badSeeds = seeded
      .filter(({ variable, statement }) =>
        /\bON (CREATE|MATCH)\b/.test(statement) ||
        (statement.match(/organization_id/g) ?? []).length !== 1 ||
        !new RegExp(`^\\s*${variable}\\.organization_id = '${INTERNAL_ORG}',?$`, 'm').test(statement))
      .map(({ statement }) => statement.split('\n')[0]);
    expect(badSeeds).toEqual([]);

    // Apart from the index, no other statement touches organization_id: a re-run of
    // db-init must not claim CIs written by discovery, connectors, ETL or the API.
    const otherWriters = all
      .filter(s => s.includes('organization_id') && !seeded.some(({ statement }) => statement === s))
      .filter(s => !/^CREATE INDEX ci_organization_id_idx IF NOT EXISTS\s+FOR \(ci:CI\) ON \(ci\.organization_id\)$/.test(s))
      .map(s => s.split('\n')[0]);
    expect(otherWriters).toEqual([]);
  });
});

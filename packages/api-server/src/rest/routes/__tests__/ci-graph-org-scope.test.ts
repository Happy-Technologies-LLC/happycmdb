// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for /api/v1/relationships, /search, /analytics, /drift and
 * /impact, exercised through the real routers, controllers and ai-ml-engine
 * engines behind the real AuthMiddleware/AuthService (JWT verification),
 * mounted at their production paths, with the real Neo4jClient issuing its
 * Cypher.
 *
 * Neo4j is replaced by an in-memory graph behind a fake driver session (as in
 * ci-org-scope.test.ts). It recognises the statements these routes issue and
 * evaluates them over the graph honouring exactly the tenant predicates the
 * statement contains: a statement without `x.organization_id = $organizationId`,
 * the path-wide `all(n IN nodes(path) WHERE n.organization_id = $organizationId)`
 * or the neighbour predicate matches every organization's nodes, as Neo4j would.
 *
 * PostgreSQL (analytics facts, change history, anomalies and the engines'
 * history tables) runs on PGlite hosted in a forked child process
 * (fixtures/pglite-host.cjs), with each table's DDL read verbatim from
 * 001_complete_schema.sql.
 */

import { fork } from 'child_process';
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

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// PostgreSQL: PGlite in a child process
// ---------------------------------------------------------------------------

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise;
}

let pgQueries = 0;
// Plain functions (not jest.fn): the unit config resets mock implementations.
const pgClient = {
  query: async (sql: string, params: unknown[] = []) => {
    pgQueries++;
    return { rows: await send('query', sql, params) };
  },
};

// ---------------------------------------------------------------------------
// In-memory graph and fake driver
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
interface GraphNode { labels: string[]; props: Props }
interface Edge { type: string; from: string; to: string; properties: Props }
const graph = { nodes: new Map<string, GraphNode>(), edges: [] as Edge[] };
const cypherRuns: Array<{ cypher: string; params: Props }> = [];

interface FakeRecord { keys: string[]; get(key: string): unknown }
const record = (row: Record<string, unknown>): FakeRecord => ({ keys: Object.keys(row), get: (key: string) => row[key] });
const int = (value: number) => neo4j.int(value);
const num = (value: unknown): number => (neo4j.isInt(value) ? value.toNumber() : Number(value));
const isCI = (n: GraphNode | undefined): n is GraphNode => n !== undefined && n.labels.includes('CI');
const nodeValue = (n: GraphNode) => ({ labels: n.labels, properties: n.props });
const byName = (x: GraphNode, y: GraphNode) => String(x.props['name']).localeCompare(String(y.props['name']));

const PATH_SCOPE = 'all(n IN nodes(path) WHERE n.organization_id = $organizationId)';

interface Path { nodes: string[]; edges: Edge[] }

/** Variable-length expansion with relationship uniqueness, like Cypher's `-[*min..max]-`. */
function expand(start: string, direction: 'in' | 'out' | 'both', min: number, max: number, types: string[] | null): Path[] {
  const paths: Path[] = [];
  const walk = (path: Path) => {
    if (path.edges.length >= min) paths.push(path);
    if (path.edges.length >= max) return;
    const at = path.nodes[path.nodes.length - 1]!;
    for (const edge of graph.edges) {
      if ((types !== null && !types.includes(edge.type)) || path.edges.includes(edge)) continue;
      let next: string | null = null;
      if (direction !== 'in' && edge.from === at) next = edge.to;
      else if (direction !== 'out' && edge.to === at) next = edge.from;
      if (next !== null) walk({ nodes: [...path.nodes, next], edges: [...path.edges, edge] });
    }
  };
  if (isCI(graph.nodes.get(start))) walk({ nodes: [start], edges: [] });
  return paths.filter(p => isCI(graph.nodes.get(p.nodes[p.nodes.length - 1]!)));
}

function run(rawCypher: string, params: Props): FakeRecord[] {
  const cypher = rawCypher.replace(/\s+/g, ' ').trim();
  const has = (fragment: string) => cypher.includes(fragment);
  const org = params['organizationId'];
  // Each predicate only applies when the statement contains it.
  const inOrg = (variable: string) => (n: GraphNode) =>
    !has(`${variable}.organization_id = $organizationId`) || n.props['organization_id'] === org;
  const neighbourOk = (variable: string) => (n: GraphNode) =>
    !has(`CASE WHEN ${variable}:CI`) ||
    (isCI(n) ? n.props['organization_id'] === org : (n.props['organization_id'] ?? org) === org);
  const pathOk = (p: Path) => !has(PATH_SCOPE) || p.nodes.every(id => graph.nodes.get(id)!.props['organization_id'] === org);
  const node = (id: string) => graph.nodes.get(id)!;
  const cis = () => [...graph.nodes.values()].filter(isCI);
  const page = <T>(rows: T[]) => rows.slice(num(params['offset'] ?? 0), num(params['offset'] ?? 0) + num(params['limit']));

  // Neo4jClient.listCIIds and organizationCIIdsAmong
  if (/^MATCH \(ci:CI\) WHERE .* RETURN ci\.id AS id$/.test(cypher)) {
    const among = has('ci.id IN $ids') ? (params['ids'] as string[]) : null;
    return cis().filter(n => inOrg('ci')(n) && (among === null || among.includes(n.props['id'] as string)))
      .map(n => record({ id: n.props['id'] }));
  }

  // GET /analytics/dashboard
  if (has('total_cis')) {
    const matched = cis().filter(inOrg('ci'));
    return [record({
      total_cis: int(matched.length),
      unique_types: int(new Set(matched.map(n => n.props['type'])).size),
      unique_environments: int(new Set(matched.map(n => n.props['environment'])).size),
    })];
  }
  if (has('total_relationships')) {
    const counted = graph.edges.filter(e => !has('(from:CI)') ||
      (isCI(graph.nodes.get(e.from)) && isCI(graph.nodes.get(e.to)) && inOrg('from')(node(e.from)) && inOrg('to')(node(e.to))));
    return [record({ total_relationships: int(counted.length) })];
  }
  const grouped = cypher.match(/RETURN ci\.(type|status|environment) as (\w+), COUNT\(ci\) as count/);
  if (grouped) {
    const [, property, alias] = grouped;
    const counts = new Map<unknown, number>();
    for (const n of cis().filter(inOrg('ci'))) {
      if (n.props[property!] === undefined) continue;
      counts.set(n.props[property!], (counts.get(n.props[property!]) ?? 0) + 1);
    }
    return [...counts].map(([value, count]) => record({ [alias!]: value, count: int(count) }));
  }
  if (has("ci.metadata CONTAINS 'discovery_provider'")) {
    return cis()
      .filter(n => inOrg('ci')(n) && String(n.props['metadata']).includes('discovery_provider'))
      .map(n => record({ ci: { ...n.props, last_discovered: null } }));
  }

  // Neo4jClient.createRelationship: MATCH (from) MATCH (to) [WHERE ...] MERGE ... RETURN count(r) AS created
  const merge = cypher.match(/MERGE \(from\)-\[r:(\w+)\]->\(to\)/);
  if (merge) {
    const from = graph.nodes.get(params['fromId'] as string);
    const to = graph.nodes.get(params['toId'] as string);
    if (!isCI(from) || !isCI(to) || !inOrg('from')(from) || !inOrg('to')(to)) return [record({ created: int(0) })];
    if (!graph.edges.some(e => e.type === merge[1] && e.from === from.props['id'] && e.to === to.props['id'])) {
      graph.edges.push({ type: merge[1]!, from: from.props['id'] as string, to: to.props['id'] as string, properties: {} });
    }
    return [record({ created: int(1) })];
  }

  // DELETE /relationships: existence check and delete
  const byEndpoints = cypher.match(/^MATCH \(from:CI \{id: \$from_id\}\)-\[r:(\w+)\]->\(to:CI \{id: \$to_id\}\)/);
  if (byEndpoints) {
    const matched = graph.edges.filter(e =>
      e.type === byEndpoints[1] && e.from === params['from_id'] && e.to === params['to_id'] &&
      isCI(graph.nodes.get(e.from)) && isCI(graph.nodes.get(e.to)) && inOrg('from')(node(e.from)) && inOrg('to')(node(e.to)));
    if (has('DELETE r')) {
      graph.edges = graph.edges.filter(e => !matched.includes(e));
      return [];
    }
    return matched.map(e => record({ r: { type: e.type, properties: e.properties } }));
  }

  // GET /relationships and /relationships/type/:type
  const relationshipList = cypher.match(/^MATCH \(from:CI\)-\[r(?::(\w+))?\]->\(to:CI\)/);
  if (relationshipList) {
    const type = relationshipList[1] ?? (has('type(r) = $type') ? params['type'] : undefined);
    const matched = graph.edges.filter(e => {
      const from = graph.nodes.get(e.from);
      const to = graph.nodes.get(e.to);
      return isCI(from) && isCI(to) && inOrg('from')(from) && inOrg('to')(to) &&
        (type === undefined || e.type === type) &&
        (params['from_id'] === undefined || e.from === params['from_id']) &&
        (params['to_id'] === undefined || e.to === params['to_id']) &&
        (params['ci_id'] === undefined || e.from === params['ci_id'] || e.to === params['ci_id']);
    });
    if (has('RETURN count(r) as total')) return [record({ total: int(matched.length) })];
    return page(matched.sort((x, y) => byName(node(x.from), node(y.from)) || byName(node(x.to), node(y.to))))
      .map(e => record({ from: nodeValue(node(e.from)), r: { type: e.type, properties: e.properties }, to: nodeValue(node(e.to)) }));
  }

  // POST /search/relationships
  const pattern = cypher.match(/^MATCH \(ci:CI \{type: \$ci_type\}\)-\[:(\w+)\]->\(related:CI \{type: \$related_ci_type\}\)/);
  if (pattern) {
    const matched = new Map<string, GraphNode>();
    for (const e of graph.edges) {
      const from = graph.nodes.get(e.from);
      const to = graph.nodes.get(e.to);
      if (e.type === pattern[1] && isCI(from) && isCI(to) && from.props['type'] === params['ci_type'] &&
          to.props['type'] === params['related_ci_type'] && inOrg('ci')(from) && inOrg('related')(to)) {
        matched.set(e.from, from);
      }
    }
    return [...matched.values()].sort(byName).slice(0, num(params['limit'])).map(n => record({ ci: nodeValue(n) }));
  }

  // POST /search/fulltext
  if (cypher.startsWith('CALL db.index.fulltext.queryNodes')) {
    const term = String(params['query']).toLowerCase();
    return cis()
      .filter(n => String(n.props['name']).toLowerCase().includes(term) && inOrg('node')(n))
      .slice(0, num(params['limit']))
      .map(n => record({ node: nodeValue(n), score: 1 }));
  }

  // GET /search/orphaned (current form, and the unscoped `NOT (ci)-[]-()`)
  if (has('NOT EXISTS { MATCH (ci)--(other)') || has('NOT (ci)-[]-()')) {
    const visible = neighbourOk('other');
    const orphaned = cis().filter(n => inOrg('ci')(n) && !graph.edges.some(e =>
      (e.from === n.props['id'] && visible(node(e.to))) || (e.to === n.props['id'] && visible(node(e.from)))));
    if (has('RETURN count(ci) as total')) return [record({ total: int(orphaned.length) })];
    return page(orphaned).map(n => record({ ci: nodeValue(n) }));
  }

  // POST /search/advanced
  if (cypher.startsWith('MATCH (ci:CI) WHERE') && has('CONTAINS $query')) {
    const query = String(params['query']);
    const matched = cis().filter(n => inOrg('ci')(n) &&
      (String(n.props['name']).includes(query) || String(n.props['external_id'] ?? '').includes(query)) &&
      ['type', 'status', 'environment'].every(f => params[f] === undefined || n.props[f] === params[f]));
    if (has('count(ci) as total')) return [record({ total: int(matched.length) })];
    return page(matched.sort(byName)).map(n => record({ ci: nodeValue(n) }));
  }

  // Neo4jClient.getCI
  if (cypher.startsWith('MATCH (ci:CI {id: $id})') && cypher.endsWith('RETURN ci')) {
    const n = graph.nodes.get(params['id'] as string);
    return isCI(n) && inOrg('ci')(n) ? [record({ ci: nodeValue(n) })] : [];
  }

  // Engines: CI keyed by $ciId
  if (cypher.startsWith('MATCH (ci:CI {id: $ciId})')) {
    const id = params['ciId'] as string;
    const n = graph.nodes.get(id);
    if (!isCI(n) || !inOrg('ci')(n)) return [];
    if (has('-[r]-(related:CI)')) {
      // Drift relationships snapshot
      return graph.edges.flatMap(e => {
        const otherId = e.from === id ? e.to : e.to === id ? e.from : null;
        const other = otherId === null ? undefined : graph.nodes.get(otherId);
        return isCI(other) && inOrg('related')(other)
          ? [record({ rel_type: e.type, related_id: otherId, related_name: other.props['name'], is_outgoing: e.from === id })]
          : [];
      });
    }
    if (has('OPTIONAL MATCH (ci)<-[incoming]-(dependent)')) {
      // Criticality factors
      const incoming = graph.edges.filter(e => e.to === id && neighbourOk('dependent')(node(e.from)));
      const outgoing = graph.edges.filter(e => e.from === id && neighbourOk('dependency')(node(e.to)));
      return [record({
        ci_id: id, ci_name: n.props['name'],
        dependent_count: int(incoming.length), dependency_count: int(outgoing.length),
        dependent_ids: [...new Set(incoming.map(e => e.from))],
      })];
    }
    if (has('RETURN ci.id as id')) return [record({ id, name: n.props['name'], ci_type: n.props['ci_type'] })];
    if (cypher.endsWith('RETURN ci')) return [record({ ci: nodeValue(n) })];
  }

  // Engines: variable-length paths from a CI
  const traversal = cypher.match(/^MATCH path = \(\w+:CI \{id: \$(\w+)\}\)(<?-)\[\*(\d+)\.\.(\d+)\](->?)\(\w+:CI\)/);
  if (traversal) {
    const [, startParam, left, min, max, right] = traversal;
    const direction = left === '<-' ? 'in' : right === '->' ? 'out' : 'both';
    const typeList = cypher.match(/type\(r\) IN \[([^\]]+)\]/);
    const singleType = cypher.match(/type\(r\) = '(\w+)'/);
    const types = typeList ? typeList[1]!.split(',').map(t => t.trim().replace(/'/g, '')) : singleType ? [singleType[1]!] : null;
    const paths = expand(params[startParam!] as string, direction, Number(min), Number(max), types).filter(pathOk);

    if (has('hop_count')) {
      return paths
        .sort((x, y) => x.edges.length - y.edges.length)
        .slice(0, 200)
        .map(p => {
          const end = node(p.nodes[p.nodes.length - 1]!);
          return record({
            ci_id: end.props['id'], ci_name: end.props['name'], ci_type: end.props['ci_type'],
            hop_count: int(p.edges.length), path_ids: p.nodes,
          });
        });
    }
    if (has('critical_path')) {
      const longest = paths.sort((x, y) => y.edges.length - x.edges.length)[0];
      return longest ? [record({ critical_path: longest.nodes })] : [];
    }
    if (has('UNWIND path_nodes')) {
      const ids = [...new Set(paths.flatMap(p => p.nodes))];
      return ids.map(id => {
        const outgoing = graph.edges.filter(e =>
          (e.from === id && neighbourOk('outgoing_node')(node(e.to))) || (e.to === id && neighbourOk('outgoing_node')(node(e.from))));
        const incoming = graph.edges.filter(e => e.to === id && neighbourOk('incoming_node')(node(e.from)));
        return record({
          id, name: node(id).props['name'], ci_type: node(id).props['ci_type'],
          dependents_count: int(incoming.length), dependencies_count: int(outgoing.length),
        });
      });
    }
    if (has('UNWIND path_rels')) {
      return [...new Set(paths.flatMap(p => p.edges))].map(e => record({ source_id: e.from, target_id: e.to, rel_type: e.type }));
    }
  }

  throw new Error(`fake Neo4j: unrecognised statement: ${cypher}`);
}

const fakeDriver = {
  session: () => ({
    run: async (cypher: string, params: Props = {}) => {
      cypherRuns.push({ cypher, params });
      return { records: run(cypher, params) };
    },
    close: async () => undefined,
  }),
  close: async () => undefined,
};

// Real Neo4jClient, its driver swapped for the fake (constructing a driver opens no connection).
const neo4jClient = new Neo4jClient('bolt://127.0.0.1:1', 'unused', 'unused');
// `driver` is private: this unchecked view of the instance is the test seam that swaps it.
const driverSeam = neo4jClient as unknown as { driver: { close(): Promise<void> } };
void driverSeam.driver.close();
driverSeam.driver = fakeDriver;

jest.mock('@cmdb/database', () => {
  const client = jest.requireActual('../../../../../database/src/neo4j/client');
  return {
    getNeo4jClient: () => neo4jClient,
    getPostgresClient: () => pgClient,
    UNSCOPED_CI_ACCESS: client.UNSCOPED_CI_ACCESS,
    organizationIdParam: client.organizationIdParam,
    neighbourScopePredicate: client.neighbourScopePredicate,
  };
});

// The drift detector emits Kafka events on significant drift; no broker here.
jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: () => ({ emit: async () => undefined }),
  createEventConsumer: () => ({}),
  EventType: { RECONCILIATION_CONFLICT: 'reconciliation.conflict' },
  KAFKA_TOPICS: {},
  CONSUMER_GROUPS: {},
}));

// bcrypt's native binding is only used for password hashing/login, never on token verification.
jest.mock('bcrypt', () => ({}));

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: ORG_A },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'admin', _enabled: true, _organizationId: ORG_B },
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
import { relationshipRoutes } from '../relationship.routes';
import { searchRoutes } from '../search.routes';
import { analyticsRoutes } from '../analytics.routes';
import { driftRoutes, impactRoutes } from '../drift-impact.routes';

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(userId, USERS[userId]!._username, 'admin', organizationId)}`,
});
const AS_A = bearer('user-a', ORG_A);
const AS_B = bearer('user-b', ORG_B);
const NO_ORG = bearer('user-none');
const FORBIDDEN = { _error: 'Forbidden', _message: 'Organization claim required' };

// Mirrors server.ts: authenticate once on /api/v1, then each router at its production path.
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/relationships', relationshipRoutes);
app.use('/api/v1/search', searchRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/drift', driftRoutes);
app.use('/api/v1/impact', impactRoutes);

// ---------------------------------------------------------------------------
// Fixture: two organizations plus an org-less legacy CI
// ---------------------------------------------------------------------------
//   a-web -DEPENDS_ON-> a-db <-DEPENDS_ON- b-web -DEPENDS_ON-> b-db <-DEPENDS_ON- a-lonely <-RUNS_ON- bs-b
//   a-solo, b-solo: no relationships. bs-b is org B's :BusinessService.
// The two cross-organization edges are what unscoped writers could create.

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const DDL_TABLES = [
  'cmdb.dim_ci', 'cmdb.fact_discovery', 'cmdb.fact_ci_relationships', 'ci_change_history', 'anomalies',
  'impact_analyses', 'ci_criticality_scores', 'baseline_snapshots', 'drift_detection_results', 'metrics_timeseries',
];
const A_BASELINE = 'aaaaaaaa-0000-4000-8000-000000000001';
const B_BASELINE = 'bbbbbbbb-0000-4000-8000-000000000001';

function ddl(): string {
  const sql = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  return 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + DDL_TABLES.map(table => {
    const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  }).join('\n');
}

const SEED = `
INSERT INTO cmdb.dim_ci (ci_key, ci_id, ci_name, ci_type, ci_status, environment) VALUES
  (1, 'a-web', 'shop-web', 'application', 'active', 'production'),
  (2, 'a-db', 'shop-db', 'database', 'active', 'production'),
  (3, 'a-lonely', 'a-lonely', 'server', 'active', 'staging'),
  (4, 'a-solo', 'a-solo', 'server', 'active', 'development'),
  (5, 'b-web', 'shop-web-b', 'application', 'maintenance', 'production'),
  (6, 'b-db', 'shop-db-b', 'database', 'maintenance', 'production'),
  (7, 'b-solo', 'b-solo', 'container', 'inactive', 'test');
INSERT INTO cmdb.fact_ci_relationships (from_ci_key, to_ci_key, date_key, relationship_type, discovered_at) VALUES
  (1, 2, 20260101, 'DEPENDS_ON', '2026-01-01'),
  (5, 6, 20260101, 'DEPENDS_ON', '2026-01-01'),
  (5, 2, 20260101, 'DEPENDS_ON', '2026-01-01'),
  (3, 6, 20260101, 'DEPENDS_ON', '2026-01-01'),
  (6, 7, 20260101, 'HOSTS', '2026-01-01');
INSERT INTO cmdb.fact_discovery (ci_key, date_key, discovered_at, discovery_job_id, discovery_provider, discovery_method) VALUES
  (1, 20260101, '2026-01-01', 'job-a', 'aws', 'api'),
  (2, 20260101, '2026-01-01', 'job-a', 'aws', 'api'),
  (5, 20260101, '2026-01-01', 'job-b', 'azure', 'api'),
  (6, 20260101, '2026-01-01', 'job-b', 'azure', 'api'),
  (7, 20260101, '2026-01-01', 'job-b', 'gcp', 'api');
INSERT INTO ci_change_history (ci_id, change_type, change_source, changed_at) VALUES
  ('a-db', 'updated', 'test', NOW() - INTERVAL '1 day'),
  ('b-db', 'updated', 'test', NOW() - INTERVAL '1 day'),
  ('b-db', 'updated', 'test', NOW() - INTERVAL '1 day'),
  ('b-web', 'discovered', 'test', NOW() - INTERVAL '1 day');
INSERT INTO anomalies (id, ci_id, anomaly_type, severity, detected_at, metrics) VALUES
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'a-db', 'cpu', 'low', NOW() - INTERVAL '1 day', '{"cpu_usage": 10}'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'b-db', 'cpu', 'high', NOW() - INTERVAL '1 day', '{"cpu_usage": 99}');
INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved) VALUES
  ('${A_BASELINE}', 'a-db', 'configuration', '{"name": "shop-db"}', NOW() - INTERVAL '2 days', 'alice', true),
  ('${B_BASELINE}', 'b-db', 'configuration', '{"name": "shop-db-b"}', NOW() - INTERVAL '2 days', 'bob', false);
INSERT INTO drift_detection_results (ci_id, ci_name, has_drift, drift_score, drifted_fields, detected_at) VALUES
  ('b-db', 'shop-db-b', true, 40, '[]', NOW() - INTERVAL '1 day');
INSERT INTO impact_analyses (id, source_ci_id, source_ci_name, change_type, impact_score, risk_level, analyzed_at, affected_cis) VALUES
  ('bbbbbbbb-0000-4000-8000-0000000000c1', 'b-db', 'shop-db-b', 'restart', 10, 'low', NOW() - INTERVAL '1 day', '[]');`;

function seedNode(id: string, labels: string[], organizationId: string | undefined, extra: Props = {}): void {
  const props: Props = {
    id, name: id, type: 'server', status: 'active', environment: 'production',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    discovered_at: '2026-01-01T00:00:00.000Z', metadata: '{}', ...extra,
  };
  if (organizationId !== undefined) props['organization_id'] = organizationId;
  graph.nodes.set(id, { labels, props });
}
const link = (from: string, type: string, to: string) => graph.edges.push({ type, from, to, properties: {} });
const DISCOVERED = '{"discovery_provider":"aws"}';

beforeAll(async () => {
  await send('exec', ddl());
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  graph.nodes.clear();
  graph.edges = [];
  seedNode('a-web', ['CI'], ORG_A, { name: 'shop-web', type: 'application', metadata: DISCOVERED });
  seedNode('a-db', ['CI'], ORG_A, { name: 'shop-db', type: 'database' });
  seedNode('a-lonely', ['CI'], ORG_A, { name: 'a-lonely', environment: 'staging' });
  seedNode('a-solo', ['CI'], ORG_A, { name: 'a-solo', environment: 'development' });
  seedNode('b-web', ['CI'], ORG_B, { name: 'shop-web-b', type: 'application', status: 'maintenance', metadata: DISCOVERED });
  seedNode('b-db', ['CI'], ORG_B, { name: 'shop-db-b', type: 'database', status: 'maintenance' });
  seedNode('b-solo', ['CI'], ORG_B, { name: 'b-solo', type: 'container', environment: 'test' });
  seedNode('legacy', ['CI'], undefined, { name: 'shop-legacy' });
  seedNode('bs-b', ['BusinessService'], ORG_B, { name: 'b-service' });
  link('a-web', 'DEPENDS_ON', 'a-db');
  link('b-web', 'DEPENDS_ON', 'b-db');
  link('b-web', 'DEPENDS_ON', 'a-db');
  link('a-lonely', 'DEPENDS_ON', 'b-db');
  link('bs-b', 'RUNS_ON', 'a-lonely');

  await send('exec', `TRUNCATE ${DDL_TABLES.join(', ')} RESTART IDENTITY;${SEED}`);
  pgQueries = 0;
  cypherRuns.length = 0;
});

const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();
const edgeKeys = () => graph.edges.map(e => `${e.from}-${e.type}->${e.to}`).sort();
const ciNotFound = (id: string) => ({ success: false, error: 'Not Found', message: `CI with ID '${id}' not found` });
const ANALYTICS_NOT_FOUND = { success: false, error: 'Not Found', message: 'CI not found' };

// Every route under test, with org A inputs. `[method, path, body]`.
const ROUTES: Array<[string, string, object | undefined]> = [
  ['get', '/api/v1/relationships', undefined],
  ['get', '/api/v1/relationships?ci_id=a-db', undefined],
  ['post', '/api/v1/relationships', { from_id: 'a-web', to_id: 'a-solo', type: 'USES' }],
  ['delete', '/api/v1/relationships?from_id=a-web&to_id=a-db&type=DEPENDS_ON', undefined],
  ['get', '/api/v1/relationships/type/DEPENDS_ON', undefined],
  ['post', '/api/v1/search/advanced', { query: 'shop' }],
  ['post', '/api/v1/search/fulltext', { query: 'shop' }],
  ['post', '/api/v1/search/relationships', { ci_type: 'application', relationship_type: 'DEPENDS_ON', related_ci_type: 'database' }],
  ['get', '/api/v1/search/orphaned', undefined],
  ['get', '/api/v1/analytics/dashboard', undefined],
  ['get', '/api/v1/analytics/ci-counts', undefined],
  ['get', '/api/v1/analytics/ci-status', undefined],
  ['get', '/api/v1/analytics/ci-environments', undefined],
  ['get', '/api/v1/analytics/relationship-counts', undefined],
  ['get', '/api/v1/analytics/discovery-stats', undefined],
  ['get', '/api/v1/analytics/discovery-timeline', undefined],
  ['get', '/api/v1/analytics/top-connected', undefined],
  ['get', '/api/v1/analytics/dependency-depth', undefined],
  ['get', '/api/v1/analytics/change-history?ci_id=a-db', undefined],
  ['get', '/api/v1/analytics/relationship-matrix', undefined],
  ['get', '/api/v1/analytics/change-timeline', undefined],
  ['get', '/api/v1/analytics/health-metrics/a-db', undefined],
  ['post', '/api/v1/drift/detect/a-db', undefined],
  ['get', '/api/v1/drift/history/a-db', undefined],
  ['post', '/api/v1/drift/baseline', { ci_id: 'a-lonely', snapshot_type: 'relationships' }],
  ['post', `/api/v1/drift/baseline/${A_BASELINE}/approve`, undefined],
  ['get', '/api/v1/drift/baseline/a-db', undefined],
  ['post', '/api/v1/impact/predict', { ci_id: 'a-db', change_type: 'restart' }],
  ['get', '/api/v1/impact/graph/a-db', undefined],
  ['get', '/api/v1/impact/criticality/a-db', undefined],
  ['get', '/api/v1/impact/history/a-db', undefined],
];

function call(method: string, path: string, body: object | undefined, auth: Record<string, string>) {
  const req = request(app)[method as 'get'](path).set(auth);
  return body === undefined ? req : req.send(body);
}

describe('/api/v1/relationships tenant scoping', () => {
  it('POST /relationships between orgs is 404 and creates nothing', async () => {
    const before = edgeKeys();
    for (const [from, to] of [['a-web', 'b-solo'], ['b-solo', 'a-web'], ['a-web', 'legacy']]) {
      const res = await request(app).post('/api/v1/relationships').set(AS_A).send({ from_id: from, to_id: to, type: 'USES' });
      expect(res.status).toBe(404);
    }
    // A foreign endpoint reads exactly like a missing one.
    const foreign = await request(app).post('/api/v1/relationships').set(AS_A).send({ from_id: 'b-solo', to_id: 'a-web', type: 'USES' });
    const missing = await request(app).post('/api/v1/relationships').set(AS_A).send({ from_id: 'nope', to_id: 'a-web', type: 'USES' });
    expect(foreign.body.message.replace('b-solo', 'X')).toBe(missing.body.message.replace('nope', 'X'));
    expect(edgeKeys()).toEqual(before);

    const own = await request(app).post('/api/v1/relationships').set(AS_A).send({ from_id: 'a-web', to_id: 'a-solo', type: 'USES' });
    expect(own.status).toBe(201);
    expect(edgeKeys()).toContain('a-web-USES->a-solo');
  });

  it('DELETE /relationships touching another org is 404 and deletes nothing', async () => {
    const before = edgeKeys();
    for (const [auth, from, to] of [[AS_A, 'a-lonely', 'b-db'], [AS_A, 'b-web', 'a-db'], [AS_B, 'b-web', 'a-db'], [AS_B, 'a-web', 'a-db']] as const) {
      const res = await request(app).delete(`/api/v1/relationships?from_id=${from}&to_id=${to}&type=DEPENDS_ON`).set(auth);
      expect([res.status, res.body.message]).toEqual([404, 'Relationship not found']);
    }
    expect(edgeKeys()).toEqual(before);

    const own = await request(app).delete('/api/v1/relationships?from_id=a-web&to_id=a-db&type=DEPENDS_ON').set(AS_A);
    expect(own.status).toBe(200);
    expect(edgeKeys()).not.toContain('a-web-DEPENDS_ON->a-db');
  });

  it("GET /relationships and /relationships/type/:type list only relationships between the caller org's CIs", async () => {
    for (const path of ['/api/v1/relationships', '/api/v1/relationships?ci_id=a-db', '/api/v1/relationships/type/DEPENDS_ON']) {
      const res = await request(app).get(path).set(AS_A);
      expect(res.status).toBe(200);
      expect(res.body.data.map((r: { from_id: string; to_id: string }) => `${r.from_id}->${r.to_id}`)).toEqual(['a-web->a-db']);
      expect(res.body.pagination.total).toBe(1);
    }
  });
});

describe('/api/v1/search tenant scoping', () => {
  it("advanced and fulltext search return only the caller org's CIs", async () => {
    const advanced = await request(app).post('/api/v1/search/advanced').set(AS_A).send({ query: 'shop' });
    expect(advanced.status).toBe(200);
    expect(ids(advanced.body.data)).toEqual(['a-db', 'a-web']);
    expect(advanced.body.pagination.total).toBe(2);

    const fulltext = await request(app).post('/api/v1/search/fulltext').set(AS_A).send({ query: 'shop' });
    expect(fulltext.status).toBe(200);
    expect(fulltext.body.data.map((hit: { ci: { id: string } }) => hit.ci.id).sort()).toEqual(['a-db', 'a-web']);
    expect(fulltext.body.count).toBe(2);
  });

  it('relationship pattern search needs both ends in the caller org', async () => {
    const res = await request(app).post('/api/v1/search/relationships').set(AS_A)
      .send({ ci_type: 'application', relationship_type: 'DEPENDS_ON', related_ci_type: 'database' });
    expect(res.status).toBe(200);
    expect(ids(res.body.data)).toEqual(['a-web']);

    // a-lonely (org A server) DEPENDS_ON b-db (org B database): the far end must be in the org too.
    const crossOrg = await request(app).post('/api/v1/search/relationships').set(AS_A)
      .send({ ci_type: 'server', relationship_type: 'DEPENDS_ON', related_ci_type: 'database' });
    expect([crossOrg.status, crossOrg.body.data]).toEqual([200, []]);
  });

  it('GET /search/orphaned ignores other orgs', async () => {
    const res = await request(app).get('/api/v1/search/orphaned').set(AS_A);
    expect(res.status).toBe(200);
    // a-lonely's only links are to org B's CI and org B's service.
    expect(ids(res.body.data)).toEqual(['a-lonely', 'a-solo']);
    expect(res.body.pagination.total).toBe(2);

    const asB = await request(app).get('/api/v1/search/orphaned').set(AS_B);
    expect(ids(asB.body.data)).toEqual(['b-solo']);
  });
});

describe('/api/v1/analytics tenant scoping', () => {
  it('analytics ci-counts counts only the caller org', async () => {
    const counts = async (path: string, key: string) => {
      const res = await request(app).get(path).set(AS_A);
      expect(res.status).toBe(200);
      return Object.fromEntries(res.body.data.map((row: Record<string, unknown>) => [row[key], Number(row['count'])]));
    };
    expect(await counts('/api/v1/analytics/ci-counts', 'ci_type')).toEqual({ application: 1, database: 1, server: 2 });
    expect(await counts('/api/v1/analytics/ci-status', 'status')).toEqual({ active: 4 });
    expect(await counts('/api/v1/analytics/ci-environments', 'environment'))
      .toEqual({ production: 2, staging: 1, development: 1 });
    // Only a-web -> a-db has both endpoints in org A.
    expect(await counts('/api/v1/analytics/relationship-counts', 'relationship_type')).toEqual({ DEPENDS_ON: 1 });
  });

  it('dashboard counts only the caller org', async () => {
    const res = await request(app).get('/api/v1/analytics/dashboard').set(AS_A);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total_cis: 4,
      by_type: { application: 1, database: 1, server: 2 },
      by_status: { active: 4 },
      critical_relationships: 1,
    });
    expect(res.body.recent_discoveries.map((ci: { id: string }) => ci.id)).toEqual(['a-web']);
  });

  it('discovery, connectivity, depth and matrix statistics cover only the caller org', async () => {
    const stats = await request(app).get('/api/v1/analytics/discovery-stats').set(AS_A);
    expect(Number(stats.body.data.summary.total_cis)).toBe(2);
    expect(stats.body.data.by_provider.map((p: { discovery_provider: string; count: unknown }) => [p.discovery_provider, Number(p.count)]))
      .toEqual([['aws', 2]]);

    const timeline = await request(app).get('/api/v1/analytics/discovery-timeline').set(AS_A);
    expect(timeline.body.data.map((p: { count: unknown }) => Number(p.count))).toEqual([2]);

    for (const direction of ['both', 'in', 'out']) {
      const top = await request(app).get(`/api/v1/analytics/top-connected?direction=${direction}`).set(AS_A);
      expect(top.status).toBe(200);
      const connected = Object.fromEntries(top.body.data
        .map((r: { ci_id: string; relationship_count: unknown }) => [r.ci_id, Number(r.relationship_count)])
        .filter(([, count]: [string, number]) => count > 0));
      expect(connected).toEqual({ both: { 'a-web': 1, 'a-db': 1 }, in: { 'a-db': 1 }, out: { 'a-web': 1 } }[direction]);
      expect(top.body.data.every((r: { ci_id: string }) => r.ci_id.startsWith('a-'))).toBe(true);
    }

    const depth = await request(app).get('/api/v1/analytics/dependency-depth').set(AS_A);
    expect(depth.body.data.top_cis.map((r: { ci_id: string; max_depth: unknown }) => [r.ci_id, Number(r.max_depth)]))
      .toEqual([['a-web', 1]]);
    expect(depth.body.data.depth_distribution.map((r: { max_depth: unknown; count: unknown }) => [Number(r.max_depth), Number(r.count)]))
      .toEqual([[1, 1]]);

    const matrix = await request(app).get('/api/v1/analytics/relationship-matrix').set(AS_A);
    expect(matrix.body.data).toEqual([{ source_type: 'application', target_type: 'database', relationship_type: 'DEPENDS_ON', count: 1 }]);
  });

  it("change timeline counts only the caller org's CIs", async () => {
    const res = await request(app).get('/api/v1/analytics/change-timeline').set(AS_A);
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { created: number; updated: number; deleted: number }) => [d.created, d.updated, d.deleted]))
      .toEqual([[0, 1, 0]]);
  });

  it('change-history and health-metrics for a foreign CI are the same 404 as a missing one', async () => {
    for (const path of ['/api/v1/analytics/change-history?ci_id=', '/api/v1/analytics/health-metrics/']) {
      const foreign = await request(app).get(`${path}b-db`).set(AS_A);
      const missing = await request(app).get(`${path}nope`).set(AS_A);
      expect([foreign.status, foreign.body]).toEqual([404, ANALYTICS_NOT_FOUND]);
      expect([missing.status, missing.body]).toEqual([404, ANALYTICS_NOT_FOUND]);
      const own = await request(app).get(`${path}a-db`).set(AS_A);
      expect([own.status, own.body.data.length]).toEqual([200, 1]);
    }
  });
});

describe('/api/v1/impact and /api/v1/drift tenant scoping', () => {
  const ciKeyed: Array<[string, (id: string) => string, (id: string) => object | undefined]> = [
    ['post', id => `/api/v1/drift/detect/${id}`, () => undefined],
    ['get', id => `/api/v1/drift/history/${id}`, () => undefined],
    ['post', () => '/api/v1/drift/baseline', id => ({ ci_id: id, snapshot_type: 'relationships' })],
    ['get', id => `/api/v1/drift/baseline/${id}`, () => undefined],
    ['post', () => '/api/v1/impact/predict', id => ({ ci_id: id, change_type: 'restart' })],
    ['get', id => `/api/v1/impact/graph/${id}`, () => undefined],
    ['get', id => `/api/v1/impact/criticality/${id}`, () => undefined],
    ['get', id => `/api/v1/impact/history/${id}`, () => undefined],
  ];

  it('GET /impact/:ciId (and every CI-keyed impact/drift route) for a foreign CI is 404, like a missing one', async () => {
    for (const [method, path, body] of ciKeyed) {
      const foreign = await call(method, path('b-db'), body('b-db'), AS_A);
      const missing = await call(method, path('nope'), body('nope'), AS_A);
      expect([method, path('b-db'), foreign.status, foreign.body]).toEqual([method, path('b-db'), 404, ciNotFound('b-db')]);
      expect([method, path('nope'), missing.status, missing.body]).toEqual([method, path('nope'), 404, ciNotFound('nope')]);
    }
    // The CI lookups are the only data access: no history row is read and nothing is written.
    expect(pgQueries).toBe(0);
  });

  it("approving another org's baseline is the same 404 as a missing one and approves nothing", async () => {
    const foreign = await request(app).post(`/api/v1/drift/baseline/${B_BASELINE}/approve`).set(AS_A);
    const missing = await request(app).post('/api/v1/drift/baseline/bbbbbbbb-0000-4000-8000-00000000ffff/approve').set(AS_A);
    expect(foreign.status).toBe(404);
    expect(foreign.body.message.replace(B_BASELINE, 'X')).toBe(missing.body.message.replace(/bbbbbbbb-0000-4000-8000-00000000ffff/, 'X'));
    expect(await send('query', 'SELECT is_approved FROM baseline_snapshots WHERE id = $1', [B_BASELINE])).toEqual([{ is_approved: false }]);

    const owner = await request(app).post(`/api/v1/drift/baseline/${B_BASELINE}/approve`).set(AS_B);
    expect(owner.status).toBe(200);
  });

  it("impact graph, prediction and criticality never count or return another org's CIs", async () => {
    const graphRes = await request(app).get('/api/v1/impact/graph/a-db').set(AS_A);
    expect(graphRes.status).toBe(200);
    const nodes = graphRes.body.data.nodes as Array<{ id: string; dependents_count: number; dependencies_count: number }>;
    expect(nodes.map(n => n.id).sort()).toEqual(['a-db', 'a-web']);
    expect(nodes.find(n => n.id === 'a-db')).toMatchObject({ dependents_count: 1, dependencies_count: 1 });
    expect(graphRes.body.data.edges.map((e: { source_id: string; target_id: string }) => `${e.source_id}->${e.target_id}`))
      .toEqual(['a-web->a-db']);

    const predicted = await request(app).post('/api/v1/impact/predict').set(AS_A).send({ ci_id: 'a-db', change_type: 'restart' });
    expect(predicted.status).toBe(201);
    expect(predicted.body.data.affected_cis.map((ci: { ci_id: string }) => ci.ci_id)).toEqual(['a-web']);
    expect(predicted.body.data.blast_radius).toBe(1);

    const criticality = await request(app).get('/api/v1/impact/criticality/a-lonely').set(AS_A);
    expect(criticality.status).toBe(200);
    expect(criticality.body.data.factors.dependent_count).toBe(0);
  });

  it('criticality is bounded and stable on a cycle of incoming edges, and unchanged without cycles', async () => {
    // Acyclic: a-db's only org A dependent is a-web (score 45), weighted by 0.5.
    const acyclic = await request(app).get('/api/v1/impact/criticality/a-db').set(AS_A);
    expect(acyclic.status).toBe(200);
    expect(acyclic.body.data).toMatchObject({ criticality_score: 62, factors: { dependent_count: 1, dependent_weight: 22.5 } });

    // A two-edge cycle of different types inside org A: a-host HOSTS a-app, a-app DEPLOYED_ON a-host.
    seedNode('a-host', ['CI'], ORG_A);
    seedNode('a-app', ['CI'], ORG_A, { type: 'application' });
    link('a-host', 'HOSTS', 'a-app');
    link('a-app', 'DEPLOYED_ON', 'a-host');
    cypherRuns.length = 0;

    const first = await request(app).get('/api/v1/impact/criticality/a-host').set(AS_A);
    expect(first.status).toBe(200);
    // a-app is scored first; a-host, still being scored, adds no weight to it (55), then a-host gets 55 * 0.5.
    expect(first.body.data).toMatchObject({ criticality_score: 63, factors: { dependent_count: 1, dependent_weight: 27.5 } });
    // getCI gate + one factor query per CI of the cycle.
    expect(cypherRuns).toHaveLength(3);

    const again = await request(app).get('/api/v1/impact/criticality/a-host').set(AS_A);
    expect(again.body.data.criticality_score).toBe(63);
    const other = await request(app).get('/api/v1/impact/criticality/a-app').set(AS_A);
    expect(other.body.data.criticality_score).toBe(55);
  });

  it("a relationships baseline only lists the caller org's CIs", async () => {
    const res = await request(app).post('/api/v1/drift/baseline').set(AS_A).send({ ci_id: 'a-lonely', snapshot_type: 'relationships' });
    expect(res.status).toBe(201);
    expect(res.body.data.snapshot_data).toEqual({ outgoing: [], incoming: [] });
  });

  it("results stored before tenant scoping do not expose or count another org's CIs", async () => {
    // Rows as the unscoped engines wrote them: through b-web / to b-db, and a cached score with no scope;
    // plus an older analysis that only involved org A's CIs.
    const affected = (id: string, path: string[]) => ({ ci_id: id, ci_name: id, dependency_path: path, hop_count: 1 });
    const insertAnalysis = (id: string, criticalPath: string[], cis: unknown[], downtime: number) => send('query',
      `INSERT INTO impact_analyses (id, source_ci_id, change_type, impact_score, blast_radius, critical_path, risk_level, analyzed_at, estimated_downtime_minutes, affected_cis)
       VALUES ($1, 'a-db', 'restart', 10, $2, $3, 'low', NOW() - INTERVAL '1 hour', $4, $5)`,
      [id, cis.length, JSON.stringify(criticalPath), downtime, JSON.stringify(cis)]);
    await insertAnalysis('aaaaaaaa-0000-4000-8000-0000000000c2', ['a-db', 'b-web'],
      [affected('a-web', ['a-db', 'a-web']), affected('b-web', ['a-db', 'b-web'])], 9);
    await insertAnalysis('aaaaaaaa-0000-4000-8000-0000000000c3', ['a-db', 'a-web'], [affected('a-web', ['a-db', 'a-web'])], 7);
    await send('query', `INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 'a-lonely', 'relationships', $1, NOW(), 'alice', true)`,
      [JSON.stringify({ outgoing: [{ type: 'DEPENDS_ON', ci_id: 'b-db', ci_name: 'shop-db-b' }], incoming: [] })]);
    await send('query', `INSERT INTO ci_criticality_scores (ci_id, ci_name, criticality_score, factors, calculated_at)
      VALUES ('a-lonely', 'a-lonely', 90, '{"dependent_count": 5, "dependent_weight": 0, "change_frequency": 0, "failure_history": 0, "business_impact": 50}', NOW())`);

    // The cross-org analysis is not served at all: its scores and downtime estimate count org B's CI.
    const history = await request(app).get('/api/v1/impact/history/a-db').set(AS_A);
    expect(history.status).toBe(200);
    expect(history.body.data.map((a: { id: string }) => a.id)).toEqual(['aaaaaaaa-0000-4000-8000-0000000000c3']);

    const baseline = await request(app).get('/api/v1/drift/baseline/a-lonely?snapshot_type=relationships').set(AS_A);
    expect(baseline.body.data.snapshot_data).toEqual({ outgoing: [], incoming: [] });

    const criticality = await request(app).get('/api/v1/impact/criticality/a-lonely').set(AS_A);
    expect(criticality.body.data.factors).toMatchObject({ dependent_count: 0 });
    expect(criticality.body.data.factors).not.toHaveProperty('organization_id');
    // Recalculated for org A and re-cached under that scope.
    expect((await request(app).get('/api/v1/impact/criticality/a-lonely').set(AS_A)).body.data.factors.dependent_count).toBe(0);
  });
});

describe('every route', () => {
  it('403 with zero queries without an org claim', async () => {
    for (const [method, path, body] of ROUTES) {
      const res = await call(method, path, body, NO_ORG);
      expect([method, path, res.status, res.body]).toEqual([method, path, 403, FORBIDDEN]);
    }
    expect(cypherRuns).toEqual([]);
    expect(pgQueries).toBe(0);
  });

  it("binds every matched :CI to the token org (directly or through a path-wide predicate)", async () => {
    for (const [method, path, body] of ROUTES) {
      const res = await call(method, path, body, AS_A);
      expect([method, path, res.status < 300]).toEqual([method, path, true]);
    }
    const unscoped = cypherRuns.flatMap(({ cypher, params }) => {
      const variables = [...cypher.matchAll(/\((\w+):CI\b/g)].map(m => m[1]!);
      const missing = variables.filter(v => !cypher.includes(PATH_SCOPE) && !cypher.includes(`${v}.organization_id = $organizationId`));
      if (variables.length > 0 && params['organizationId'] !== ORG_A) missing.push('$organizationId param');
      return missing.map(v => `${v} in: ${cypher.replace(/\s+/g, ' ').trim()}`);
    });
    expect(unscoped).toEqual([]);
  });
});

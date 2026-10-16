// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const users = {
  a: { _id: 'a', _username: 'alice', _role: 'viewer', _enabled: true, _organizationId: A },
  b: { _id: 'b', _username: 'bob', _role: 'viewer', _enabled: true, _organizationId: B },
};
const nodes = [A, B].flatMap((organization_id, index) => {
  const prefix = index === 0 ? 'a' : 'b';
  return ['orphan', 'rel', 'target', 'pending'].map(id => ({
    id: `${prefix}-${id}`, name: `host-${prefix}-${id}`, organization_id,
    type: 'server', created_at: '2026-10-15T00:00:00Z',
  }));
});
const edges = new Map([['a-rel', 'a-target'], ['b-rel', 'b-target']]);
const fulltextScores = new Map<string, number>();
const row = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
function graphRun(cypher: string, params: Record<string, any>) {
  const root = cypher.includes('CALL db.index.fulltext') ? 'node' : 'ci';
  let eligible = nodes.filter(n =>
    (!cypher.includes(`${root}.organization_id = $organizationId`) || n.organization_id === params.organizationId) &&
    (!cypher.includes(`NOT ${root}.id IN $pending`) || !params.pending.includes(n.id)));
  if (cypher.includes('(ci.name CONTAINS $query')) eligible = eligible.filter(n => n.name.includes(params.query));
  if (cypher.includes('MATCH (ci:CI {type:')) {
    eligible = eligible.filter(n => {
      const target = nodes.find(other => other.id === edges.get(n.id));
      return target && n.type === params.ci_type && target.type === params.related_ci_type &&
        (!cypher.includes('related.organization_id = $organizationId') || target.organization_id === params.organizationId) &&
        (!cypher.includes('NOT related.id IN $pending') || !params.pending.includes(target.id));
    });
  }
  if (cypher.includes('AND NOT EXISTS')) {
    eligible = eligible.filter(n => !nodes.some(other => {
      const related = edges.get(n.id) === other.id || edges.get(other.id) === n.id;
      return related && (!cypher.includes('related.organization_id = $organizationId') || other.organization_id === params.organizationId) &&
        (!cypher.includes('NOT related.id IN $pending') || !params.pending.includes(other.id));
    }));
  }
  eligible.sort((left, right) => left.name.localeCompare(right.name));
  if (cypher.includes('CALL db.index.fulltext')) {
    if (cypher.includes('collect(node)')) {
      if (eligible.length > 100) throw new Error('Unbounded full-text materialization');
      return { records: [row({
        total: neo4j.int(eligible.length),
        page: eligible.slice(0, params.limit.toNumber()).map(properties => ({ properties })),
      })] };
    }
    if (cypher.includes('count(node)')) return { records: [row({ total: neo4j.int(eligible.length) })] };
    if (cypher.includes('ORDER BY score DESC')) {
      eligible.sort((left, right) =>
        (fulltextScores.get(right.id) ?? 1) - (fulltextScores.get(left.id) ?? 1) || left.id.localeCompare(right.id));
    }
    return { records: eligible.slice(0, params.limit.toNumber()).map(properties =>
      row({ node: { properties }, score: fulltextScores.get(properties.id) ?? 1 })) };
  }
  if (cypher.includes('count(ci)')) return { records: [row({ total: neo4j.int(eligible.length) })] };
  const offset = params.offset ? params.offset.toNumber() : 0;
  const limit = params.limit.toNumber();
  return { records: eligible.slice(offset, offset + limit).map(properties => row({ ci: { properties } })) };
}
const graph = { getSession: () => ({ run: async (query: string, params: Record<string, any>) => graphRun(query, params), close: async () => undefined }) };
const pgQuery = async (command: string | { text: string; values?: string[] }, values: string[] = []) => {
  const query = typeof command === 'string' ? command : command.text;
  const params = typeof command === 'string' ? values : command.values ?? [];
  if (!query.includes('ci_reconciliation_operations') || !query.includes('organization_id=$1')) {
    throw new Error('Unexpected admission query');
  }
  return { rows: [{ epoch: '0', pending: [params[0] === A ? 'a-pending' : 'b-pending'] }] };
};
const pg = { query: pgQuery, pool: { query: pgQuery } };
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => graph, getPostgresClient: () => pg }));
jest.mock('../../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: jest.fn(() => ({
  findUserById: async (id: 'a' | 'b') => users[id] ?? null,
  findApiKeyByKey: async () => null, updateApiKeyLastUsed: async () => undefined,
})) }));
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { ciRoutes } from '../ci.routes';
import { searchRoutes } from '../search.routes';
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/search', searchRoutes);
app.use('/api/v1/cis', ciRoutes);
const auth = (user: 'a' | 'b') => ({ Authorization: `Bearer ${jwt.generateAccessToken(user, users[user]._username, 'viewer', users[user]._organizationId)}` });

it('omits pending CIs and foreign CIs from every mounted search list and count for two signed organizations', async () => {
  for (const user of ['a', 'b'] as const) {
    const advanced = await request(app).post('/api/v1/search/advanced').set(auth(user)).send({ query: 'host' });
    const fulltext = await request(app).post('/api/v1/search/fulltext').set(auth(user)).send({ query: 'host' });
    const relationship = await request(app).post('/api/v1/search/relationships').set(auth(user))
      .send({ ci_type: 'server', relationship_type: 'DEPENDS_ON', related_ci_type: 'server' });
    const orphaned = await request(app).get('/api/v1/search/orphaned').set(auth(user));
    expect([advanced.status, fulltext.status, relationship.status, orphaned.status]).toEqual([200, 200, 200, 200]);
    const expected = [`${user}-orphan`, `${user}-rel`, `${user}-target`];
    expect(advanced.body.pagination.total).toBe(3);
    expect(advanced.body.data.map((ci: { id: string }) => ci.id)).toEqual(expected);
    expect(fulltext.body.total).toBe(3);
    expect(fulltext.body.data.map((row: { ci: { id: string } }) => row.ci.id)).toEqual(expected);
    expect(relationship.body.data.map((ci: { id: string }) => ci.id)).toEqual([`${user}-rel`]);
    expect(orphaned.body.pagination.total).toBe(1);
    expect(orphaned.body.data.map((ci: { id: string }) => ci.id)).toEqual([`${user}-orphan`]);
  }
});

it('returns exact two-org full-text totals and the first owned match with a large limit-one inventory', async () => {
  const originalSize = nodes.length;
  try {
    for (let index = 0; index < 2400; index++) {
      nodes.push({
        id: `a-bulk-${String(index).padStart(4, '0')}`, name: `host-a-bulk-${String(index).padStart(4, '0')}`,
        organization_id: A, type: 'server', created_at: '2026-10-15T00:00:00Z',
      }, {
        id: `b-bulk-${String(index).padStart(4, '0')}`, name: `host-b-bulk-${String(index).padStart(4, '0')}`,
        organization_id: B, type: 'server', created_at: '2026-10-15T00:00:00Z',
      });
    }
    for (const user of ['a', 'b'] as const) {
      const response = await request(app).post('/api/v1/search/fulltext').set(auth(user))
        .send({ query: 'host', limit: 1 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        total: 2403, count: 1, data: [{ ci: { id: `${user}-bulk-0000` } }],
      });
    }
  } finally {
    nodes.length = originalSize;
  }
});

it('ranks tenant-owned full-text hits by index relevance before limit and returns each score', async () => {
  const originalSize = nodes.length;
  try {
    for (const user of ['a', 'b'] as const) {
      nodes.push(
        { id: `${user}-weak`, name: `host-${user}-aaa`, organization_id: users[user]._organizationId,
          type: 'server', created_at: '2026-10-15T00:00:00Z' },
        { id: `${user}-strong`, name: `host-${user}-zzz`, organization_id: users[user]._organizationId,
          type: 'server', created_at: '2026-10-15T00:00:00Z' },
      );
      fulltextScores.set(`${user}-weak`, 0.25);
      fulltextScores.set(`${user}-strong`, 8);
    }
    for (const user of ['a', 'b'] as const) {
      const response = await request(app).post('/api/v1/search/fulltext').set(auth(user))
        .send({ query: 'host', limit: 1 });
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(5);
      expect(response.body.data).toEqual([{ ci: expect.objectContaining({ id: `${user}-strong` }), score: 8 }]);
    }
  } finally {
    nodes.length = originalSize;
    fulltextScores.clear();
  }
});

it('bounds and score-ranks both tenants on mounted CI search even when the index has thousands of matches', async () => {
  const originalSize = nodes.length;
  try {
    for (const user of ['a', 'b'] as const) {
      nodes.push(
        { id: `${user}-weak`, name: `host-${user}-aaa`, organization_id: users[user]._organizationId,
          type: 'server', created_at: '2026-10-15T00:00:00Z' },
        { id: `${user}-strong`, name: `host-${user}-zzz`, organization_id: users[user]._organizationId,
          type: 'server', created_at: '2026-10-15T00:00:00Z' },
      );
      fulltextScores.set(`${user}-weak`, 0.25);
      fulltextScores.set(`${user}-strong`, 8);
    }
    const small = await Promise.all((['a', 'b'] as const).map(user =>
      request(app).post('/api/v1/cis/search').set(auth(user)).send({ query: 'host', limit: 1 })));
    expect(small.map(response => response.status)).toEqual([200, 200]);
    for (let index = 0; index < 2400; index++) {
      for (const [user, organization_id] of [['a', A], ['b', B]] as const) {
        nodes.push({ id: `${user}-bulk-${index}`, name: `host-${user}-bulk-${index}`,
          organization_id, type: 'server', created_at: '2026-10-15T00:00:00Z' });
      }
    }
    for (const user of ['a', 'b'] as const) {
      const response = await request(app).post('/api/v1/cis/search').set(auth(user))
        .send({ query: 'host', limit: 1 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        total: 2405, count: 1, data: [{ ci: { id: `${user}-strong` }, score: 8 }],
      });
    }
    for (const [index, user] of (['a', 'b'] as const).entries()) {
      expect(small[index]!.body).toMatchObject({
        total: 5, count: 1, data: [{ ci: { id: `${user}-strong` }, score: 8 }],
      });
    }
  } finally {
    nodes.length = originalSize;
    fulltextScores.clear();
  }
});

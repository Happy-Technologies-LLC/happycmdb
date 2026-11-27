// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** openapi.yaml `GET /relationships/type/{type}` against the real route: the bodies it sends validate against the declared schemas. */
import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../middleware/auth.middleware';
import { declaredResponse, deref, spec, violations } from './spec-schema';

const ORG = '11111111-1111-4111-8111-111111111111';
const getSession = jest.fn();

jest.mock('../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>('../../middleware/auth.middleware');
  const verifier = { verifyToken: async (token: string) => {
    if (token !== 'viewer') throw new Error('Invalid token');
    return { _userId: token, _username: token, _role: token, _organizationId: ORG, _type: 'access' };
  } } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']) };
});
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => ({ getSession }) }));

import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { relationshipRoutes } from '../../rest/routes/relationship.routes';

const app = express();
app.use(express.json());
app.use('/relationships', getAuthMiddleware().authenticate(), relationshipRoutes);

const PATH = '/relationships/type/{type}';
const stamp = () => new neo4j.types.DateTime(neo4j.int(2026), neo4j.int(11), neo4j.int(20), neo4j.int(1), neo4j.int(2), neo4j.int(3), neo4j.int(4), neo4j.int(0), null);
const node = (id: string, name: string, type: string) => ({ properties: { id, name, type, organization_id: ORG } });
const record = (key: string) => ({
  get: (field: string) => field === 'from' ? node('ci-a', 'alpha', 'server')
    : field === 'to' ? node('ci-b', 'beta', 'database')
      : { type: 'DEPENDS_ON', properties: { created_at: stamp(), updated_at: stamp(), note: key } },
});

const get = (path: string) => request(app).get(path).set('authorization', 'Bearer viewer');
const page = (records: unknown[], total = records.length) => {
  const run = jest.fn(async (query: string) => query.includes('count(r)') ? { records: [{ get: () => ({ toNumber: () => total }) }] } : { records });
  getSession.mockReturnValue({ run, close: jest.fn().mockResolvedValue(undefined) });
};
const ok = () => declaredResponse(PATH, 'get', '200').schema!;

beforeEach(() => { getSession.mockReset(); page([record('one'), record('two')], 7); });

describe('openapi.yaml GET /relationships/type/{type} 200', () => {
  it('declares the object envelope the route sends, with a row per relationship', async () => {
    const response = await get('/relationships/type/DEPENDS_ON?limit=2&offset=1');
    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({ total: 7, count: 2, offset: 1, limit: 2 });
    expect(Object.keys(response.body.data[0]).sort()).toEqual(
      ['created_at', 'from_id', 'from_name', 'from_type', 'properties', 'to_id', 'to_name', 'to_type', 'type', 'updated_at']);
    expect(violations(ok(), response.body)).toEqual([]);
  });

  it('is closed and typed: an extra key, an underscore row key, a string limit, a missing success and a bare array each violate it', async () => {
    const { body } = await get('/relationships/type/DEPENDS_ON');
    const { success: _success, ...withoutSuccess } = body;
    expect(violations(ok(), { ...body, extra: 1 })).toContain('$: unexpected extra');
    expect(violations(ok(), { ...body, data: [{ ...body.data[0], _from_id: 'ci-a' }] })).toContain('$.data[0]: unexpected _from_id');
    expect(violations(ok(), { ...body, pagination: { ...body.pagination, limit: '100' } }).length).toBeGreaterThan(0);
    expect(violations(ok(), { ...body, pagination: { ...body.pagination, count: undefined } })).toContain('$.pagination.count: expected integer, got undefined');
    expect(violations(ok(), withoutSuccess)).toContain('$: missing success');
    expect(violations(ok(), body.data).length).toBeGreaterThan(0);
  });

  it('validates an empty page and a relationship whose edge carries no timestamps', async () => {
    page([], 0);
    const empty = await get('/relationships/type/HOSTS');
    expect(empty.body).toEqual({ success: true, data: [], pagination: { total: 0, count: 0, offset: 0, limit: 100 }, type: 'HOSTS' });
    expect(violations(ok(), empty.body)).toEqual([]);
    const bare = { get: (field: string) => field === 'r' ? { type: 'USES', properties: {} } : node('x', 'x', 'server') };
    page([bare]);
    const response = await get('/relationships/type/USES');
    expect(Object.keys(response.body.data[0])).not.toContain('created_at');
    expect(violations(ok(), response.body)).toEqual([]);
  });
});

describe('openapi.yaml GET /relationships/type/{type} 400', () => {
  const refused = () => declaredResponse(PATH, 'get', '400').schema!;

  it('declares the unknown-type body', async () => {
    const response = await get('/relationships/type/NOPE');
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(violations(refused(), response.body)).toEqual([]);
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each(['?limit=0', '?limit=1001', '?offset=-1', '?limit=abc'])('declares the query-validation body for %s', async (query) => {
    const response = await get(`/relationships/type/DEPENDS_ON${query}`);
    expect(response.status).toBe(400);
    expect(response.body._error).toBe('Validation Error');
    expect(violations(refused(), response.body)).toEqual([]);
  });

  it('does not accept a body that is neither refusal', () => {
    expect(violations(refused(), { success: false, error: 'Bad Request' }).length).toBeGreaterThan(0);
    expect(violations(refused(), { success: true, data: [] }).length).toBeGreaterThan(0);
  });
});

describe('openapi.yaml GET /relationships/type/{type} parameters', () => {
  const parameters = (spec.paths[PATH]!['get'] as unknown as { parameters: Array<{ name: string; in: string; schema: { minimum?: number; maximum?: number; default?: number } }> }).parameters;
  const parameter = (name: string) => parameters.find(candidate => candidate.name === name)!.schema;
  const accepted = async (query: string) => (await get(`/relationships/type/DEPENDS_ON?${query}`)).status === 200;

  it('declares limit and offset (not _limit or _offset) with the bounds and defaults the route enforces', async () => {
    expect(parameters.map(candidate => `${candidate.in}:${candidate.name}`).sort()).toEqual(['path:type', 'query:limit', 'query:offset']);
    const { minimum, maximum, default: limitDefault } = parameter('limit');
    expect([minimum, maximum, limitDefault]).toEqual([1, 1000, 100]);
    expect([await accepted(`limit=${minimum}`), await accepted(`limit=${minimum! - 1}`)]).toEqual([true, false]);
    expect([await accepted(`limit=${maximum}`), await accepted(`limit=${maximum! + 1}`)]).toEqual([true, false]);
    const { minimum: floor, default: offsetDefault } = parameter('offset');
    expect([floor, offsetDefault]).toEqual([0, 0]);
    expect([await accepted(`offset=${floor}`), await accepted(`offset=${floor! - 1}`)]).toEqual([true, false]);
    const bare = await get('/relationships/type/DEPENDS_ON?limit=3');
    expect(bare.body.pagination).toMatchObject({ limit: 3, offset: offsetDefault });
    expect((await get('/relationships/type/DEPENDS_ON?offset=2')).body.pagination.limit).toBe(limitDefault);
  });

  it('declares the path type values the route accepts, and no others', async () => {
    const declared = spec.components.schemas['RestRelationshipType']!.enum as string[];
    expect(deref((parameters.find(candidate => candidate.name === 'type') as unknown as { schema: { $ref: string } }).schema)).toBe(spec.components.schemas['RestRelationshipType']);
    for (const type of declared) expect((await get(`/relationships/type/${type}`)).status).toBe(200);
    const refused = (spec.components.schemas['RelationshipType']!.enum as string[]).filter(type => !declared.includes(type));
    expect(refused.length).toBeGreaterThan(0);
    for (const type of refused) expect((await get(`/relationships/type/${type}`)).status).toBe(400);
  });
});

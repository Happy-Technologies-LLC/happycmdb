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
const user = { _id: 'a', _username: 'alice', _role: 'viewer', _enabled: true, _organizationId: A };
const runs: Array<{ cypher: string; params: Record<string, any> }> = [];
const row = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
const graph = {
  getSession: () => ({
    run: async (cypher: string, params: Record<string, any>) => {
      runs.push({ cypher, params });
      return { records: /count\(\w+\)/.test(cypher) ? [row({ total: neo4j.int(0) })] : [] };
    },
    close: async () => undefined,
  }),
};
const pgQuery = async () => ({ rows: [{ epoch: '0', pending: ['pending-ci'] }] });
const pg = { query: pgQuery, pool: { query: pgQuery } };
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => graph, getPostgresClient: () => pg }));
jest.mock('../../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: jest.fn(() => ({
  findUserById: async () => user,
  findApiKeyByKey: async () => null, updateApiKeyLastUsed: async () => undefined,
})) }));
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { ciRoutes } from '../ci.routes';
import { searchRoutes } from '../search.routes';
import { metadataNeedles, metadataFilterRefusal, SearchController } from '../../controllers/search.controller';

const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/search', searchRoutes);
app.use('/api/v1/cis', ciRoutes);
const auth = { Authorization: `Bearer ${jwt.generateAccessToken('a', 'alice', 'viewer', A, 0, Math.floor(Date.now() / 1000))}` };
const advanced = (body: Record<string, unknown>) => request(app).post('/api/v1/search/advanced').set(auth).send(body);
const withFilters = (metadata_filters: unknown) => advanced({ query: 'host', metadata_filters });
const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 'v']));

beforeEach(() => { runs.length = 0; });

// What Cypher `ci.metadata CONTAINS` decides for one pair: any needle is a substring of the stored JSON text.
const matches = (stored: Record<string, unknown>, key: string, value: string | number | boolean) =>
  metadataNeedles(key, value).some(needle => JSON.stringify(stored).includes(needle));

describe('metadataNeedles', () => {
  it.each([
    ['env', 'prod', ['"env":"prod"']],
    ['n', 3, ['"n":3,', '"n":3}']],
    ['n', -1.5, ['"n":-1.5,', '"n":-1.5}']],
    ['on', true, ['"on":true']],
    ['on', false, ['"on":false']],
    ['say', 'a"b', ['"say":"a\\"b"']],
    ['k"x', 'v', ['"k\\"x":"v"']],
    ['path', 'C:\\dir', ['"path":"C:\\\\dir"']],
    ['k\\x', 'v', ['"k\\\\x":"v"']],
    ['note', 'a\nb', ['"note":"a\\nb"']],
    ['a":"b","c', 'v', ['"a\\":\\"b\\",\\"c":"v"']],
  ] as const)('%j / %j -> %j', (key, value, expected) => {
    expect(metadataNeedles(key, value)).toEqual(expected);
  });

  it('matches the stored JSON text for every scalar type, in any position', () => {
    const metadata = { env: 'prod', n: 3, on: true, q: 'say "hi"', 'k"x': 'C:\\dir', nl: 'a\nb', off: false, f: 1.5 };
    for (const [key, value] of Object.entries(metadata)) expect(matches(metadata, key, value)).toBe(true);
    expect(matches({ n: 3 }, 'n', 3)).toBe(true);
    expect(matches({ a: 1, n: 3 }, 'n', 3)).toBe(true);
    expect(matches({ n: 3, a: 1 }, 'n', 3)).toBe(true);
    expect(matches({ n: -1.5 }, 'n', -1.5)).toBe(true);
  });

  it('does not match a number that merely starts with the filter number', () => {
    for (const stored of [{ n: 30 }, { n: 3.5 }, { n: 300000 }, { n: 31, x: 1 }, { x: 1, n: 3.25 }, { n: 3e21 }]) {
      expect(matches(stored, 'n', 3)).toBe(false);
    }
    expect(matches({ n: -1.5 }, 'n', -1)).toBe(false);
    expect(matches({ cpu_cores: 85 }, 'cpu_cores', 8)).toBe(false);
  });

  it('does not match a number against a string of digits, or the reverse', () => {
    expect(matches({ n: '3' }, 'n', 3)).toBe(false);
    expect(matches({ n: 3 }, 'n', '3')).toBe(false);
  });

  it('does not match a forged key/value structure', () => {
    expect(matches({ a: 'b', c: 'v' }, 'a":"b","c', 'v')).toBe(false);
  });
});

describe('POST /search/advanced metadata_filters', () => {
  it('passes exactly the stored-JSON needles as Cypher parameters, in order', async () => {
    const filters = { env: 'prod', n: 3, on: true, q: 'say "hi"', 'k"x': 'C:\\dir' };
    const res = await withFilters(filters);
    expect(res.status).toBe(200);
    expect(runs.length).toBe(2);
    for (const { params } of runs) {
      const needles = Object.keys(params).filter(k => k.startsWith('metaValue')).sort((a, b) => Number(a.slice(9)) - Number(b.slice(9))).map(k => params[k]);
      expect(needles).toEqual(['"env":"prod"', '"n":3,', '"n":3}', '"on":true', '"q":"say \\"hi\\""', '"k\\"x":"C:\\\\dir"']);
    }
  });

  it('keeps the organization, pending exclusion and the other filters in the query parameters', async () => {
    const res = await advanced({ query: 'host', type: 'server', status: 'active', environment: 'production', metadata_filters: { n: 3 } });
    expect(res.status).toBe(200);
    expect(runs.length).toBe(2);
    for (const { params } of runs) {
      expect([params.organizationId, params.pending, params.type, params.status, params.environment])
        .toEqual([A, ['pending-ci'], 'server', 'active', 'production']);
    }
  });

  it('accepts no filters and empty-string values', async () => {
    expect((await advanced({ query: 'host' })).status).toBe(200);
    const res = await withFilters({ k: '' });
    expect(res.status).toBe(200);
    expect(runs.at(-1)!.params.metaValue0).toBe('"k":""');
  });

  it.each([
    ['21 keys', keys(21)],
    ['nested object value', { k: { a: 1 } }],
    ['array value', { k: [1] }],
    ['null value', { k: null }],
    ['129-character key', { ['k'.repeat(129)]: 'v' }],
    ['empty key', { '': 'v' }],
    ['257-character value', { k: 'v'.repeat(257) }],
    ['array metadata_filters', ['a']],
    ['string metadata_filters', 'a'],
  ])('rejects %s at the route schema with 400 and runs no query', async (_name, filters) => {
    const res = await withFilters(filters);
    expect(res.status).toBe(400);
    expect(res.body._error).toBe('Validation Error');
    expect(runs).toEqual([]);
  });

  it.each([
    ['20 keys', keys(20)],
    ['128-character key', { ['k'.repeat(128)]: 'v' }],
    ['256-character value', { k: 'v'.repeat(256) }],
  ])('accepts %s', async (_name, filters) => {
    const res = await withFilters(filters);
    expect(res.status).toBe(200);
    expect(runs.length).toBe(2);
  });

  it.each([
    ['unsafe integer', '{"k":9007199254740992}'],
    ['overflowing number', '{"k":1e300}'],
    ['__proto__ key', '{"__proto__":"x"}'],
    ['__proto__ key beside a valid key', '{"a":"x","__proto__":"y"}'],
  ])('rejects %s with 400 instead of dropping or widening the filter', async (_name, raw) => {
    const res = await request(app).post('/api/v1/search/advanced').set(auth).set('Content-Type', 'application/json')
      .send(`{"query":"host","metadata_filters":${raw}}`);
    expect(res.status).toBe(400);
    expect(runs).toEqual([]);
  });
});

describe('search query length', () => {
  const routes = [
    ['/api/v1/search/advanced'],
    ['/api/v1/search/fulltext'],
    ['/api/v1/cis/search'],
  ];
  it.each(routes)('%s rejects a 501-character query and accepts 500', async (path) => {
    const refused = await request(app).post(path).set(auth).send({ query: 'q'.repeat(501) });
    expect(refused.status).toBe(400);
    expect(refused.body._error).toBe('Validation Error');
    expect(runs).toEqual([]);
    const accepted = await request(app).post(path).set(auth).send({ query: 'q'.repeat(500) });
    expect(accepted.status).toBe(200);
  });
});

describe('metadataFilterRefusal (route schema bypassed)', () => {
  it('refuses the same violations the route schema refuses', () => {
    for (const bad of [keys(21), { k: { a: 1 } }, { k: [1] }, { k: null }, { ['k'.repeat(129)]: 'v' }, { '': 'v' },
      { k: 'v'.repeat(257) }, { k: Infinity }, { k: 2 ** 53 }, { k: -(2 ** 53) }, { k: 1e300 }, ['a'], 'a', null]) {
      expect(metadataFilterRefusal(bad)).not.toBeNull();
    }
    for (const good of [undefined, {}, keys(20), { n: 3, on: false, s: '' }, { k: 2 ** 53 - 1 }, { k: -1.5 }]) expect(metadataFilterRefusal(good)).toBeNull();
  });

  it('advancedSearch answers 400 before any query when called directly with a bad body', async () => {
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })), json } as any;
    await new SearchController().advancedSearch({ body: { query: 'host', metadata_filters: keys(21) } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(runs).toEqual([]);
  });
});

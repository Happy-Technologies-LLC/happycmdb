// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// openapi.yaml API-key operations against the code that answers: the real AuthController, AuthService, AuthMiddleware
// and JWT signing over an in-memory repository that returns the shapes neo4j-auth.repository.ts returns.
import { join } from 'path';
import * as YAML from 'yamljs';
import express from 'express';
import request from 'supertest';
import { AuthController } from '../../rest/auth.controller';
import { AuthService, type AuthRepository } from '../../auth/auth.service';
import { ValidationMiddleware } from '../../rest/middleware/validation.middleware';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import type { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { JWTService } from '../../auth/jwt.service';
import type { ApiKey, User } from '../../auth/types';
import { logger } from '@cmdb/common';

type Schema = {
  $ref?: string; type?: string; nullable?: boolean; required?: string[]; pattern?: string; example?: string;
  properties?: Record<string, Schema>; items?: Schema; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
};
type Response = { content?: { 'application/json': { schema?: Schema; example?: unknown; examples?: Record<string, { value: unknown }> } } };
type Operation = {
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
};
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, Record<string, Operation>>;
  security: Array<Record<string, string[]>>;
  components: { schemas: Record<string, Schema>; securitySchemes: Record<string, Record<string, unknown>> };
};
const operation = (path: string, method: string): Operation => spec.paths[path]![method]!;
const body = (path: string, method: string, status: string) => operation(path, method).responses[status]!.content!['application/json'];
const declared = (path: string, method: string): string[] => Object.keys(operation(path, method).responses).sort();
const exampleOf = (schema: Schema): string | undefined => schema.example;
const keysOf = (schema: Schema): string[] => Object.keys(schema.properties!).sort();

const CREATE = '/auth/api-key';
const LIST = '/auth/api-keys';
const REVOKE = '/auth/api-key/{keyId}';

const authConfig = {
  jwt: { secret: 'test-secret-at-least-32-characters-long', accessTokenExpiresIn: '15m', refreshTokenExpiresIn: '7d', issuer: 'happycmdb-test', audience: 'happycmdb-test' },
  bcrypt: { rounds: 4 },
};

/** Rows shaped like neo4j-auth.repository.ts: unset dates are null, as the pg driver returns them. */
class KeyRepository {
  user = { _id: 'user-1', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: '0c2d6d1e-6f3a-4a51-8e0b-9d4c7f1a2b35' } as User;
  rows: Array<Record<string, unknown> & { _keyHash: string; _userId: string; revoked: boolean }> = [];
  async findUserById(id: string): Promise<User | null> { return id === this.user._id ? this.user : null; }
  async createApiKey(key: ApiKey): Promise<ApiKey> {
    const row = {
      _id: `7d0c8c5e-3a52-4c5b-9a6e-1f2e3d4c5b${String(this.rows.length).padStart(2, '0')}`, _userId: key._userId, _keyHash: key._keyHash,
      _name: key._name, _role: key._role, _enabled: true, _createdAt: new Date(), expiresAt: key.expiresAt ?? null, lastUsedAt: null,
      _credentialEpoch: key._credentialEpoch, revoked: false,
    };
    this.rows.push(row);
    return row as unknown as ApiKey;
  }
  async findApiKeyByKey(hash: string): Promise<ApiKey | null> {
    return (this.rows.find(row => row._keyHash === hash && !row.revoked) as unknown as ApiKey) ?? null;
  }
  async updateApiKeyLastUsed(): Promise<void> {}
  async listApiKeys(userId: string) {
    return this.rows.filter(row => row._userId === userId && !row.revoked).map(({ _keyHash, revoked, ...row }) => row);
  }
  async deleteApiKey(userId: string, keyId: string): Promise<number> {
    const row = this.rows.find(candidate => candidate._userId === userId && candidate._id === keyId && !candidate.revoked);
    if (row) row.revoked = true;
    return row ? 1 : 0;
  }
}

const passLimiter = () => (_req: unknown, _res: unknown, next: () => void) => next();
const rateLimiter = { limit: passLimiter, custom: passLimiter, endpointBudget: () => ({ _max: 1, _windowMs: 1 }) } as unknown as RateLimitMiddleware;

function build(enabled: boolean) {
  const repository = new KeyRepository();
  const config = { ...authConfig, apiKeys: { enabled, headerName: 'X-API-Key' } } as never;
  const service = new AuthService(config, repository as unknown as AuthRepository);
  const controller = new AuthController(service, new ValidationMiddleware(), new AuthMiddleware(service, config), rateLimiter);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', controller.getRouter());
  const session = new JWTService(authConfig.jwt as never).generateAccessToken('user-1', 'alice', 'operator', undefined, 0, Math.floor(Date.now() / 1000));
  const bearer = (req: request.Test): request.Test => req.set('Authorization', `Bearer ${session}`);
  return { app, repository, bearer };
}

beforeEach(() => {
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
});
afterEach(() => jest.restoreAllMocks());

describe('API-key operations in openapi.yaml', () => {
  it('puts each operation at the path the router mounts, with the statuses the stack sends', async () => {
    expect(spec.paths[CREATE]!['post']).toBeDefined();
    expect(spec.paths[LIST]!['get']).toBeDefined();
    expect(spec.paths[REVOKE]!['delete']).toBeDefined();
    expect(spec.paths['/auth/api-keys/{keyId}']).toBeUndefined();
    expect(spec.paths[CREATE]!['get']).toBeUndefined();
    expect(spec.paths[LIST]!['post']).toBeUndefined();

    const { app, bearer } = build(true);
    const observed = { create: new Set<number>(), list: new Set<number>(), revoke: new Set<number>() };
    const record = (kind: keyof typeof observed, res: request.Response) => { observed[kind].add(res.status); return res; };

    const unauthenticated = [
      record('create', await request(app).post('/api/v1/auth/api-key').send({ name: 'ci key' })),
      record('list', await request(app).get('/api/v1/auth/api-keys')),
      record('revoke', await request(app).delete('/api/v1/auth/api-key/none')),
    ];
    expect(unauthenticated.map(res => res.status)).toEqual([401, 401, 401]);
    record('create', await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'x' }));

    const created = record('create', await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'ci key', expiresInDays: 30 }));
    const key = created.body.data._apiKey as string;
    // A key-only caller is refused on all three with the JWT_SESSION_REQUIRED body the spec shows.
    const refused = [
      record('create', await request(app).post('/api/v1/auth/api-key').set('X-API-Key', key).send({ name: 'chained' })),
      record('list', await request(app).get('/api/v1/auth/api-keys').set('X-API-Key', key)),
      record('revoke', await request(app).delete(`/api/v1/auth/api-key/${created.body.data._id}`).set('X-API-Key', key)),
    ];
    const forbidden = body(REVOKE, 'delete', '403').example;
    expect(refused.map(res => [res.status, res.body])).toEqual([[403, forbidden], [403, forbidden], [403, forbidden]]);
    expect(body(LIST, 'get', '403').example).toEqual(forbidden);
    expect(body(CREATE, 'post', '403').examples!['jwtSessionRequired']!.value).toEqual(forbidden);

    record('list', await bearer(request(app).get('/api/v1/auth/api-keys')));
    record('revoke', await bearer(request(app).delete(`/api/v1/auth/api-key/${created.body.data._id}`)));
    const again = record('revoke', await bearer(request(app).delete(`/api/v1/auth/api-key/${created.body.data._id}`)));
    expect([again.status, again.body]).toEqual([404, body(REVOKE, 'delete', '404').example]);

    // 500 is declared for create and list (a store failure) but not reachable here without breaking the fake: only check it is documented.
    for (const [kind, path, method] of [['create', CREATE, 'post'], ['list', LIST, 'get'], ['revoke', REVOKE, 'delete']] as const) {
      const missing = [...observed[kind]].map(String).filter(status => !declared(path, method).includes(status));
      expect(missing).toEqual([]);
    }
    expect(declared(CREATE, 'post')).toEqual(expect.arrayContaining(['200', '400', '401', '403']));
    expect(declared(CREATE, 'post')).not.toContain('201');
    expect(declared(REVOKE, 'delete')).toEqual(expect.arrayContaining(['200', '401', '403', '404']));
    expect(declared(REVOKE, 'delete')).not.toContain('204');
  });

  it('create answers 200 with exactly the data fields declared, a 64-hex key, and enforces the declared request bounds', async () => {
    const { app, bearer } = build(true);
    const requestSchema = operation(CREATE, 'post').requestBody!.content['application/json'].schema;
    expect(keysOf(requestSchema)).toEqual(['expiresInDays', 'name']);
    const { name, expiresInDays } = requestSchema.properties!;

    const created = await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'n'.repeat(name!.minLength!), expiresInDays: expiresInDays!.minimum });
    expect(created.status).toBe(200);
    const dataSchema = body(CREATE, 'post', '200').schema!.properties!['data']!;
    expect(Object.keys(created.body).sort()).toEqual(keysOf(body(CREATE, 'post', '200').schema!));
    expect(Object.keys(created.body.data).sort()).toEqual(keysOf(dataSchema));
    expect(created.body.data._apiKey).toMatch(new RegExp(dataSchema.properties!['_apiKey']!.pattern!));
    expect(created.body.message).toBe(exampleOf(body(CREATE, 'post', '200').schema!.properties!['message']!));

    const send = async (payload: object) => (await bearer(request(app).post('/api/v1/auth/api-key')).send(payload)).status;
    expect(await Promise.all([
      send({ name: 'n'.repeat(name!.minLength! - 1) }),
      send({ name: 'n'.repeat(name!.maxLength!) }),
      send({ name: 'n'.repeat(name!.maxLength! + 1) }),
      send({ name: 'ci key', expiresInDays: expiresInDays!.minimum! - 1 }),
      send({ name: 'ci key', expiresInDays: expiresInDays!.maximum! }),
      send({ name: 'ci key', expiresInDays: expiresInDays!.maximum! + 1 }),
      send({ name: 'ci key', expiresInDays: 1.5 }),
    ])).toEqual([400, 200, 400, 400, 200, 400, 400]);
  });

  it('create answers 403 API keys are disabled with the declared body, and list and revoke keep working', async () => {
    const { app, bearer, repository } = build(false);
    const refused = await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'ci key' });
    expect([refused.status, refused.body]).toEqual([403, body(CREATE, 'post', '403').examples!['apiKeysDisabled']!.value]);
    expect(repository.rows).toHaveLength(0);

    repository.rows.push({ _id: 'k-1', _userId: 'user-1', _keyHash: 'h', _name: 'old', _role: 'operator', _enabled: true, _createdAt: new Date(), expiresAt: null, lastUsedAt: null, revoked: false });
    expect((await bearer(request(app).get('/api/v1/auth/api-keys'))).status).toBe(200);
    expect((await bearer(request(app).delete('/api/v1/auth/api-key/k-1'))).status).toBe(200);
  });

  it('list answers a bare array whose entries carry exactly the ApiKey properties; revoke answers the declared 200 body', async () => {
    const { app, bearer } = build(true);
    const created = await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'ci key', expiresInDays: 7 });
    const listed = await bearer(request(app).get('/api/v1/auth/api-keys'));
    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body).sort()).toEqual(keysOf(body(LIST, 'get', '200').schema!));
    expect(Array.isArray(listed.body.data)).toBe(true);
    expect(body(LIST, 'get', '200').schema!.properties!['data']).toMatchObject({ type: 'array', items: { $ref: '#/components/schemas/ApiKey' } });
    expect(listed.body.data).toHaveLength(1);
    expect(Object.keys(listed.body.data[0]).sort()).toEqual(keysOf(spec.components.schemas['ApiKey']!));
    expect(JSON.stringify(listed.body)).not.toContain(created.body.data._apiKey);

    const revoked = await bearer(request(app).delete(`/api/v1/auth/api-key/${created.body.data._id}`));
    const revokedSchema = body(REVOKE, 'delete', '200').schema!;
    expect([revoked.status, Object.keys(revoked.body).sort()]).toEqual([200, keysOf(revokedSchema)]);
    expect(revoked.body.message).toBe(exampleOf(revokedSchema.properties!['message']!));
    expect((await bearer(request(app).get('/api/v1/auth/api-keys'))).body.data).toEqual([]);
  });

  it('declares JWT-only security on the three key operations and keeps the documented defaults', async () => {
    // An own `security`, not inherited: deleting it would advertise the global list (API key accepted), `[]` would advertise a public route.
    for (const [path, method] of [[CREATE, 'post'], [LIST, 'get'], [REVOKE, 'delete']] as const) {
      expect(operation(path, method).security).toEqual([{ BearerAuth: [] }]);
    }
    expect(spec.security).toEqual(expect.arrayContaining([{ BearerAuth: [] }, { ApiKeyAuth: [] }]));
    expect(spec.components.securitySchemes['ApiKeyAuth']).toEqual(expect.objectContaining({ type: 'apiKey', in: 'header', name: 'X-API-Key' }));
    expect(spec.components.securitySchemes['BearerAuth']).toEqual(expect.objectContaining({ type: 'http', scheme: 'bearer' }));

    // The declared list omits ApiKeyAuth, so the stack must refuse an X-API-Key-only caller on each route.
    const { app, bearer } = build(true);
    const created = await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'ci key' });
    const key = created.body.data._apiKey as string;
    const refused = [
      await request(app).post('/api/v1/auth/api-key').set('X-API-Key', key).send({ name: 'chained' }),
      await request(app).get('/api/v1/auth/api-keys').set('X-API-Key', key),
      await request(app).delete(`/api/v1/auth/api-key/${created.body.data._id}`).set('X-API-Key', key),
    ];
    expect(refused.map(res => res.status)).toEqual([403, 403, 403]);
  });
});

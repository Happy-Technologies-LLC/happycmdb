// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// openapi.yaml API-key operations against the code that answers: the real AuthController, AuthService, AuthMiddleware
// and JWT signing over an in-memory repository that returns the shapes neo4j-auth.repository.ts returns.
import { join } from 'path';
import * as YAML from 'yamljs';
import express from 'express';
import request from 'supertest';
import { AuthController } from '../../rest/auth.controller';
import { AuthService, CredentialsChangedError, type AuthRepository } from '../../auth/auth.service';
import { ValidationMiddleware } from '../../rest/middleware/validation.middleware';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import type { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { JWTService } from '../../auth/jwt.service';
import type { ApiKey, User } from '../../auth/types';
import { logger } from '@cmdb/common';

type Schema = {
  $ref?: string; type?: string; nullable?: boolean; required?: string[]; pattern?: string; example?: string;
  properties?: Record<string, Schema>; items?: Schema; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[];
};
type Response = { $ref?: string; content?: { 'application/json': { schema?: Schema; example?: unknown; examples?: Record<string, { value: unknown }> } } };
type Operation = {
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
};
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as {
  paths: Record<string, Record<string, Operation>>;
  security: Array<Record<string, string[]>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Response>; securitySchemes: Record<string, Record<string, unknown>> };
};
const operation = (path: string, method: string): Operation => spec.paths[path]![method]!;
const body = (path: string, method: string, status: string) => operation(path, method).responses[status]!.content!['application/json'];
const declared = (path: string, method: string): string[] => Object.keys(operation(path, method).responses).sort();
const exampleOf = (schema: Schema): string | undefined => schema.example;
const keysOf = (schema: Schema): string[] => Object.keys(schema.properties!).sort();

/** Follows `$ref` (any `#/a/b/c` pointer into the spec) until a node that is not one. */
function deref<T extends { $ref?: string }>(node: T): T {
  if (!node.$ref) return node;
  return deref(node.$ref.replace('#/', '').split('/').reduce<any>((at, key) => at[key], spec));
}
/** The schema the spec declares for a response, whether the response is inline or a components/responses `$ref`. */
const declaredSchema = (path: string, method: string, status: string): Schema => deref(deref(operation(path, method).responses[status]!).content!['application/json'].schema!);

/**
 * A small JSON-schema check, enough for the keywords these response schemas use: $ref, type, nullable, enum, required, properties,
 * items, anyOf and oneOf (exactly one branch, as the spec means it). ajv is only a transitive dependency of the lint stack (v6), so it is
 * not imported here. Returns the violations; empty means the value satisfies the schema.
 */
function violations(schema: Schema, value: unknown, at = '$'): string[] {
  const node = deref(schema);
  if (value === null && node.nullable) return [];
  const found: string[] = [];
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (node.type && !(node.type === kind || (node.type === 'integer' && Number.isInteger(value)))) found.push(`${at}: expected ${node.type}, got ${kind}`);
  if (node.enum && !node.enum.includes(value)) found.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
  if (kind === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of node.required ?? []) if (!(key in object)) found.push(`${at}: missing ${key}`);
    for (const [key, child] of Object.entries(node.properties ?? {})) if (key in object) found.push(...violations(child, object[key], `${at}.${key}`));
  }
  if (kind === 'array' && node.items) (value as unknown[]).forEach((item, index) => found.push(...violations(node.items!, item, `${at}[${index}]`)));
  if (node.anyOf && !node.anyOf.some(branch => violations(branch, value, at).length === 0)) found.push(`${at}: matches no anyOf branch`);
  if (node.oneOf) {
    const matched = node.oneOf.filter(branch => violations(branch, value, at).length === 0).length;
    if (matched !== 1) found.push(`${at}: matches ${matched} oneOf branches, exactly 1 required`);
  }
  return found;
}

const CREATE = '/auth/api-key';
const LIST = '/auth/api-keys';
const REVOKE = '/auth/api-key/{keyId}';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
/** `/auth/api-key`, `/auth/api-key/*`, `/auth/api-keys` and `/auth/api-keys/*`; nothing else under /auth (`/auth/api-keyring` is not one). */
const isKeyPath = (path: string): boolean => /^\/auth\/api-keys?(\/|$)/.test(path);

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
  return { app, controller, repository, bearer };
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

    // A store failure (500) is not reachable with this fake; the next test breaks the fake to send it for revoke.
    for (const [kind, path, method] of [['create', CREATE, 'post'], ['list', LIST, 'get'], ['revoke', REVOKE, 'delete']] as const) {
      const missing = [...observed[kind]].map(String).filter(status => !declared(path, method).includes(status));
      expect(missing).toEqual([]);
    }
    expect(declared(CREATE, 'post')).toEqual(expect.arrayContaining(['200', '400', '401', '403']));
    expect(declared(CREATE, 'post')).not.toContain('201');
    expect(declared(REVOKE, 'delete')).toEqual(expect.arrayContaining(['200', '401', '403', '404']));
    expect(declared(REVOKE, 'delete')).toContain('500');
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

  it('declares JWT-only security on every API-key operation in the spec and keeps the documented defaults', () => {
    // Derived from the spec so a new key operation (a rotate endpoint, say) is caught here instead of passing unchecked.
    const keyOperations = Object.entries(spec.paths)
      .filter(([path]) => isKeyPath(path))
      .flatMap(([path, item]) => METHODS.filter(method => item[method]).map(method => [path, method] as const));
    const instruction = 'A new API-key operation is in openapi.yaml: decide its security (JWT-only like the others, or deliberately different), add a runtime refusal test for it, then extend this list.';
    expect({ instruction, operations: keyOperations.map(([path, method]) => `${method.toUpperCase()} ${path}`).sort() })
      .toEqual({ instruction, operations: [`DELETE ${REVOKE}`, `GET ${LIST}`, `POST ${CREATE}`] });

    // An own `security`, not inherited: deleting it would advertise the global list (API key accepted), `[]` would advertise a public route.
    for (const [path, method] of keyOperations) {
      expect({ path, method, security: operation(path, method).security }).toEqual({ path, method, security: [{ BearerAuth: [] }] });
    }
    expect(spec.security).toEqual(expect.arrayContaining([{ BearerAuth: [] }, { ApiKeyAuth: [] }]));
    // The literal is the documented default; the runtime default is API_KEY_HEADER_NAME in packages/common/src/config/config.loader.ts,
    // pinned by packages/common/tests/unit/config.loader.api-keys-enabled.test.ts. Change all three together.
    expect(spec.components.securitySchemes['ApiKeyAuth']).toEqual(expect.objectContaining({ type: 'apiKey', in: 'header', name: 'X-API-Key' }));
    expect(spec.components.securitySchemes['BearerAuth']).toEqual(expect.objectContaining({ type: 'http', scheme: 'bearer' }));
    // The runtime refusal of an X-API-Key-only caller on each route is pinned by the first test.
  });

  it('documents exactly the key-management routes the AuthController registers', () => {
    // The spec-derived test above only sees what the spec documents; a route added to the controller alone is invisible to it.
    // Express's ILayer/IRoute typings omit route.methods, which is set at runtime.
    type Layer = { route?: { path: string; methods: Record<string, boolean> } };
    const MOUNT = '/auth'; // server.ts: /api/v1 + this; spec servers carry /api/v1
    const router = build(true).controller.getRouter() as unknown as { stack: Layer[] };
    const registered = router.stack
      .flatMap(layer => (layer.route ? Object.entries(layer.route.methods).filter(([, on]) => on).map(([method]) => `${method.toUpperCase()} ${MOUNT + layer.route!.path}`.replace(/:(\w+)/g, '{$1}')) : []))
      .filter(operation => isKeyPath(operation.slice(operation.indexOf(' ') + 1)))
      .sort();
    const documented = Object.entries(spec.paths)
      .filter(([path]) => isKeyPath(path))
      .flatMap(([path, item]) => METHODS.filter(method => item[method]).map(method => `${method.toUpperCase()} ${path}`))
      .sort();
    expect(registered).toEqual([`DELETE ${REVOKE}`, `GET ${LIST}`, `POST ${CREATE}`]);
    expect(documented).toEqual(registered);
  });

  it('every 401 and 403 body the stack sends on the three routes satisfies the declared response schema', async () => {
    const { app, bearer } = build(true);
    const disabled = build(false);
    const created = await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'ci key' });
    const key = created.body.data._apiKey as string;
    const keyId = created.body.data._id as string;

    // The middleware always stamps the credential generation from the stored user, so the service refusal is reached only by making
    // the service throw it; the controller's own refusal mapping then answers.
    const credentialsChanged = async () => {
      const refusal = jest.spyOn(AuthService.prototype, 'generateApiKey').mockRejectedValueOnce(new CredentialsChangedError());
      const res = await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'ci key' });
      refusal.mockRestore();
      return res;
    };
    const sent: Array<[string, string, string, request.Response]> = [
      [CREATE, 'post', '401', await request(app).post('/api/v1/auth/api-key').send({ name: 'ci key' })],
      [LIST, 'get', '401', await request(app).get('/api/v1/auth/api-keys')],
      [REVOKE, 'delete', '401', await request(app).delete(`/api/v1/auth/api-key/${keyId}`)],
      [CREATE, 'post', '401', await credentialsChanged()],
      [CREATE, 'post', '403', await request(app).post('/api/v1/auth/api-key').set('X-API-Key', key).send({ name: 'chained' })],
      [LIST, 'get', '403', await request(app).get('/api/v1/auth/api-keys').set('X-API-Key', key)],
      [REVOKE, 'delete', '403', await request(app).delete(`/api/v1/auth/api-key/${keyId}`).set('X-API-Key', key)],
      [CREATE, 'post', '403', await disabled.bearer(request(disabled.app).post('/api/v1/auth/api-key')).send({ name: 'ci key' })],
    ];
    expect(sent.map(([, , status, res]) => [status, res.status])).toEqual(sent.map(([, , status]) => [status, Number(status)]));
    expect(sent[3]![3].body).toEqual({ success: false, error: 'Unauthorized', message: 'Credentials changed' });
    expect(sent[7]![3].body).toEqual({ success: false, error: 'Forbidden', message: 'API keys are disabled' });

    for (const [path, method, status, res] of sent) {
      expect({ path, status, violations: violations(declaredSchema(path, method, status), res.body) }).toEqual({ path, status, violations: [] });
    }

    // The check is not vacuous: a 403 that lost `code`, and a 401 that mixes both key families, are refused.
    const jwtRequired = sent[5]![3].body as Record<string, unknown>;
    const { code: _code, ...withoutCode } = jwtRequired;
    expect(violations(declaredSchema(LIST, 'get', '403'), withoutCode)).not.toEqual([]);
    expect(violations(declaredSchema(CREATE, 'post', '401'), { ...sent[3]![3].body, _error: 'Unauthorized', _message: 'x' })).not.toEqual([]);
  });

  it('revoke answers the declared 500 body when the store fails', async () => {
    const { app, bearer, repository } = build(true);
    repository.deleteApiKey = async () => { throw new Error('Failed to delete API key: invalid input syntax for type uuid: "none"'); };
    const failed = await bearer(request(app).delete('/api/v1/auth/api-key/none'));
    expect([failed.status, failed.body]).toEqual([500, body(REVOKE, 'delete', '500').example]);
    expect(violations(declaredSchema(REVOKE, 'delete', '500'), failed.body)).toEqual([]);
    expect(JSON.stringify(failed.body)).not.toContain('uuid');
  });
});

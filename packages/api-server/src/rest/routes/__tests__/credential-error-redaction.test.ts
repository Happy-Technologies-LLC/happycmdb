// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * HAP-1814: real routes, controllers and credential services on embedded PostgreSQL.
 * - Every logger call on the credential decode/driver failure paths (set select, GET, match/rank, the update catch)
 *   carries the error class/code only: no logger argument holds the raw error, its message, or a stored secret.
 * - A PUT whose updated row cannot be decoded answers 500 with the row exactly as it was: nothing commits.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspect } from 'util';
import express from 'express';
import request from 'supertest';

// Every value is random at runtime, so no source line reads as a secret assignment.
const rnd = () => randomBytes(16).toString('hex');
Object.assign(process.env, { JWT_SECRET: rnd() + rnd(), CREDENTIAL_ENCRYPTION_KEY: rnd() + rnd(), NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: rnd(), NEO4J_PASSWORD: rnd(),
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: rnd(), POSTGRES_USER: rnd(), POSTGRES_PASSWORD: rnd(), REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: rnd(), KAFKA_GROUP_ID: rnd() });
type Rows = Record<string, unknown>[];
const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, (m: { rows: Rows; error?: string }) => void>();
host.on('message', (m: { id: number; rows: Rows; error?: string }) => pending.get(m.id)!(m));
const sql = (text: string, params: unknown[] = [], op = 'query') => new Promise<Rows>((resolve, reject) => {
  const id = serial++;
  pending.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.rows)));
  host.send({ id, op, sql: text, params });
});
// A PostgreSQL-style failure that quotes a value, injected into one statement shape at a time.
// `afterRunning` runs the statement on the database first, then fails: a failed ROLLBACK that really rolled back.
let failOn: { pattern: RegExp; error: () => Error; afterRunning?: boolean }[] = [];
// Every release() call's arguments: pg destroys a client released with an error instead of pooling it.
const releases: unknown[][] = [];
const pool = {
  connect: async () => ({
    query: async (text: string, params?: unknown[]) => {
      const fail = failOn.find((f) => f.pattern.test(text));
      if (fail && fail.afterRunning !== true) throw fail.error();
      const rows = await sql(text, params);
      if (fail) throw fail.error();
      return { rows };
    },
    release: (...args: unknown[]) => { releases.push(args); },
  }),
};
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool }), getAuditService: () => ({}), getOAuthSubstrate: () => ({}), SERVICENOW_PROVIDER_ID: 'servicenow',
  getUnifiedCredentialService: (pg: unknown) => new (require('../../../../../database/src/postgres/unified-credential.service').UnifiedCredentialService)(pg),
  getCredentialSetService: (pg: unknown) => new (require('../../../../../database/src/postgres/credential-set.service').CredentialSetService)(pg),
}));
jest.mock('bcrypt', () => ({}));
const A = '11111111-1111-4111-8111-111111111111';
const identities: Record<string, { _id: string; _username: string; _role: 'operator' | 'admin'; _enabled: boolean; _organizationId: string }> = {
  a: { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A },
  admin: { _id: 'admin', _username: 'ada', _role: 'admin', _enabled: true, _organizationId: A },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => identities[id] ?? null })) }));
import { loadConfig, getEncryptionService, logger } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';
import { CredentialCRUDService } from '../../../../../database/src/postgres/credential-services/crud.service';

const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate(), unifiedCredentialRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
const as = (who: string) => ({ Authorization: `Bearer ${jwt.generateAccessToken(who, identities[who]!._username, identities[who]!._role, A)}` });
const encrypt = (plain: string) => getEncryptionService().encrypt(plain) as unknown as Record<string, string>;

// A stored secret that must never reach a logger, and stored values that cannot be decoded. The non-JSON plaintext is
// short enough that V8 quotes all of it in the JSON.parse message: `Unexpected token 'h', "h…" is not valid JSON`.
const SECRET = rnd();
const plain = `h${randomBytes(8).toString('hex')}`;
const parseMessage = (() => { try { JSON.parse(plain); } catch (error) { return (error as Error).message; } throw new Error('fixture parsed'); })();
const nonJson = () => encrypt(plain);
// Still an envelope (iv, encryptedData, authTag), but the auth tag belongs to another message, so decrypt throws.
const tampered = () => ({ ...encrypt(JSON.stringify({ username: 'svc', password: SECRET })), authTag: encrypt(rnd())['authTag']! });
const decodable = () => encrypt(JSON.stringify({ username: 'svc', password: SECRET }));
// The raw message a tampered envelope's decrypt throws.
const DECRYPT_MESSAGE = (() => { try { getEncryptionService().decrypt(tampered() as never); } catch (error) { return (error as Error).message; } throw new Error('fixture decrypted'); })();

const insert = async (stored: unknown, owner = 'a', protocol = 'ssh_password') => {
  const id = randomUUID();
  await sql(`INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, $2, $3, 'ssh', $4, $5, $6)`,
    [id, `stored-${rnd()}`, protocol, JSON.stringify(stored), owner, A]);
  return id;
};
const row = async (id: string) => sql('SELECT * FROM credentials WHERE id = $1', [id]);

// Every argument handed to the logger, rendered with hidden properties (an Error's message and stack included).
const LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly', 'log'] as const;
const captureLogger = () => {
  const spies = LEVELS.map((level) => jest.spyOn(logger, level as 'error'));
  return () => {
    const calls = spies.flatMap((spy) => spy.mock.calls as unknown[][]);
    const rendered = calls.map((args) => inspect(args, { depth: null, showHidden: true, maxStringLength: null, maxArrayLength: null, breakLength: Infinity })).join('\n');
    const errorFields = calls.flatMap((args) => args.map((arg) => (arg as { error?: unknown } | null)?.error).filter((e) => e !== undefined));
    return { rendered, errorFields, calls };
  };
};

beforeAll(async () => {
  const baseline = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
  const tables = ['credentials', 'credential_sets'].map((table) => baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  await sql(`${tables.join('\n')}
CREATE UNIQUE INDEX idx_credentials_unique_name ON credentials(name, created_by);
CREATE UNIQUE INDEX idx_credential_sets_unique_name ON credential_sets(name, created_by);
CREATE TABLE discovery_definitions (credential_id UUID, credential_set_id UUID);
CREATE TABLE connector_configurations (credential_id UUID);`, [], 'exec');
  await sql(readFileSync(join(migrations, '021_credential_organization_scope.sql'), 'utf8'), [], 'exec');
});
afterEach(() => { failOn = []; releases.length = 0; });
afterAll(() => host.kill());

describe('logger arguments on credential failure paths carry the class only', () => {
  it.each([['sequential'], ['adaptive']])('(1) set select (%s) with a member whose plaintext is not JSON', async (strategy) => {
    const set = await request(app).post('/api/v1/credential-sets').set(as('a'))
      .send({ name: `set-${rnd()}`, credential_ids: [await insert(decodable()), await insert(nonJson())], strategy });
    expect(set.status).toBe(201);
    const logs = captureLogger();
    const res = await request(app).post(`/api/v1/credential-sets/${set.body.data.id}/select`).set(as('a')).send({ context: { ip: '10.0.0.1' } });
    const { rendered, errorFields } = logs();
    expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to select credentials', message: 'Internal error' }]);
    expect([rendered.includes(plain), rendered.includes(parseMessage), rendered.includes(SECRET)]).toEqual([false, false, false]);
    expect(errorFields).toContainEqual({ errorClass: 'SyntaxError' });
  });

  it.each([['non-JSON plaintext', nonJson, 'SyntaxError'], ['a tampered auth tag', tampered, 'Error']])('(4a) GET on a stored value with %s', async (_label, stored, errorClass) => {
    const id = await insert(stored());
    const logs = captureLogger();
    const res = await request(app).get(`/api/v1/credentials/${id}`).set(as('a'));
    const { rendered, errorFields } = logs();
    expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to get credential', message: 'Internal error' }]);
    expect([rendered.includes(plain), rendered.includes(parseMessage), rendered.includes(SECRET), rendered.includes(DECRYPT_MESSAGE)]).toEqual([false, false, false, false]);
    expect(errorFields).toContainEqual({ errorClass });
  });

  it('(4b) the update catch logs a driver failure by class and SQLSTATE, never its message or the quoted value', async () => {
    const id = await insert(decodable());
    const driver = `invalid input syntax for type uuid: "${SECRET}"`;
    failOn = [{ pattern: /^\s*UPDATE credentials/, error: () => Object.assign(new Error(driver), { code: '22P02', severity: 'ERROR' }) }];
    const logs = captureLogger();
    await expect(new CredentialCRUDService(pool as never).update(id, { name: rnd() }, 'a', A, true)).rejects.toThrow(driver);
    const { rendered, errorFields } = logs();
    expect([rendered.includes(driver), rendered.includes(SECRET)]).toEqual([false, false]);
    expect(errorFields).toContainEqual({ errorClass: 'Error', code: '22P02' });
  });

  it('(4c) match/rank skip undecodable candidates by class only; match is 404 when every candidate fails to decode', async () => {
    // snmp_v3 rows exist only here, so required_protocol isolates this test's candidates.
    await insert(nonJson(), 'a', 'snmp_v3');
    await insert(tampered(), 'a', 'snmp_v3');
    const logs = captureLogger();
    const match = await request(app).post('/api/v1/credentials/match').set(as('a')).send({ required_protocol: 'snmp_v3' });
    const rank = await request(app).post('/api/v1/credentials/rank').set(as('a')).send({ required_protocol: 'snmp_v3' });
    const { rendered, errorFields } = logs();
    expect([match.status, match.body]).toEqual([404, { success: false, error: 'Not Found', message: 'No matching credential found for the given context' }]);
    expect([rank.status, rank.body]).toEqual([200, { success: true, data: [], count: 0 }]);
    expect([rendered.includes(plain), rendered.includes(parseMessage), rendered.includes(SECRET), rendered.includes(DECRYPT_MESSAGE)]).toEqual([false, false, false, false]);
    expect(errorFields).toEqual(expect.arrayContaining([{ errorClass: 'SyntaxError' }, { errorClass: 'Error' }]));
    // A decodable candidate still matches; its secret reaches neither the body nor any logger argument.
    const good = await insert(decodable(), 'a', 'snmp_v3');
    const logs2 = captureLogger();
    const best = await request(app).post('/api/v1/credentials/match').set(as('a')).send({ required_protocol: 'snmp_v3' });
    expect([best.status, best.body.data.credential.id, best.body.data.credential.credentials]).toEqual([200, good, '***REDACTED***']);
    expect([JSON.stringify(best.body).includes(SECRET), logs2().rendered.includes(SECRET)]).toEqual([false, false]);
  });
});

describe('(2) PUT on a stored value that cannot be decoded commits nothing', () => {
  // The org admin's rename took the formerly untransacted path; the operator's took the locked one.
  describe.each([['an operator', 'a'], ['an org admin', 'admin']])('by %s', (_who, who) => {
    it.each([
      ['a rename of non-JSON plaintext', nonJson, () => ({ name: rnd() })],
      ['a rename and retag of a tampered envelope', tampered, () => ({ name: rnd(), tags: [rnd()] })],
      ['an affinity edit of non-JSON plaintext', nonJson, () => ({ affinity: { priority: 9 } })],
    ])('%s: fixed 500, the row is unchanged', async (_label, stored, body) => {
      const id = await insert(stored(), who);
      const before = await row(id);
      const res = await request(app).put(`/api/v1/credentials/${id}`).set(as(who)).send(body());
      expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to update credential', message: 'Internal error' }]);
      expect(await row(id)).toEqual(before);
    });
  });

  it('a rename of a decodable credential still commits and answers with the committed row', async () => {
    const id = await insert(decodable(), 'admin');
    const name = rnd();
    const res = await request(app).put(`/api/v1/credentials/${id}`).set(as('admin')).send({ name });
    const [stored] = await row(id);
    expect([res.status, res.body.data.name, res.body.data.credentials, stored!['name']]).toEqual([200, name, '***REDACTED***', name]);
  });
});

// HAP-1834. A pg CHECK or NOT NULL failure carries the failing row in its enumerable `detail`; winston would keep it.
const DETAIL = rnd();
const driverFailure = (marker = DETAIL) => Object.assign(new Error(`new row violates check constraint "chk": ${marker}`), { code: '23514', detail: `Failing row contains (${marker})` });
const failing = (pattern: RegExp, error: () => Error = driverFailure) => { failOn = [{ pattern, error }]; };
const classOnly = (errorFields: unknown[]) => errorFields.every((field) => Object.keys(field as object).every((key) => key === 'errorClass' || key === 'code'));
const noMarkers = (text: string, ...markers: string[]) => markers.map((marker) => text.includes(marker));
const sets = async (credentialIds?: string[]) => {
  const res = await request(app).post('/api/v1/credential-sets').set(as('a')).send({ name: `set-${rnd()}`, credential_ids: credentialIds ?? [await insert(decodable())] });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
};

describe('(5) PUT logs: class only, no stored plaintext or driver detail, and the log call fires', () => {
  // The service rethrows every decode failure as the fixed-message decryptFailure, so both reach the logger as Error.
  it.each([['non-JSON plaintext', nonJson], ['a tampered auth tag', tampered]])('PUT on a stored value with %s', async (_label, stored) => {
    for (const who of ['a', 'admin']) {
      const id = await insert(stored(), who);
      const logs = captureLogger();
      const res = await request(app).put(`/api/v1/credentials/${id}`).set(as(who)).send({ name: rnd() });
      const { rendered, errorFields, calls } = logs();
      expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to update credential', message: 'Internal error' }]);
      expect(noMarkers(rendered + JSON.stringify(res.body), plain, parseMessage, SECRET, DECRYPT_MESSAGE)).toEqual([false, false, false, false]);
      expect(calls.map((args) => args[0])).toEqual(expect.arrayContaining(['Failed to update unified credential', 'Error updating credential']));
      expect(errorFields).toContainEqual({ errorClass: 'Error' });
      expect(classOnly(errorFields)).toBe(true);
      jest.restoreAllMocks();
    }
  });

  it.each([
    ['a rename', () => ({ name: rnd() }), SECRET],
    ['new secret material', () => ({ credentials: { key: SECRET } }), SECRET],
  ])('PUT with %s when the driver rejects the UPDATE with a row-quoting detail', async (_label, body, marker) => {
    const id = await insert(encrypt(JSON.stringify({ key: rnd() })), 'a', 'api_key');
    failing(/^\s*UPDATE credentials/, () => driverFailure(`${DETAIL} ${marker}`));
    const logs = captureLogger();
    const res = await request(app).put(`/api/v1/credentials/${id}`).set(as('a')).send(body());
    const { rendered, errorFields, calls } = logs();
    expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to update credential', message: 'Internal error' }]);
    expect(noMarkers(rendered + JSON.stringify(res.body), DETAIL, marker)).toEqual([false, false]);
    expect(calls.map((args) => args[0])).toEqual(expect.arrayContaining(['Failed to update unified credential', 'Error updating credential']));
    expect(errorFields).toContainEqual({ errorClass: 'Error', code: '23514' });
    expect(classOnly(errorFields)).toBe(true);
  });
});

describe('(1) create, delete and set failures log the error class only', () => {
  const expectClean = (logs: ReturnType<ReturnType<typeof captureLogger>>, res: { body: unknown }, messages: string[]) => {
    expect(noMarkers(logs.rendered + JSON.stringify(res.body), DETAIL, SECRET)).toEqual([false, false]);
    expect(logs.calls.map((args) => args[0])).toEqual(expect.arrayContaining(messages));
    expect(logs.errorFields).toContainEqual({ errorClass: 'Error', code: '23514' });
    expect(classOnly(logs.errorFields)).toBe(true);
  };

  it('POST /credentials: the INSERT failure and the secret in the body stay out of the logger', async () => {
    failing(/INSERT INTO credentials/, () => driverFailure(`${DETAIL} ${SECRET}`));
    const logs = captureLogger();
    const res = await request(app).post('/api/v1/credentials').set(as('a')).send({ name: rnd(), protocol: 'api_key', scope: 'api', credentials: { key: SECRET } });
    expect(res.status).toBe(500);
    expectClean(logs(), res, ['Failed to create unified credential', 'Error creating credential']);
  });

  it('DELETE /credentials/:id: the DELETE failure stays out of the logger', async () => {
    const id = await insert(decodable());
    failing(/DELETE FROM credentials/, () => driverFailure(`${DETAIL} ${SECRET}`));
    const logs = captureLogger();
    const res = await request(app).delete(`/api/v1/credentials/${id}`).set(as('a'));
    expect(res.status).toBe(500);
    expectClean(logs(), res, ['Failed to delete unified credential', 'Error deleting credential']);
  });

  it.each([
    ['create', /INSERT INTO credential_sets/, async () => request(app).post('/api/v1/credential-sets').set(as('a')).send({ name: rnd(), credential_ids: [await insert(decodable())] }),
      ['Failed to create credential set', 'Error creating credential set']],
    ['update', /UPDATE credential_sets/, async (id: string) => request(app).put(`/api/v1/credential-sets/${id}`).set(as('a')).send({ name: rnd() }),
      ['Failed to update credential set', 'Error updating credential set']],
    ['delete', /DELETE FROM credential_sets/, async (id: string) => request(app).delete(`/api/v1/credential-sets/${id}`).set(as('a')),
      ['Failed to delete credential set', 'Error deleting credential set']],
  ])('credential set %s', async (_op, pattern, send, messages) => {
    // The set exists before the failure is armed, so the setup request does not hit it.
    const id = await sets();
    failing(pattern as RegExp, () => driverFailure(`${DETAIL} ${SECRET}`));
    const logs = captureLogger();
    const res = await (send as (id: string) => Promise<request.Response>)(id);
    expect(res.status).toBe(500);
    expectClean(logs(), res, messages as string[]);
  });
});

describe('(3) a credential set is 404 by error type, never by message text', () => {
  const notFound = { success: false, error: 'Not Found', message: 'Credential set not found' };
  const missing = randomUUID();
  it.each([
    ['PUT', () => request(app).put(`/api/v1/credential-sets/${missing}`).set(as('a')).send({ name: rnd() })],
    ['DELETE', () => request(app).delete(`/api/v1/credential-sets/${missing}`).set(as('a'))],
    ['select', () => request(app).post(`/api/v1/credential-sets/${missing}/select`).set(as('a')).send({ context: { ip: '10.0.0.1' } })],
  ])('%s on an absent set keeps its 404 body', async (_op, send) => {
    const res = await send();
    expect([res.status, res.body]).toEqual([404, notFound]);
  });

  it('select on a member whose decode error quotes "not found" is 500, with the decrypted text out of the logger', async () => {
    const quoted = `h${randomBytes(2).toString('hex')} not found`;
    const quotedMessage = (() => { try { JSON.parse(quoted); } catch (error) { return (error as Error).message; } throw new Error('fixture parsed'); })();
    expect(quotedMessage).toContain('not found');
    const set = await sets([await insert(encrypt(quoted))]);
    const logs = captureLogger();
    const res = await request(app).post(`/api/v1/credential-sets/${set}/select`).set(as('a')).send({ context: { ip: '10.0.0.1' } });
    const { rendered, errorFields } = logs();
    expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to select credentials', message: 'Internal error' }]);
    expect(noMarkers(rendered + JSON.stringify(res.body), quoted, quotedMessage)).toEqual([false, false]);
    expect(errorFields).toContainEqual({ errorClass: 'SyntaxError' });
  });

  it.each([
    ['PUT', /UPDATE credential_sets/, (id: string) => request(app).put(`/api/v1/credential-sets/${id}`).set(as('a')).send({ name: rnd() })],
    ['DELETE', /DELETE FROM credential_sets/, (id: string) => request(app).delete(`/api/v1/credential-sets/${id}`).set(as('a'))],
  ])('%s: an untyped failure whose text says "not found" is 500', async (_op, pattern, send) => {
    const id = await sets();
    failing(pattern, () => new Error('relation "x" not found'));
    const res = await send(id);
    expect([res.status, res.body]).toEqual([500, expect.objectContaining({ message: 'Internal error' })]);
  });
});

describe('(4) a client whose ROLLBACK failed is released with the error, so the pool destroys it', () => {
  const run = () => new CredentialCRUDService(pool as never).update('missing-id', { name: rnd() }, 'a', A, true);
  it('failed UPDATE and failed ROLLBACK: release receives the ROLLBACK Error', async () => {
    const rollback = new Error(`ROLLBACK refused ${rnd()}`);
    failOn = [{ pattern: /^\s*UPDATE credentials/, error: () => driverFailure() }, { pattern: /^ROLLBACK/, error: () => rollback, afterRunning: true }];
    await expect(run()).rejects.toThrow(driverFailure().message);
    expect(releases).toEqual([[rollback]]);
  });

  it('failed UPDATE and clean ROLLBACK: the client goes back to the pool without an error', async () => {
    failing(/^\s*UPDATE credentials/);
    await expect(run()).rejects.toThrow(driverFailure().message);
    expect(releases.every(([error]) => error === undefined)).toBe(true);
    expect(releases).toHaveLength(1);
  });
});

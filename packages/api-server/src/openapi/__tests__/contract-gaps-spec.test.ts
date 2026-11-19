// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// openapi.yaml against the code that answers (real ciRoutes, CIController, sendJournalError and JWT auth over a fake graph; the estate feed controllers).
import { randomBytes } from 'crypto';
import { join } from 'path';
import * as YAML from 'yamljs';
import express, { type Request, type Response } from 'express';
import request from 'supertest';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});
const ORG = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

const mockScenario = {
  delete: async (): Promise<boolean> => true,
  properties: async (): Promise<Record<string, unknown> | null> => ({ name: 'ci' }),
  gap: false,
};
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
jest.mock('@cmdb/database', () => ({
  ...jest.requireActual('@cmdb/database'),
  getNeo4jClient: () => ({ deleteOversizedCI: () => mockScenario.delete(), getCIProperties: () => mockScenario.properties() }),
  getPostgresClient: () => ({
    query: async () => ({ rows: mockScenario.gap ? [{ one: 1 }] : [] }),
    transaction: async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
  }),
}));
const mockUser = (id: string, role: 'admin' | 'operator' | 'viewer', org?: string) =>
  ({ _id: id, _username: id, _role: role, _enabled: true, _organizationId: org });
const mockUsers: Record<string, ReturnType<typeof mockUser>> = {
  admin: mockUser('u-admin', 'admin', ORG), operator: mockUser('u-op', 'operator', ORG),
  viewer: mockUser('u-view', 'viewer', ORG), noOrg: mockUser('u-none', 'admin'),
};
jest.mock('../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(mockUsers).find(user => user._id === id) ?? null,
    findApiKeyByKey: async () => null,
  })),
}));

import { loadConfig, logger, SourceOwnedError } from '@cmdb/common';
import {
  JournalAbortedError, JournalConflictError, JournalGapError, JournalTargetMissingError, JournalUnavailableError,
  PlanUnrepresentableError, enc,
} from '@cmdb/database';
import { assertPlanRepresentable, boundOversizedSnapshot } from '../../../../database/src/journal/encoding';
import { JWTService } from '../../auth/jwt.service';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { ciRoutes } from '../../rest/routes/ci.routes';
import { readEstateKpis } from '../../services/estate-kpi.service';
import { ESTATE_FEED_LIMIT_RESPONSE } from '../../services/bounded-pg-read';
import { BusinessServiceController } from '../../rest/controllers/business-service.controller';
import { ITILController } from '../../rest/controllers/itil.controller';

type Operation = { description?: string; requestBody?: { content: { 'application/json': { schema: { required: string[];
  properties: { evidence_ref: { minLength: number; maxLength: number } } } } } }; responses: Record<string, {
  description?: string; content?: { 'application/json': { examples?: Record<string, { value: unknown }> } } }> };
const spec = YAML.load(join(__dirname, '../openapi.yaml')) as { paths: Record<string, Record<string, Operation>> };
const operation = (path: string, method: string): Operation => spec.paths[path]![method]!;
const declared = (path: string, method: string): string[] => Object.keys(operation(path, method).responses).sort();

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
const authed = (req: request.Test, name: string | null): request.Test => {
  const user = name ? mockUsers[name]! : null;
  return user ? req.set('authorization', `Bearer ${jwt.generateAccessToken(user._id, user._username, user._role, user._organizationId, 0, Math.floor(Date.now() / 1000))}`) : req;
};
const recover = (body: unknown, user: string | null = 'admin', id = 'ci-1') =>
  authed(request(app).post(`/api/v1/cis/${id}/oversized-delete`), user).send(body as object);
const storedProperties = (user: string | null = 'admin') => authed(request(app).get('/api/v1/cis/ci-1/stored-properties'), user);
const throwing = (error: Error) => async (): Promise<boolean> => { throw error; };
const EVIDENCE = { evidence_ref: 'vault://evidence/ci-1' };

beforeEach(() => {
  mockScenario.delete = async () => true;
  mockScenario.properties = async () => ({ name: 'ci' });
  mockScenario.gap = false;
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /cis/{id}/oversized-delete (HAP-797)', () => {
  it('declares exactly the statuses the route stack sends; an operator and a viewer are refused, so admin only', async () => {
    const observed = new Set<number>();
    const send = async (user: string | null, body: unknown = EVIDENCE, id?: string) => {
      const res = await recover(body, user, id);
      observed.add(res.status);
      return res.status;
    };
    const refused: Array<[string | null, unknown?, string?]> = [
      [null], ['viewer'], ['operator'], ['noOrg'], ['admin', {}], ['admin', { evidence_ref: '' }], ['admin', EVIDENCE, 'a'.repeat(300)],
    ];
    for (const [user, body, id] of refused) await send(user, body, id);
    const outcomes: Array<[() => Promise<boolean>, number]> = [
      [async () => true, 204], [async () => false, 404], [throwing(new JournalTargetMissingError()), 404],
      [throwing(new JournalConflictError('not_oversized')), 409], [throwing(new JournalGapError()), 409],
      [throwing(new JournalAbortedError()), 409], [throwing(new SourceOwnedError()), 409],
      [throwing(new PlanUnrepresentableError()), 422], [throwing(new JournalUnavailableError()), 503], [throwing(new Error('boom')), 500],
    ];
    for (const [deleteCI, status] of outcomes) {
      mockScenario.delete = deleteCI;
      expect(await send('admin')).toBe(status);
    }
    expect([...observed].map(String).sort()).toEqual(declared('/cis/{id}/oversized-delete', 'post'));
    // The role gate itself: operator and viewer are each 403 and never reach the delete; admin passes the gate.
    const deleteCI = jest.fn(async () => true);
    mockScenario.delete = deleteCI;
    expect(await Promise.all(['operator', 'viewer'].map(user => recover(EVIDENCE, user).then(res => res.status)))).toEqual([403, 403]);
    expect(deleteCI).not.toHaveBeenCalled();
    expect((await recover(EVIDENCE, 'admin')).status).toBe(204);
    expect(deleteCI).toHaveBeenCalledTimes(1);
    expect(operation('/cis/{id}/oversized-delete', 'post').description).toMatch(/Admin role only/);
  });

  it('declares the evidence_ref bounds the route enforces: one below the minimum and one above the maximum are 400', async () => {
    const schema = operation('/cis/{id}/oversized-delete', 'post').requestBody!.content['application/json'].schema;
    const { minLength, maxLength } = schema.properties.evidence_ref;
    const lengths = [minLength - 1, minLength, maxLength, maxLength + 1];
    expect(await Promise.all(lengths.map(length => recover({ evidence_ref: 'e'.repeat(length) }).then(res => res.status)))).toEqual([400, 204, 204, 400]);
  });

  it('answers the not_oversized 409 with exactly the body its example declares', async () => {
    mockScenario.delete = throwing(new JournalConflictError('not_oversized'));
    const res = await recover(EVIDENCE);
    const examples = operation('/cis/{id}/oversized-delete', 'post').responses['409']!.content!['application/json'].examples!;
    expect([res.status, res.body]).toEqual([409, examples['notOversized']!.value]);
  });

  it('documents the rule behind it: more than 1000 properties and no oversized value is unplannable yet has nothing to replace', () => {
    const props = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`p${index}`, 'v']));
    expect(() => assertPlanRepresentable(enc(props))).toThrow(PlanUnrepresentableError);
    expect(boundOversizedSnapshot(props).oversized).toEqual([]);
    const { description } = operation('/cis/{id}/oversized-delete', 'post');
    expect(description).toMatch(/more than 1000\s+stored properties and no oversized value/);
  });
});

describe('GET /cis/{id}/stored-properties (HAP-797)', () => {
  it('declares exactly the statuses the route stack sends', async () => {
    const observed = new Set<number>();
    const send = async (user: string | null = 'admin') => { const res = await storedProperties(user); observed.add(res.status); return res; };
    for (const user of [null, 'viewer', 'operator', 'noOrg']) await send(user);
    expect((await send()).body).toEqual({ success: true, data: { id: 'ci-1', properties: enc({ name: 'ci' }) } });
    mockScenario.properties = async () => null;
    expect((await send()).status).toBe(404);
    mockScenario.properties = async () => ({ name: 'ci' });
    mockScenario.gap = true;
    const gap = await send();
    expect([gap.status, gap.body]).toEqual([409, { success: false, error: 'Conflict', message: 'CI is temporarily unavailable' }]);
    mockScenario.gap = false;
    mockScenario.properties = async () => { throw new Error('boom'); };
    expect((await send()).status).toBe(500);
    expect([...observed].map(String).sort()).toEqual(declared('/cis/{id}/stored-properties', 'get'));
    expect(operation('/cis/{id}/stored-properties', 'get').description).toMatch(/Admin role only/);
  });

  it('is admin only: unauthenticated is 401, an operator, a viewer and an org-less admin are each 403 and never reach the read; admin passes the gate', async () => {
    const getProperties = jest.fn(async () => ({ name: 'ci' }));
    mockScenario.properties = getProperties;
    expect(await Promise.all([null, 'operator', 'viewer', 'noOrg'].map(user => storedProperties(user).then(res => res.status)))).toEqual([401, 403, 403, 403]);
    expect(getProperties).not.toHaveBeenCalled();
    const admin = await storedProperties('admin');
    expect([admin.status, admin.body]).toEqual([200, { success: true, data: { id: 'ci-1', properties: enc({ name: 'ci' }) } }]);
    expect(getProperties).toHaveBeenCalledTimes(1);
  });
});

describe('estate feeds and dashboard health', () => {
  const invoke = async (handler: (req: unknown, res: unknown) => Promise<void>) => {
    const sent: { status?: number; body?: unknown } = {};
    const res = { status: (status: number) => { sent.status = status; return res; }, json: (body: unknown) => { sent.body = body; } };
    await handler({ query: {}, user: { _organizationId: ORG } }, res);
    return sent;
  };
  const feeds: Array<[string, (req: unknown, res: unknown) => Promise<void>]> = [
    ['/business-services/availability', (req, res) => new BusinessServiceController().getServiceAvailability(req as Request, res as Response)],
    ['/itil/metrics/open-incidents', (req, res) => new ITILController().getOpenIncidentRibbon(req as Request, res as Response)],
  ];

  it.each(feeds)('%s: a statement timeout is the 503 body whose cause the spec declares', async (path, handler) => {
    expect(await invoke(handler)).toEqual({ status: 503, body: ESTATE_FEED_LIMIT_RESPONSE });
    expect(operation(path, 'get').responses['503']!.description).toContain(ESTATE_FEED_LIMIT_RESPONSE.error);
  });

  it('lists a failed or timed out incident read among the causes of a null health_score and ci_health, as the service behaves', async () => {
    const failing = async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
    const kpis = await readEstateKpis({ run: failing } as never, { query: failing } as never, ORG, 10);
    expect([kpis.health_score, kpis.ci_health, kpis.unavailable]).toEqual([null, null, expect.arrayContaining(['health_score'])]);
    const schema = spec.paths['/analytics/dashboard']!['get']!.responses['200']!.content!['application/json'] as unknown as {
      schema: { properties: Record<string, { description: string }> } };
    const { health_score, ci_health } = schema.schema.properties;
    expect(health_score!.description).toMatch(/failed or timed out/);
    expect(ci_health!.description).toMatch(/failed or timed out/);
  });
});
